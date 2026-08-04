/*
 * ASSET-SYNC.JS — Kiosk-side template sync module
 * ─────────────────────────────────────────────────────────────────────────────
 * On every boot, this module:
 *   1. Asks the unified local server for the latest templates list
 *      (GET https://localhost:3000/sync/templates).
 *   2. Compares each template's version number against whatever is stored
 *      in localStorage (the local version cache).
 *   3. Downloads any new or updated asset files via the server's asset proxy
 *      (GET https://localhost:3000/sync/asset?path=…), which fetches from
 *      Supabase Storage and streams back — so the kiosk only ever talks to
 *      localhost, not directly to Supabase.
 *   4. Stores downloaded asset files as Object URLs (in-memory blob URLs).
 *      These are safe to use in <img src>, canvas.loadImage(), etc. for the
 *      duration of the session.
 *   5. Falls back to whatever is already cached in localStorage metadata
 *      (with the last-known asset Object URLs rebuilt from IndexedDB blobs)
 *      if the server is unreachable or Supabase is offline.
 *
 * After sync completes (online or from cache), `assetSync.getTemplates()`
 * returns the resolved template list with local `overlayUrl` / `thumbnailUrl`
 * properties pointing to blob: URLs — strip.js reads these instead of the
 * hardcoded assets/designs/ paths that were there before.
 *
 * WHY PERIODIC RE-SYNC (added — was boot-only before)?
 *   The Admin panel runs on studrio.cc; the kiosk's local server runs on
 *   localhost on the booth PC. These are different origins on different
 *   machines, so there is no way for the Admin panel to "push" a sync
 *   signal to a running kiosk — there's nothing on the Admin side that
 *   could reach the booth's localhost. Instead, the kiosk pulls on its own
 *   schedule: once at boot (as before), and now also every
 *   SYNC_POLL_INTERVAL_MS while the app stays open, so a booth left running
 *   for hours/days still picks up new or edited templates automatically,
 *   without needing a manual "sync" button anywhere or a reboot.
 *   Each poll is cheap: it only re-downloads assets whose version number
 *   increased since the last sync (see syncAsset()).
 *
 * WHY IndexedDB for blob storage?
 *   localStorage can only hold strings. Storing a 500 KB PNG as a base64
 *   string is wasteful and slow. IndexedDB supports binary blobs natively
 *   and has a much higher storage quota.
 *
 * WHY version numbers (not ETags or timestamps)?
 *   Simple integer version bumps are easy to manage in the admin panel and
 *   unambiguous to compare. The admin increments a template's version when
 *   uploading a new frame or thumbnail file; the kiosk re-downloads only
 *   those assets — not the whole catalog.
 *
 * NOTE on assets/cache/ directory:
 *   The spec says "inside the kiosk project folder (e.g. assets/cache/ —
 *   wiped on git pull, must re-sync)". In a browser context we can't write
 *   to the filesystem — we use IndexedDB blobs instead, which survive page
 *   reloads and are cleared by clearing site data (equivalent to git pull
 *   wiping the folder). The semantics are identical.
 */

const assetSync = (() => {
  const SERVER_BASE        = "https://localhost:3000";
  const TEMPLATES_ENDPOINT = `${SERVER_BASE}/sync/templates`;
  const ASSET_ENDPOINT     = `${SERVER_BASE}/sync/asset`;

  const IDB_DB_NAME        = "studrio-asset-cache";
  const IDB_DB_VERSION     = 1;
  const IDB_STORE_BLOBS    = "blobs";    // key = storage path, value = Blob
  const LS_KEY_META        = "studrio_template_meta"; // JSON array of template metadata

  // How often to re-check Supabase for new/updated templates while the
  // kiosk stays open, in addition to the sync that runs once at boot.
  const SYNC_POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

  // In-memory map of storage path → Object URL (built once after sync)
  const _objectUrls = new Map();

  // Resolved template list (populated by sync or cache load)
  let _templates = [];
  let _syncStatus = "idle"; // "idle" | "syncing" | "online" | "offline" | "error"
  let _lastSyncAt = null;   // Date of the last successful sync attempt (online or offline fallback)
  let _syncing = false;     // guards against overlapping sync() calls
  let _pollTimer = null;

  // ── IndexedDB ───────────────────────────────────────────────────────────────

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
      const tx = db.transaction(IDB_STORE_BLOBS, "readwrite");
      const store = tx.objectStore(IDB_STORE_BLOBS);
      const req = store.put(blob, key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_BLOBS, "readonly");
      const store = tx.objectStore(IDB_STORE_BLOBS);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  }

  async function idbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_BLOBS, "readwrite");
      const store = tx.objectStore(IDB_STORE_BLOBS);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async function idbGetAllKeys() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_BLOBS, "readonly");
      const store = tx.objectStore(IDB_STORE_BLOBS);
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  // ── Metadata cache (localStorage) ──────────────────────────────────────────

  function loadCachedMeta() {
    try { return JSON.parse(localStorage.getItem(LS_KEY_META) || "[]"); }
    catch (e) { return []; }
  }

  function saveCachedMeta(templates) {
    try { localStorage.setItem(LS_KEY_META, JSON.stringify(templates)); }
    catch (e) { console.warn("[assetSync] Could not save template metadata to localStorage:", e); }
  }

  // ── Object URL helpers ──────────────────────────────────────────────────────

  function makeObjectUrl(blob, storagePath) {
    // Revoke any existing URL for this path before creating a new one
    if (_objectUrls.has(storagePath)) {
      URL.revokeObjectURL(_objectUrls.get(storagePath));
    }
    const url = URL.createObjectURL(blob);
    _objectUrls.set(storagePath, url);
    return url;
  }

  function getObjectUrl(storagePath) {
    return _objectUrls.get(storagePath) || null;
  }

  // ── Asset download ──────────────────────────────────────────────────────────

  async function downloadAsset(storagePath) {
    const url = `${ASSET_ENDPOINT}?path=${encodeURIComponent(storagePath)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Asset download failed: HTTP ${res.status} for ${storagePath}`);
    const blob = await res.blob();
    await idbPut(storagePath, blob);
    return makeObjectUrl(blob, storagePath);
  }

  // ── Per-template sync ───────────────────────────────────────────────────────

  // Returns the cached version number for a given storage path, or -1 if not cached.
  function getCachedVersion(storagePath, cachedMeta) {
    for (const t of cachedMeta) {
      if (t.overlay_path_2x6 === storagePath && t._overlay_version_2x6 !== undefined) return t._overlay_version_2x6;
      if (t.overlay_path_4x6 === storagePath && t._overlay_version_4x6 !== undefined) return t._overlay_version_4x6;
      if (t.thumbnail_path    === storagePath && t._thumbnail_version    !== undefined) return t._thumbnail_version;
    }
    return -1;
  }

  /*
   * Syncs a single asset file. Downloads from Supabase (via server proxy) if:
   *   a) it is not in IndexedDB at all, OR
   *   b) the server version > the locally cached version.
   * Otherwise rebuilds the Object URL from the existing IndexedDB blob.
   */
  async function syncAsset(storagePath, serverVersion, cachedMeta) {
    if (!storagePath) return null;

    const cachedVersion = getCachedVersion(storagePath, cachedMeta);
    const existingBlob  = await idbGet(storagePath);

    if (existingBlob && cachedVersion >= serverVersion) {
      // Already up to date — rebuild Object URL from cached blob
      return makeObjectUrl(existingBlob, storagePath);
    }

    // Needs download (new or updated)
    try {
      console.log(`[assetSync] Downloading: ${storagePath} (v${serverVersion})`);
      return await downloadAsset(storagePath);
    } catch (e) {
      console.warn(`[assetSync] Could not download ${storagePath}:`, e.message);
      // Fall back to whatever is cached, even if stale
      if (existingBlob) return makeObjectUrl(existingBlob, storagePath);
      return null;
    }
  }

  // ── Offline: load from IDB cache ────────────────────────────────────────────

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
        overlayUrl2x6:  overlayBlob2x6 ? makeObjectUrl(overlayBlob2x6, t.overlay_path_2x6) : null,
        overlayUrl4x6:  overlayBlob4x6 ? makeObjectUrl(overlayBlob4x6, t.overlay_path_4x6) : null,
        thumbnailUrl:   thumbBlob       ? makeObjectUrl(thumbBlob,       t.thumbnail_path)   : null
      });
    }
    return resolved.filter((t) => t.enabled !== false);
  }

  // ── Prune deleted templates from IDB ────────────────────────────────────────

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
      console.log("[assetSync] Sync already in progress — skipping this trigger.");
      return;
    }
    _syncing = true;
    _syncStatus = "syncing";

    try {
      // Try to reach the local server (which proxies Supabase)
      let serverTemplates;
      try {
        const res = await fetch(TEMPLATES_ENDPOINT);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        serverTemplates = await res.json();
      } catch (e) {
        console.warn("[assetSync] Could not reach server:", e.message, "— falling back to cache.");
        _syncStatus = "offline";
        _templates = await loadFromCache();
        _lastSyncAt = new Date();
        return;
      }

      const cachedMeta = loadCachedMeta();
      const resolved   = [];

      await pruneDeletedAssets(serverTemplates);

      for (const template of serverTemplates) {
        if (!template.enabled) continue; // skip disabled templates

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
          // Record the synced version per-asset in the metadata cache
          _overlay_version_2x6: template.version || 1,
          _overlay_version_4x6: template.version || 1,
          _thumbnail_version:   template.version || 1
        });
      }

      // Save updated metadata for offline use
      saveCachedMeta(resolved);
      _templates  = resolved;
      _syncStatus = "online";
      _lastSyncAt = new Date();
      console.log(`[assetSync] Sync complete — ${resolved.length} templates ready.`);
    } finally {
      _syncing = false;
    }
  }

  // ── Periodic polling ─────────────────────────────────────────────────────────

  function startPolling() {
    if (_pollTimer) return; // already running
    _pollTimer = setInterval(() => {
      console.log("[assetSync] Periodic re-sync check…");
      sync().catch((e) => console.error("[assetSync] Periodic sync error:", e));
    }, SYNC_POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  return {
    /*
     * init() — call once during boot (before the kiosk reaches the design
     * page). Returns a Promise that resolves when the first sync is done
     * (or falls back to cache). Safe to await in boot.js.
     * Also starts periodic background re-syncing (see SYNC_POLL_INTERVAL_MS)
     * so newly uploaded or edited templates in the admin panel show up on
     * this kiosk automatically — no reboot and no manual sync step needed.
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
     * getTemplates() — returns the resolved template list.
     * Each entry has all the original Supabase columns plus:
     *   overlayUrl2x6  — blob: URL for the 2x6 overlay PNG (or null)
     *   overlayUrl4x6  — blob: URL for the 4x6 overlay PNG (or null)
     *   thumbnailUrl   — blob: URL for the swatch thumbnail PNG (or null)
     */
    getTemplates() {
      return _templates;
    },

    /*
     * status() — "idle" | "syncing" | "online" | "offline" | "error"
     * Useful for a boot screen or debug overlay to show "Downloading templates…"
     */
    status() {
      return _syncStatus;
    },

    /*
     * lastSyncAt() — Date of the last completed sync attempt, or null if
     * no sync has run yet. Useful for a small "last synced Xm ago" label.
     */
    lastSyncAt() {
      return _lastSyncAt;
    },

    /*
     * forceRefresh() — re-runs the sync immediately without waiting for the
     * next poll interval, and without a page reload. Exposed for debugging
     * from the browser console on the kiosk itself:
     *   assetSync.forceRefresh().then(() => location.reload())
     * (a full reload is only needed if strip.js has already read
     * getTemplates() and needs to re-render with the new list).
     */
    async forceRefresh() {
      await sync();
    },

    /*
     * stopPolling() — stops the periodic background re-sync. Not normally
     * needed; exposed in case a future settings screen wants to pause it.
     */
    stopPolling
  };
})();
