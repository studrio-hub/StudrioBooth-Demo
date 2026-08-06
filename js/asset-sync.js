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
      if (t.overlay_path_2x6 === storagePath && t._overlay_version_2x6 !== undefined) return t._overlay_version_2x6;
      if (t.overlay_path_4x6 === storagePath && t._overlay_version_4x6 !== undefined) return t._overlay_version_4x6;
      if (t.thumbnail_path    === storagePath && t._thumbnail_version    !== undefined) return t._thumbnail_version;
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
      const overlayBlob2x6 = t.overlay_path_2x6 ? await idbGet(t.overlay_path_2x6) : null;
      const overlayBlob4x6 = t.overlay_path_4x6 ? await idbGet(t.overlay_path_4x6) : null;
      const thumbBlob      = t.thumbnail_path    ? await idbGet(t.thumbnail_path)    : null;

      resolved.push({
        ...t,
        overlayUrl2x6: overlayBlob2x6 ? makeObjectUrl(overlayBlob2x6, t.overlay_path_2x6) : null,
        overlayUrl4x6: overlayBlob4x6 ? makeObjectUrl(overlayBlob4x6, t.overlay_path_4x6) : null,
        thumbnailUrl:  thumbBlob       ? makeObjectUrl(thumbBlob,       t.thumbnail_path)   : null
      });
    }
    return resolved.filter((t) => t.enabled !== false);
  }

  // ── Prune assets for deleted templates ─────────────────────────────────────

  async function pruneDeletedAssets(serverTemplates) {
    const activePaths = new Set();
    for (const t of serverTemplates) {
      if (t.overlay_path_2x6) activePaths.add(t.overlay_path_2x6);
      if (t.overlay_path_4x6) activePaths.add(t.overlay_path_4x6);
      if (t.thumbnail_path)   activePaths.add(t.thumbnail_path);
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

        const [overlayUrl2x6, overlayUrl4x6, thumbnailUrl] = await Promise.all([
          syncAsset(template.overlay_path_2x6, template.version || 1, cachedMeta),
          syncAsset(template.overlay_path_4x6, template.version || 1, cachedMeta),
          syncAsset(template.thumbnail_path,   template.version || 1, cachedMeta)
        ]);

        resolved.push({
          ...template,
          overlayUrl2x6,
          overlayUrl4x6,
          thumbnailUrl,
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

  // ── Public API ──────────────────────────────────────────────────────────────

  return {
    /*
     * init() — call once in boot.js before initDesigns().
     * Awaits the first sync (or offline cache load), then starts background polling.
     */
    async init() {
      try {
        await sync();
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
     * next poll. Call this after the admin uploads a new template and you
     * want the kiosk to pick it up instantly without a 3-minute wait.
     * Note: strip.js will need initDesigns() re-called + the design page
     * re-rendered to show the new templates — or just reload the kiosk page.
     */
    async forceRefresh() {
      await sync();
    },

    stopPolling
  };
})();
