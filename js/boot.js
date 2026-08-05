/*
 * BOOT.JS — Kiosk startup sequence.
 *
 * Run order (all awaited in sequence):
 *   1. assetSync.init() — fetch templates directly from Supabase, cache in IDB
 *   2. initDesigns()    — populate STRIP_DESIGNS from the synced template list
 *   3. authLock.init()  — show PIN/NFC lock screen
 *
 * Camera connect is intentionally NOT here yet — that moves to Electron IPC
 * in a future update. The camera setup page handles connect on its own for now.
 *
 * WHY assetSync.init() must complete before initDesigns():
 *   strip.js's initDesigns() reads assetSync.getTemplates(), which returns
 *   the in-memory array populated by sync(). If initDesigns() runs before
 *   sync() resolves, getTemplates() returns [] and the design picker shows
 *   "No templates available." every time.
 */

(async function boot() {

  /* ── 1. Sync templates directly from Supabase ────────────────────────────── */
  /*
   * assetSync.init() (see asset-sync.js):
   *   - Queries the `templates` table directly via the Supabase JS client
   *   - Downloads overlay PNGs from Supabase Storage as public URLs
   *   - Caches blobs in IndexedDB — only re-downloads assets whose version changed
   *   - Falls back to the IDB cache if Supabase is unreachable
   *   - Starts a background poll (every 3 min) to pick up new templates automatically
   *
   * No local server, no localhost, no WSL involved.
   * MUST complete before initDesigns() is called below.
   */
  try {
    await assetSync.init();
    console.log(`[boot] Template sync complete — ${assetSync.getTemplates().length} templates ready.`);
  } catch (e) {
    console.error("[boot] Unexpected error during template sync:", e);
  }

  /* ── 2. Populate STRIP_DESIGNS from the synced template list ─────────────── */
  /*
   * initDesigns() converts assetSync's resolved template records into the
   * shape strip.js expects (id, label, overlays with "2x6"/"4x6" blob: URLs).
   * MUST be called after assetSync.init() resolves — not before.
   */
  initDesigns();

  /* ── 3. Show the lock screen ─────────────────────────────────────────────── */
  /*
   * authLock.init() wires the PIN keypad and NFC polling, then shows page-lock.
   * After the staff authenticates, it calls goToPage("home").
   * Authentication is only required once at startup — not between guest sessions.
   */
  if (typeof authLock !== "undefined" && authLock.init) {
    authLock.init();
  } else {
    console.warn("[boot] authLock not found — skipping lock screen.");
    goToPage("home");
  }

})();
