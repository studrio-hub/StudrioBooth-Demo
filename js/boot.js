/*
 * BOOT.JS — startup sequence + authentication gate.
 *
 * Flow:
 *   1. Lock screen shown immediately (auth-lock.js).
 *   2. Camera connection attempt runs IN PARALLEL in the background.
 *   3. Staff authenticates (NFC tap or PIN).
 *   4. Kiosk goes straight to the Home page — no visible boot/loading
 *      screen. If the camera connected in time, its preview is already
 *      attached and Page 1's Next button is already enabled by the time
 *      the guest gets there. If not, a silent background retry keeps
 *      trying until it succeeds (guests never see a technical error).
 *
 * The camera init starts immediately so guests aren't waiting for it
 * after the operator unlocks. On a fast webcam this is typically done
 * before the PIN is even finished.
 */

const bootModule = (() => {
  // Camera connection result — resolved in background before auth completes
  let _cameraStatusPromise = null;

  const RETRY_MS = 5000; // background retry interval if camera isn't ready yet

  // ── Camera init (runs immediately, before auth) ───────────────────────────
  function _startCameraInBackground() {
    _cameraStatusPromise = (async () => {
      try {
        return await cameraController.connect();
      } catch (e) {
        return { connected: false };
      }
    })();
  }

  function _onCameraReady(status) {
    cameraController.attachPreview(setupEls.video, setupEls.img);
    setupEls.placeholder.hidden = false; // will hide once preview renders
    setupEls.nextBtn.disabled   = false;
    renderCameraStatus(status); // no-op shim in app.js
  }

  // Keeps retrying silently in the background until the camera connects.
  // No UI is ever shown for this — matches the kiosk-first "guests never
  // see technical dialogs" rule.
  function _retryUntilConnected() {
    const attempt = async () => {
      try {
        const status = await cameraController.connect();
        if (status && status.connected) {
          _onCameraReady(status);
          return; // stop retrying
        }
      } catch (e) {
        // ignore — will retry again below
      }
      setTimeout(attempt, RETRY_MS);
    };
    setTimeout(attempt, RETRY_MS);
  }

  // ── Runs once staff authenticates; camera may already be connecting ───────
  async function _afterUnlock() {
    const status = await _cameraStatusPromise;

    if (status && status.connected) {
      _onCameraReady(status);
    } else {
      console.warn("[boot] Camera not connected yet — retrying silently in background.");
      _retryUntilConnected();
    }

    goToPage("home");
  }

  // ── Public init ───────────────────────────────────────────────────────────
  function init() {
    // 1. Start camera connecting immediately (background)
    _startCameraInBackground();

    // 2. Show lock screen — proceeds straight to Home after staff authenticates
    authLock.lock(async () => {
      await _afterUnlock();
    });
  }

  return { init };
})();

// Kick everything off
bootModule.init();
