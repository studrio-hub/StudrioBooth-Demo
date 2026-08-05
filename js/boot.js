/*
 * BOOT.JS — Kiosk startup sequence.
 *
 * Run order (all awaited in sequence):
 *   1. assetSync.init()              — fetch templates from Supabase, cache in IDB
 *   2. initDesigns()                 — populate STRIP_DESIGNS from synced templates
 *   3. cameraController.connect()    — connect real DSLR or fall back to mock webcam
 *   4. cameraController.attachPreview() — wire the live preview to the Setup page
 *   5. authLock.init()               — show email+password lock screen
 *
 * WHY assetSync.init() must complete before initDesigns():
 *   strip.js's initDesigns() reads assetSync.getTemplates(), which returns
 *   the in-memory array populated by sync(). If initDesigns() runs before
 *   sync() resolves, getTemplates() returns [] and the design picker shows
 *   "No templates available." every time.
 *
 * WHY camera connects before the lock screen:
 *   getUserMedia() triggers a browser permission prompt the first time it
 *   runs. Connecting here — while the lock screen is visible — means the
 *   prompt appears before any guest interaction, and the live preview is
 *   already streaming when staff navigate to the Setup page. The real DSLR
 *   bridge is tried first; if the camera agent isn't reachable it falls
 *   back to the device webcam automatically (see camera-controller.js).
 */

(async function boot() {

  /* ── 1. Sync templates directly from Supabase ─────────────────────────────
   *
   * assetSync.init() (see asset-sync.js):
   *   - Queries the `templates` table directly via the Supabase JS client
   *   - Downloads overlay PNGs from Supabase Storage as public URLs
   *   - Caches blobs in IndexedDB — only re-downloads assets whose version changed
   *   - Falls back to the IDB cache if Supabase is unreachable
   *   - Starts a background poll (every 3 min) for automatic template updates
   *
   * MUST complete before initDesigns() is called below.
   */
  try {
    await assetSync.init();
    console.log(`[boot] Template sync complete — ${assetSync.getTemplates().length} templates ready.`);
  } catch (e) {
    console.error("[boot] Unexpected error during template sync:", e);
  }

  /* ── 2. Populate STRIP_DESIGNS from the synced template list ──────────────
   *
   * initDesigns() converts assetSync's resolved template records into the
   * shape strip.js expects (id, label, overlays with "2x6"/"4x6" blob: URLs).
   * MUST be called after assetSync.init() resolves — not before.
   */
  if (typeof stripModule !== "undefined") {
    stripModule.initDesigns();
  }

  /* ── 3. Connect camera ─────────────────────────────────────────────────────
   *
   * cameraController.connect() tries the real DSLR bridge first (localhost:3000
   * / gphoto2 agent). If it's unreachable, falls back to the mock bridge which
   * uses the device webcam via getUserMedia — no DSLR required for testing.
   *
   * Runs before the lock screen so:
   *   a) Any browser permission prompt for webcam access appears early, before
   *      guests are in front of the kiosk.
   *   b) The preview is already streaming when staff navigate to Setup — no
   *      perceptible delay between page navigation and seeing the live feed.
   */
  async function tryConnectCamera() {
    try {
      const cameraStatus = await cameraController.connect();
      console.log(`[boot] Camera connected — mode: ${cameraController.mode}, model: ${cameraStatus.model}`);
      
      // If we're in Electron and it's a real camera, monitor for disconnect
      if (window.electronAPI && cameraController.mode === "real") {
        // Simple polling for reconnection if lost
        setInterval(async () => {
          if (!cameraController.status.connected) {
            console.log("[boot] Attempting auto-reconnect...");
            await cameraController.connect().catch(() => {});
          }
        }, 5000);
      }
      return true;
    } catch (e) {
      console.error("[boot] Camera connect failed:", e);
      return false;
    }
  }

  await tryConnectCamera();

  /* ── 4. Attach live preview to the Setup page elements ────────────────────
   *
   * setupEls.video and setupEls.img are defined in app.js (the <video> and
   * <img> elements on the Setup page). Attaching here means the preview
   * element is already receiving frames before the lock screen clears.
   *
   * After connect(), cameraController.mode is either "real" (DSLR via agent)
   * or "mock" (webcam). attachPreview() routes to the right bridge.
   */
  if (cameraController.mode) {
    try {
      cameraController.attachPreview(setupEls.video, setupEls.img);
      // Enable the NEXT button on the Setup page now that the camera is live.
      const nextBtn = document.getElementById("btnNextFromSetup");
      if (nextBtn) nextBtn.disabled = false;
      console.log(`[boot] Preview attached — ${cameraController.mode === "mock" ? "webcam (mock)" : "DSLR"} live.`);
    } catch (e) {
      console.error("[boot] Preview attach failed:", e);
    }
  }

  /* ── 5. Show the lock screen ───────────────────────────────────────────────
   *
   * authLock.init() shows the email+password sign-in form on page-lock.
   * After the staff authenticates via Supabase Auth, it calls goToPage("home").
   * Authentication is only required once at startup — not between guest sessions.
   */
  if (typeof authLock !== "undefined") {
    authLock.init();
  } else {
    console.warn("[boot] authLock not found — skipping lock screen.");
    goToPage("home");
  }

})();
