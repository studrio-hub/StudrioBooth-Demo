/*
 * BOOT.JS — Page 0 startup sequence + authentication gate.
 *
 * Flow:
 *   1. Lock screen shown immediately (auth-lock.js).
 *   2. Camera connection attempt runs IN PARALLEL in the background.
 *   3. Staff authenticates (NFC tap or PIN).
 *   4. Boot page shown — replays camera status visually.
 *      If camera already connected: steps animate quickly and we advance.
 *      If camera still connecting: we wait for it.
 *   5. goToPage("setup") — staff hands off to guest.
 *
 * The camera init starts immediately so guests aren't waiting for it
 * after the operator unlocks. On a fast webcam this is typically done
 * before the PIN is even finished.
 */

const bootModule = (() => {
  const steps = [
    "Starting photobooth system",
    "Connecting to DSLR camera",
    "Checking camera connection",
    "Preparing live preview",
    "Loading camera settings",
    "Camera ready"
  ];

  // Camera connection result — resolved in background before auth completes
  let _cameraStatusPromise = null;
  let _cameraStatus        = null; // set once resolved

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const els = {
    list:       () => document.getElementById("bootStatusList"),
    spinner:    () => document.getElementById("bootSpinner"),
    error:      () => document.getElementById("bootError"),
    errorText:  () => document.getElementById("bootErrorText"),
    retryBtn:   () => document.getElementById("btnBootRetry"),
    restartBtn: () => document.getElementById("btnBootRestart")
  };

  // ── Step rendering ────────────────────────────────────────────────────────
  function renderSteps() {
    els.list().innerHTML = steps
      .map((label, i) => `
        <div class="boot-status-item" id="boot-step-${i}">
          <span class="boot-status-icon"></span>
          <span>${label}</span>
        </div>
      `).join("");
  }

  function setStepState(index, state) {
    const el = document.getElementById(`boot-step-${index}`);
    if (!el) return;
    el.classList.remove("active", "done");
    if (state) el.classList.add(state);
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Camera init (runs immediately, before auth) ───────────────────────────
  function _startCameraInBackground() {
    _cameraStatusPromise = (async () => {
      try {
        const status = await cameraController.connect();
        _cameraStatus = status;
        return status;
      } catch (e) {
        _cameraStatus = { connected: false };
        return _cameraStatus;
      }
    })();
  }

  // ── Boot sequence (shown after auth, camera already connecting/done) ──────
  async function _runBootSequence() {
    renderSteps();
    els.error().hidden  = true;
    els.spinner().hidden = false;

    // Show the boot page
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    document.querySelector('.page[data-page="boot"]').classList.add("active");

    // Steps 0–1: cosmetic pacing
    setStepState(0, "active");
    await wait(300);
    setStepState(0, "done");
    setStepState(1, "active");

    // Wait for camera (may already be done)
    const status = await _cameraStatusPromise;

    setStepState(1, "done");
    setStepState(2, "active");
    await wait(250);

    if (!status || !status.connected) {
      setStepState(2, null);
      els.spinner().hidden = true;
      els.error().hidden   = false;
      els.errorText().textContent = "Camera not detected";
      return; // stays on boot error — Retry button re-runs sequence
    }

    setStepState(2, "done");
    setStepState(3, "active");
    cameraController.attachPreview(setupEls.video, setupEls.img);
    await wait(250);
    setStepState(3, "done");

    setStepState(4, "active");
    renderCameraStatus(status); // no-op shim in app.js
    setupEls.placeholder.hidden = false; // will hide once preview renders
    setupEls.nextBtn.disabled   = false;
    await wait(250);
    setStepState(4, "done");

    setStepState(5, "done");
    els.spinner().hidden = true;
    await wait(350);

    goToPage("setup");
  }

  // ── Retry (camera failed) ─────────────────────────────────────────────────
  async function _retry() {
    // Re-attempt camera connection
    _cameraStatus        = null;
    _cameraStatusPromise = null;
    _startCameraInBackground();
    await _runBootSequence();
  }

  // ── Public init ───────────────────────────────────────────────────────────
  function init() {
    // Wire retry buttons
    document.getElementById("btnBootRetry").addEventListener("click", _retry);
    document.getElementById("btnBootRestart").addEventListener("click", _retry);

    // 1. Start camera connecting immediately (background)
    _startCameraInBackground();

    // 2. Show lock screen — boot sequence runs after staff authenticates
    authLock.lock(async () => {
      await _runBootSequence();
    });
  }

  return { init };
})();

// Kick everything off
bootModule.init();
