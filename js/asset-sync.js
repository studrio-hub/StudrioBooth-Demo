/*
 * ASSET-SYNC.JS — Kiosk-side template sync module
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches templates DIRECTLY from Supabase — no local server involved.
 *
 * On every boot (and every 3 minutes while the kiosk stays open) this module:
 *   1. Queries the `templates` table via the Supabase JS client.
 *   2. Compares each template's version number against the locally cached version.
 *   3. Downloads any new or updated asset files directly from Supabase Storage
 *      as public URLs — no proxy, no localhost, no server required.
 *   4. Stores downloaded blobs in IndexedDB and exposes them as blob: Object URLs.
 *   5. Falls back to the IndexedDB cache if Supabase is unreachable.
 *
 * After sync, assetSync.getTemplates() returns the resolved template list with
 * local overlayUrl2x6 / overlayUrl4x6 / thumbnailUrl blob: URLs that
 * strip.js uses for canvas compositing and the design picker.
 *
 * DEPENDS ON: cloud-storage.js (must load first — provides getSupabaseClient()
 * and CLOUD_CONFIG with the bucket name).
 *
 * NO LOCAL SERVER DEPENDENCY — templates and assets come directly from Supabase.
 */

const assetSync = (() => {

  const IDB_DB_NAME     = "studrio-asset-cache";
  const IDB_DB_VERSION  = 1;
  const IDB_STORE_BLOBS = "blobs";           // key = storage path, value = Blob
  const LS_KEY_META     = "studrio_template_meta"; // JSON array of cached template metadata

  // Re-check Supabase for template changes every 3 minutes while the kiosk
  // stays open — so new templates uploaded in the admin panel appear without
  // needing a reboot or a manual sync step.
  const SYNC_POLL_INTERVAL_MS = 3 * 60 * 1000;

  // In-memory map of storage path → blob: Object URL
  const _objectUrls = new Map();

  let _templates  = [];
  let _syncStatus = "idle";  // "idle" | "syncing" | "online" | "offline" | "error"
  let _lastSyncAt = null;
  let _syncing    = false;
  let _pollTimer  = null;

  // ── IndexedDB helpers ───────────────────────────────────────────────────────

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE_BLOBS)) {
          db.createObjectStore(IDB_STORE_BLOBS);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async function idbPut(key, blob) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE_BLOBS, "readwrite");
      const store = tx.objectStore(IDB_STORE_BLOBS);
      const req   = store.put(blob, key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE_BLOBS, "readonly");
      const store = tx.objectStore(IDB_STORE_BLOBS);
      const req   = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  }

  async function idbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE_BLOBS, "readwrite");
      const store = tx.objectStore(IDB_STORE_BLOBS);
      const req   = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async function idbGetAllKeys() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE_BLOBS, "readonly");
      const store = tx.objectStore(IDB_STORE_BLOBS);
      const req   = store.getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  // ── localStorage metadata cache ─────────────────────────────────────────────

  function loadCachedMeta() {
    try { return JSON.parse(localStorage.getItem(LS_KEY_META) || "[]"); }
    catch (e) { return []; }
  }

  function saveCachedMeta(templates) {
    try { localStorage.setItem(LS_KEY_META, JSON.stringify(templates)); }
    catch (e) { console.warn("[assetSync] Could not save metadata to localStorage:", e); }
  }

  // ── Object URL helpers ──────────────────────────────────────────────────────

  function makeObjectUrl(blob, storagePath) {
    if (_objectUrls.has(storagePath)) {
      URL.revokeObjectURL(_objectUrls.get(storagePath));
    }
    const url = URL.createObjectURL(blob);
    _objectUrls.set(storagePath, url);
    return url;
  }

  // ── Supabase: fetch template list ───────────────────────────────────────────

  /*
   * Queries the `templates` table directly via the Supabase JS client.
   * Returns rows ordered by sort_order, then created_at.
   * No local server involved — this is a direct Supabase REST call.
   */
  async function fetchTemplatesFromSupabase() {
    const client = getSupabaseClient();
    if (!client) throw new Error("Supabase client not available.");

    const { data, error } = await client
      .from("templates")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at",  { ascending: true });

    if (error) throw new Error(`Supabase templates query failed: ${error.message}`);
    return data || [];
  }

  // ── Supabase: download a single asset blob ──────────────────────────────────

  /*
   * Downloads a template asset (overlay PNG or thumbnail) directly from
   * Supabase Storage using its public URL.
   *
   * The photobooth bucket is public, so we can fetch the public URL directly
   * without signing — same as how the admin panel displays thumbnails.
   * No local server proxy needed.
   */
  async function downloadAssetFromSupabase(storagePath) {
    const client = getSupabaseClient();
    if (!client) throw new Error("Supabase client not available.");

    // Get the public URL for this storage path
    const { data } = client.storage
      .from(CLOUD_CONFIG.bucketName)
      .getPublicUrl(storagePath);

    if (!data || !data.publicUrl) {
      throw new Error(`Could not resolve public URL for: ${storagePath}`);
    }

    // Fetch the blob directly from Supabase CDN
    const res = await fetch(data.publicUrl);
    if (!res.ok) throw new Error(`Asset fetch failed: HTTP ${res.status} for ${storagePath}`);

    const blob = await res.blob();
    await idbPut(storagePath, blob);
    return makeObjectUrl(blob, storagePath);
  }

  // ── Per-asset sync (version-aware, IDB-cached) ──────────────────────────────

  function getCachedVersion(storagePath, cachedMeta) {
    for (const t of cachedMeta) {
      if (t.overlay_path_2x6       === storagePath && t._overlay_version_2x6 !== undefined) return t._overlay_version_2x6;
      if (t.overlay_path_4x6       === storagePath && t._overlay_version_4x6 !== undefined) return t._overlay_version_4x6;
      if (t.thumbnail_path          === storagePath && t._thumbnail_version    !== undefined) return t._thumbnail_version;
      // New frame type overlay paths — all share the same version number
      if (t.overlay_path_long_duo  === storagePath) return t._overlay_version_2x6 || -1;
      if (t.overlay_path_long_mini === storagePath) return t._overlay_version_2x6 || -1;
      if (t.overlay_path_film_duo  === storagePath) return t._overlay_version_2x6 || -1;
      if (t.overlay_path_wide_mini === storagePath) return t._overlay_version_2x6 || -1;
    }
    return -1;
  }

  /*
   * Downloads an asset from Supabase only if:
   *   a) it is not in IndexedDB at all, OR
   *   b) the Supabase version > the locally cached version.
   * Otherwise rebuilds the Object URL from the existing IndexedDB blob.
   * This keeps sync fast — only changed assets are re-downloaded.
   */
  async function syncAsset(storagePath, serverVersion, cachedMeta) {
    if (!storagePath) return null;

    const cachedVersion = getCachedVersion(storagePath, cachedMeta);
    const existingBlob  = await idbGet(storagePath);

    if (existingBlob && cachedVersion >= serverVersion) {
      // Already up to date — use existing Object URL if we have one
      if (_objectUrls.has(storagePath)) return _objectUrls.get(storagePath);
      // Otherwise create it once
      return makeObjectUrl(existingBlob, storagePath);
    }

    // Needs download (new or updated)
    try {
      console.log(`[assetSync] Downloading from Supabase: ${storagePath} (v${serverVersion})`);
      return await downloadAssetFromSupabase(storagePath);
    } catch (e) {
      console.warn(`[assetSync] Could not download ${storagePath}:`, e.message);
      // Fall back to stale cached blob rather than showing nothing
      if (existingBlob) {
        if (_objectUrls.has(storagePath)) return _objectUrls.get(storagePath);
        return makeObjectUrl(existingBlob, storagePath);
      }
      return null;
    }
  }

  // ── Offline fallback: load from IDB ────────────────────────────────────────

  async function loadFromCache() {
    const cachedMeta = loadCachedMeta();
    if (!cachedMeta.length) {
      console.warn("[assetSync] No cached templates available.");
      return [];
    }
    console.log(`[assetSync] Offline — loading ${cachedMeta.length} templates from cache.`);
    const resolved = [];
    for (const t of cachedMeta) {
      const overlayBlob2x6                = t.overlay_path_2x6                ? await idbGet(t.overlay_path_2x6)                : null;
      const overlayBlob4x6                = t.overlay_path_4x6                ? await idbGet(t.overlay_path_4x6)                : null;
      const thumbBlob                     = t.thumbnail_path                   ? await idbGet(t.thumbnail_path)                   : null;
      const keychainOverlayBlob           = t.keychain_overlay_path            ? await idbGet(t.keychain_overlay_path)            : null;
      const overlayBlobLongDuo            = t.overlay_path_long_duo            ? await idbGet(t.overlay_path_long_duo)            : null;
      const overlayBlobLongMini           = t.overlay_path_long_mini           ? await idbGet(t.overlay_path_long_mini)           : null;
      const overlayBlobFilmDuo            = t.overlay_path_film_duo            ? await idbGet(t.overlay_path_film_duo)            : null;
      const overlayBlobWideMini           = t.overlay_path_wide_mini           ? await idbGet(t.overlay_path_wide_mini)           : null;
      // Strip preview overlays (new frame types, preview canvas only)
      const previewOverlayBlobLongDuo     = t.preview_overlay_path_long_duo    ? await idbGet(t.preview_overlay_path_long_duo)    : null;
      const previewOverlayBlobLongMini    = t.preview_overlay_path_long_mini   ? await idbGet(t.preview_overlay_path_long_mini)   : null;
      const previewOverlayBlobFilmDuo     = t.preview_overlay_path_film_duo    ? await idbGet(t.preview_overlay_path_film_duo)    : null;
      const previewOverlayBlobWideMini    = t.preview_overlay_path_wide_mini   ? await idbGet(t.preview_overlay_path_wide_mini)   : null;

      resolved.push({
        ...t,
        overlayUrl2x6:              overlayBlob2x6             ? makeObjectUrl(overlayBlob2x6,             t.overlay_path_2x6)               : null,
        overlayUrl4x6:              overlayBlob4x6             ? makeObjectUrl(overlayBlob4x6,             t.overlay_path_4x6)               : null,
        thumbnailUrl:               thumbBlob                  ? makeObjectUrl(thumbBlob,                  t.thumbnail_path)                  : null,
        keychainOverlayUrl:         keychainOverlayBlob        ? makeObjectUrl(keychainOverlayBlob,        t.keychain_overlay_path)           : null,
        overlayUrlLongDuo:          overlayBlobLongDuo         ? makeObjectUrl(overlayBlobLongDuo,         t.overlay_path_long_duo)           : null,
        overlayUrlLongMini:         overlayBlobLongMini        ? makeObjectUrl(overlayBlobLongMini,        t.overlay_path_long_mini)          : null,
        overlayUrlFilmDuo:          overlayBlobFilmDuo         ? makeObjectUrl(overlayBlobFilmDuo,         t.overlay_path_film_duo)           : null,
        overlayUrlWideMini:         overlayBlobWideMini        ? makeObjectUrl(overlayBlobWideMini,        t.overlay_path_wide_mini)          : null,
        // Strip preview overlay blob: URLs (null if not uploaded)
        previewOverlayUrlLongDuo:   previewOverlayBlobLongDuo  ? makeObjectUrl(previewOverlayBlobLongDuo,  t.preview_overlay_path_long_duo)  : null,
        previewOverlayUrlLongMini:  previewOverlayBlobLongMini ? makeObjectUrl(previewOverlayBlobLongMini, t.preview_overlay_path_long_mini) : null,
        previewOverlayUrlFilmDuo:   previewOverlayBlobFilmDuo  ? makeObjectUrl(previewOverlayBlobFilmDuo,  t.preview_overlay_path_film_duo)  : null,
        previewOverlayUrlWideMini:  previewOverlayBlobWideMini ? makeObjectUrl(previewOverlayBlobWideMini, t.preview_overlay_path_wide_mini) : null
      });
    }
    return resolved.filter((t) => t.enabled !== false);
  }

  // ── Prune assets for deleted templates ─────────────────────────────────────

  async function pruneDeletedAssets(serverTemplates) {
    const activePaths = new Set();
    for (const t of serverTemplates) {
      if (t.overlay_path_2x6)                activePaths.add(t.overlay_path_2x6);
      if (t.overlay_path_4x6)                activePaths.add(t.overlay_path_4x6);
      if (t.thumbnail_path)                  activePaths.add(t.thumbnail_path);
      if (t.keychain_overlay_path)           activePaths.add(t.keychain_overlay_path);
      if (t.overlay_path_long_duo)           activePaths.add(t.overlay_path_long_duo);
      if (t.overlay_path_long_mini)          activePaths.add(t.overlay_path_long_mini);
      if (t.overlay_path_film_duo)           activePaths.add(t.overlay_path_film_duo);
      if (t.overlay_path_wide_mini)          activePaths.add(t.overlay_path_wide_mini);
      if (t.preview_overlay_path_long_duo)   activePaths.add(t.preview_overlay_path_long_duo);
      if (t.preview_overlay_path_long_mini)  activePaths.add(t.preview_overlay_path_long_mini);
      if (t.preview_overlay_path_film_duo)   activePaths.add(t.preview_overlay_path_film_duo);
      if (t.preview_overlay_path_wide_mini)  activePaths.add(t.preview_overlay_path_wide_mini);
    }
    const allKeys = await idbGetAllKeys();
    for (const key of allKeys) {
      if (!activePaths.has(key)) {
        console.log(`[assetSync] Pruning deleted asset: ${key}`);
        await idbDelete(key);
        if (_objectUrls.has(key)) {
          URL.revokeObjectURL(_objectUrls.get(key));
          _objectUrls.delete(key);
        }
      }
    }
  }

  // ── Main sync ───────────────────────────────────────────────────────────────

  async function sync() {
    if (_syncing) {
      console.log("[assetSync] Sync already in progress — skipping.");
      return;
    }
    _syncing    = true;
    _syncStatus = "syncing";

    try {
      // Step 1: fetch the template list directly from Supabase
      let serverTemplates;
      try {
        serverTemplates = await fetchTemplatesFromSupabase();
        console.log(`[assetSync] Fetched ${serverTemplates.length} templates from Supabase.`);
      } catch (e) {
        console.warn("[assetSync] Supabase unreachable:", e.message, "— falling back to cache.");
        _syncStatus = "offline";
        _templates  = await loadFromCache();
        _lastSyncAt = new Date();
        return;
      }

      // Step 2: prune IDB of any assets that no longer exist in Supabase
      await pruneDeletedAssets(serverTemplates);

      // Step 3: for each enabled template, sync its assets (download only if changed)
      const cachedMeta = loadCachedMeta();
      const resolved   = [];

      for (const template of serverTemplates) {
        if (!template.enabled) continue;

        const [
          overlayUrl2x6,
          overlayUrl4x6,
          thumbnailUrl,
          keychainOverlayUrl,
          overlayUrlLongDuo,
          overlayUrlLongMini,
          overlayUrlFilmDuo,
          overlayUrlWideMini,
          // Strip preview overlays — sized for preview canvas, not full print
          previewOverlayUrlLongDuo,
          previewOverlayUrlLongMini,
          previewOverlayUrlFilmDuo,
          previewOverlayUrlWideMini
        ] = await Promise.all([
          syncAsset(template.overlay_path_2x6,       template.version || 1, cachedMeta),
          syncAsset(template.overlay_path_4x6,       template.version || 1, cachedMeta),
          syncAsset(template.thumbnail_path,          template.version || 1, cachedMeta),
          // Linked keychain overlay — optional (null when not set)
          template.keychain_overlay_path
            ? syncAsset(template.keychain_overlay_path, template.version || 1, cachedMeta)
            : Promise.resolve(null),
          // New frame type overlays — optional (null when not set)
          template.overlay_path_long_duo
            ? syncAsset(template.overlay_path_long_duo,  template.version || 1, cachedMeta)
            : Promise.resolve(null),
          template.overlay_path_long_mini
            ? syncAsset(template.overlay_path_long_mini, template.version || 1, cachedMeta)
            : Promise.resolve(null),
          template.overlay_path_film_duo
            ? syncAsset(template.overlay_path_film_duo,  template.version || 1, cachedMeta)
            : Promise.resolve(null),
          template.overlay_path_wide_mini
            ? syncAsset(template.overlay_path_wide_mini, template.version || 1, cachedMeta)
            : Promise.resolve(null),
          // Strip preview overlays (optional — null when not uploaded)
          template.preview_overlay_path_long_duo
            ? syncAsset(template.preview_overlay_path_long_duo,  template.version || 1, cachedMeta)
            : Promise.resolve(null),
          template.preview_overlay_path_long_mini
            ? syncAsset(template.preview_overlay_path_long_mini, template.version || 1, cachedMeta)
            : Promise.resolve(null),
          template.preview_overlay_path_film_duo
            ? syncAsset(template.preview_overlay_path_film_duo,  template.version || 1, cachedMeta)
            : Promise.resolve(null),
          template.preview_overlay_path_wide_mini
            ? syncAsset(template.preview_overlay_path_wide_mini, template.version || 1, cachedMeta)
            : Promise.resolve(null)
        ]);

        resolved.push({
          ...template,
          overlayUrl2x6,
          overlayUrl4x6,
          thumbnailUrl,
          // Resolved blob: URL for the linked keychain overlay (or null)
          keychainOverlayUrl,
          // Resolved blob: URLs for new frame type overlays (or null)
          overlayUrlLongDuo,
          overlayUrlLongMini,
          overlayUrlFilmDuo,
          overlayUrlWideMini,
          // Resolved blob: URLs for strip preview overlays (or null)
          previewOverlayUrlLongDuo,
          previewOverlayUrlLongMini,
          previewOverlayUrlFilmDuo,
          previewOverlayUrlWideMini,
          _overlay_version_2x6: template.version || 1,
          _overlay_version_4x6: template.version || 1,
          _thumbnail_version:   template.version || 1
        });
      }

      // Step 4: persist metadata for offline use, update in-memory list
      saveCachedMeta(resolved);
      _templates  = resolved;
      _syncStatus = "online";
      _lastSyncAt = new Date();
      console.log(`[assetSync] Sync complete — ${resolved.length} templates ready.`);

      // If stripModule is already loaded, notify it to refresh its designs
      // so the UI stays in sync with background asset updates.
      if (typeof stripModule !== "undefined" && typeof stripModule.initDesigns === "function") {
        stripModule.initDesigns();
      }

    } finally {
      _syncing = false;
    }
  }

  // ── Periodic background polling ─────────────────────────────────────────────

  function startPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(() => {
      console.log("[assetSync] Periodic re-sync check…");
      sync().catch((e) => console.error("[assetSync] Periodic sync error:", e));
    }, SYNC_POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  // ── Filter sync from Supabase Storage ──────────────────────────────────────

  const FILTERS_CLOUD_PATH = "filters/filters.json";
  const FILTERS_LS_KEY     = "studrio_filters";
  let _filters = [];

  /*
   * _mergeFilters — merges cloud and local filter arrays by id.
   * Cloud entries are the authoritative source; local entries for the same id
   * are overwritten by cloud (cloud is the admin-published source of truth).
   * Entries that only exist locally (not yet pushed to cloud) are preserved.
   * This prevents Sync from losing filters that were just uploaded but whose
   * cloud write hasn't propagated to the CDN cache yet.
   */
  function _mergeFilters(cloudFilters, localFilters) {
    const merged = new Map();
    // Local first (preserves any filters not yet in cloud)
    (localFilters || []).forEach((f) => { if (f && f.id) merged.set(String(f.id), f); });
    // Cloud overwrites local (cloud is the admin-published truth)
    (cloudFilters || []).forEach((f) => { if (f && f.id) merged.set(String(f.id), f); });
    return Array.from(merged.values());
  }

  async function syncFilters() {
    let cloudFilters = null;
    try {
      const client = getSupabaseClient();
      if (!client) throw new Error("No Supabase client");
      const { data } = client.storage
        .from(CLOUD_CONFIG.bucketName)
        .getPublicUrl(FILTERS_CLOUD_PATH);
      const res = await fetch(`${data.publicUrl}?t=${Date.now()}`);
      if (!res.ok) {
        if (res.status === 404) {
          // No filters.json yet — use local cache as-is
          try { _filters = JSON.parse(localStorage.getItem(FILTERS_LS_KEY) || "[]"); } catch (e) { _filters = []; }
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      cloudFilters = await res.json();
      if (!Array.isArray(cloudFilters)) cloudFilters = [];
    } catch (e) {
      console.warn("[assetSync] Could not load filters from Supabase:", e.message || e);
      // Network error — keep whatever we have locally
      try { _filters = JSON.parse(localStorage.getItem(FILTERS_LS_KEY) || "[]"); } catch (ex) { _filters = []; }
      return;
    }

    // Merge cloud with local cache so recently uploaded filters aren't lost
    // if the CDN hasn't propagated the latest filters.json yet.
    let localFilters = [];
    try { localFilters = JSON.parse(localStorage.getItem(FILTERS_LS_KEY) || "[]"); } catch (e) {}

    _filters = _mergeFilters(cloudFilters, localFilters);

    // ── Download XMP/filter asset files and cache them in IDB ──────────────
    // Each filter entry may carry a `filePath` (Supabase Storage path to the
    // .xmp file) and a `version` number.  We download the file once and store
    // it in IDB under the path key; on subsequent boots the file is served
    // from the local cache without touching the network.
    // After loading, `fileData` is set to the base64-encoded XMP text so the
    // rest of the app (cameraFilterManager) can use it without another fetch.
    for (const filter of _filters) {
      if (!filter.filePath) continue;   // no storage path — skip download

      const storagePath  = filter.filePath;
      const serverVer    = filter.version || 1;
      // Check IDB for a cached copy
      const cachedBlob   = await idbGet(storagePath);
      // Determine if we already have the right version in IDB
      // We track filter versions in localStorage alongside template metadata.
      let cachedVer = -1;
      try {
        const cachedFilterMeta = JSON.parse(localStorage.getItem(FILTERS_LS_KEY) || "[]");
        const cachedEntry = cachedFilterMeta.find(f => f.filePath === storagePath);
        if (cachedEntry) cachedVer = cachedEntry._localVersion || -1;
      } catch (_) {}

      let xmpText = null;
      if (cachedBlob && cachedVer >= serverVer) {
        // Use the cached file — no network call
        xmpText = await cachedBlob.text().catch(() => null);
        console.log(`[assetSync] Filter ${filter.name}: using local cache (v${serverVer}).`);
      } else {
        // Download from Supabase Storage
        try {
          const client = getSupabaseClient();
          const { data: urlData } = client.storage
            .from(CLOUD_CONFIG.bucketName)
            .getPublicUrl(storagePath);
          const fileRes = await fetch(urlData.publicUrl);
          if (fileRes.ok) {
            const blob = await fileRes.blob();
            xmpText = await blob.text();
            // Store blob in IDB for future offline use
            await idbPut(storagePath, blob);
            console.log(`[assetSync] Filter ${filter.name}: downloaded and cached (v${serverVer}).`);
          }
        } catch (dlErr) {
          console.warn(`[assetSync] Could not download filter ${filter.name}:`, dlErr.message || dlErr);
          // Fall back to stale cached blob
          if (cachedBlob) {
            xmpText = await cachedBlob.text().catch(() => null);
          }
        }
      }

      if (xmpText) {
        // Store base64 of the XMP text so cameraFilterManager can parse it
        try { filter.fileData = btoa(unescape(encodeURIComponent(xmpText))); } catch (_) {}
        // Track the locally cached version
        filter._localVersion = serverVer;
      }
    }
    // ── End filter asset download ─────────────────────────────────────────

    // Persist the merged result (including _localVersion) locally for offline use
    try { localStorage.setItem(FILTERS_LS_KEY, JSON.stringify(_filters)); } catch (e) {}
    console.log(`[assetSync] Filters synced — ${cloudFilters.length} from cloud, ${_filters.length} after merge.`);

    // Notify any listening modules (e.g. cameraFilterManager, strip.js filter picker)
    document.dispatchEvent(new CustomEvent("studrio:filtersUpdated", { detail: { filters: _filters } }));
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  return {
    /*
     * init() — call once in boot.js before initDesigns().
     * Awaits the first sync (or offline cache load), then starts background polling.
     */
    async init() {
      try {
        await sync();
        await syncFilters();
      } catch (e) {
        console.error("[assetSync] Unexpected sync error:", e);
        _syncStatus = "error";
        _templates  = await loadFromCache().catch(() => []);
      }
      startPolling();
    },

    /*
     * getTemplates() — returns the resolved template list with blob: URLs.
     * Each entry has the original Supabase columns plus:
     *   overlayUrl2x6  — blob: URL for the 2×6 overlay PNG (or null)
     *   overlayUrl4x6  — blob: URL for the 4×6 overlay PNG (or null)
     *   thumbnailUrl   — blob: URL for the swatch thumbnail (or null)
     */
    getTemplates() {
      return _templates;
    },

    /*
     * getFilters() — returns the current filter list synced from Supabase.
     * Each entry: { id, name, fileData (base64 LUT), format, opacity }
     */
    getFilters() {
      return _filters;
    },

    /* "idle" | "syncing" | "online" | "offline" | "error" */
    status() {
      return _syncStatus;
    },

    /* Date of the last completed sync, or null. */
    lastSyncAt() {
      return _lastSyncAt;
    },

    /*
     * forceRefresh() — re-runs sync immediately without waiting for the
     * next poll. Call this after the admin uploads a new template or filter
     * and you want the kiosk to pick it up instantly without a 3-minute wait.
     * Note: strip.js will need initDesigns() re-called + the design page
     * re-rendered to show the new templates — or just reload the kiosk page.
     */
    async forceRefresh() {
      await sync();
      await syncFilters();
    },

    stopPolling
  };
})();
