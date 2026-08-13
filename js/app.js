/*
 * APP.JS — global session state + page navigation + wiring for
 * Page 1 (setup) and Page 2 (frame/quantity).
 *
 * Kiosk lives at /kiosk/ — all asset paths are relative to that folder.
 */

const sessionState = {
  id: Date.now().toString(36),
  frameType: null,   // "2x6" | "4x6"
  quantity: 1,
  shots: [],
  selectedShots: [],
  design: null,
  galleryUrl: null,
  galleryUrlPromise: null,
  uploadPromise: null,

  // ── QR Ticket fields (populated after successful QR scan) ──
  ticketId:       null,   // e.g. "T-LQ0ABC-XY12"
  ticketNumber:   null,   // queue number (integer)
  ticketLine:     null,   // queue line name
  ticketCopies:   null,   // number of copies from ticket (overrides qty selector)
  ticketFrame:    null,   // frame_addon quantity
  ticketKeychain: null    // keychain_addon quantity
};

/* ---------------- Navigation ---------------- */
function goToPage(pageName) {
  // "home" redirects to the QR Ticket page (new Page 1).
  // "frame" remains the Frame Selection page (now Page 2).
  if (pageName === "home") pageName = "ticket";

  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  const target = document.querySelector(`.page[data-page="${pageName}"]`);
  if (target) target.classList.add("active");

  // Keep the kiosk timer data attribute in sync for CSS targeting
  const timer = document.getElementById("kioskTimer");
  if (timer) timer.dataset.activePage = pageName;
  const progress = document.getElementById("kiosk-progress");
  if (progress) progress.dataset.activePage = pageName;

  // When arriving at the ticket page, refocus the hidden QR input
  if (pageName === "ticket" && typeof kioskQrScanner !== "undefined") {
    kioskQrScanner.focus();
  }

  // ── Audio: update BGM zone whenever the page changes ──────────────────
  if (typeof audioManager !== "undefined") {
    audioManager.onPageChange(pageName);
  }
}

/* ---------------- PAGE 1: SETUP ---------------- */
const setupEls = {
  video: document.getElementById("livePreviewVideo"),
  img: document.getElementById("livePreviewImg"),   // required for Canon DSLR live preview via realCameraBridge
  placeholder: document.getElementById("previewPlaceholder"),
  zoomLevelLabel: document.getElementById("zoomLevelLabel"),
  zoomTypeLabel: document.getElementById("zoomTypeLabel"),
  nextBtn: document.getElementById("btnNextFromSetup")
};

let currentZoom = 1.0;

function renderCameraStatus(status) {
  const statusBox = document.getElementById("statusBox");
  if (!statusBox) return;

  // Find or create status info element
  let infoEl = document.getElementById("cameraStatusInfo");
  if (!infoEl) {
    infoEl = document.createElement("div");
    infoEl.id = "cameraStatusInfo";
    infoEl.className = "camera-status-info";
    statusBox.prepend(infoEl);
  }

  const isConnected = status && status.connected;
  const model = status ? status.model : "None";
  const connection = status ? status.connection : "—";

  infoEl.innerHTML = `
    <div class="status-indicator ${isConnected ? 'online' : 'offline'}"></div>
    <div class="status-details">
      <p class="status-model">${model}</p>
      <p class="status-connection">${connection}</p>
    </div>
  `;

  // Enable/disable next button based on connection
  if (setupEls.nextBtn) {
    setupEls.nextBtn.disabled = !isConnected;
  }
}

const btnZoomWide   = document.getElementById("btnZoomWide");
const btnZoomNormal = document.getElementById("btnZoomNormal");
const btnMirrorToggle = document.getElementById("btnMirrorToggle");

btnZoomWide.addEventListener("click", () => setFixedZoom(1.0));
btnZoomNormal.addEventListener("click", () => setFixedZoom(1.5));

async function setFixedZoom(level) {
  await updateZoom(level);
  btnZoomWide.classList.toggle("active", level === 1.0);
  btnZoomNormal.classList.toggle("active", level === 1.5);
}

let mirrorEnabled = false;
btnMirrorToggle.addEventListener("click", () => {
  mirrorEnabled = !mirrorEnabled;
  btnMirrorToggle.classList.toggle("active", mirrorEnabled);
  cameraController.setMirror(mirrorEnabled);
});

async function updateZoom(level) {
  level = Math.max(1.0, Math.min(5.0, level));
  try {
    const result = await cameraController.setZoom(level);
    currentZoom = result.level;
    setupEls.zoomLevelLabel.textContent = `${currentZoom.toFixed(1)}x`;
    setupEls.zoomTypeLabel.textContent = `(${result.type})`;
  } catch (e) {
    alert("Connect the camera before adjusting zoom.");
  }
}

/* ---------------- PAGE HOME: removed — frame page is now the start screen ------------------- */

function _proceedFromSetup() {
  // Timer expired on setup page — auto-advance to shooting
  kioskTimer.hide();

  // ── Audio: fade out standby BGM before entering shooting ──────────────
  if (typeof audioManager !== "undefined") {
    audioManager.onShootingStart();
  }

  _updatePoseOverlay();
  const ptEl = document.getElementById("photosTakenCount");
  if (ptEl) ptEl.innerHTML = '0<span class="photos-taken-slash">/</span><span class="photos-taken-total">8</span>';
  goToPage("shooting");
  shootingModule.startSession();
}

document.getElementById("btnBackFromSetup").addEventListener("click", () => {
  // Setup is now after frame (Page 1) — back goes to frame, no timer on Page 1
  kioskTimer.hide();
  goToPage("frame");
});

setupEls.nextBtn.addEventListener("click", () => {
  // Frame/qty already chosen on previous page — go directly to shooting
  kioskTimer.hide();

  // ── Audio: fade out standby BGM before entering shooting ──────────────
  if (typeof audioManager !== "undefined") {
    audioManager.onShootingStart();
  }

  _updatePoseOverlay();
  const ptEl = document.getElementById("photosTakenCount");
  if (ptEl) ptEl.innerHTML = '0<span class="photos-taken-slash">/</span><span class="photos-taken-total">8</span>';
  goToPage("shooting");
  shootingModule.startSession();
});

/* ---------------- PAGE 2: FRAME + QUANTITY ---------------- */

const FRAME_NAMES = {
  "2x6": "Long Frame",
  "4x6": "Wide Frame"
};

function calcPrice(qty) {
  return 50 + Math.max(0, qty - 1) * 25;
}

const frameEls = {
  card2x6:    document.getElementById("frameCard2x6"),
  card4x6:    document.getElementById("frameCard4x6"),
  qtyValue:   document.getElementById("qtyValue"),
  qtyMinus:   document.getElementById("btnQtyMinus"),
  qtyPlus:    document.getElementById("btnQtyPlus"),
  labelPill:  document.getElementById("qtyLabelPill"),
  pricePill:  document.getElementById("qtyPricePill"),
  backBtn:    document.getElementById("btnBackFromFrame"),
  nextBtn:    document.getElementById("btnNextFromFrame")
};

frameEls.card2x6.addEventListener("click", () => selectFrame("2x6"));
frameEls.card4x6.addEventListener("click", () => selectFrame("4x6"));

function selectFrame(type) {
  sessionState.frameType = type;
  frameEls.card2x6.classList.toggle("selected", type === "2x6");
  frameEls.card4x6.classList.toggle("selected", type === "4x6");
  frameEls.nextBtn.disabled = false;
  updateFramePricing();
}

frameEls.qtyMinus.addEventListener("click", () => setQuantity(sessionState.quantity - 1));
frameEls.qtyPlus.addEventListener("click",  () => setQuantity(sessionState.quantity + 1));

function setQuantity(qty) {
  sessionState.quantity = Math.max(1, Math.min(20, qty));
  frameEls.qtyValue.textContent = sessionState.quantity;
  updateFramePricing();
}

function updateFramePricing() {
  const qty = sessionState.quantity;

  if (!sessionState.frameType) {
    frameEls.labelPill.textContent = "Select a frame";
    frameEls.pricePill.textContent = "—";
    return;
  }

  const name = FRAME_NAMES[sessionState.frameType];

  if (sessionState.frameType === "2x6") {
    frameEls.labelPill.textContent = `${qty * 2} ${name}`;
  } else {
    frameEls.labelPill.textContent = `${qty} ${name}`;
  }

  frameEls.pricePill.textContent = `₱${calcPrice(qty)}`;
}

frameEls.backBtn.addEventListener("click", () => {
  // Frame page (Page 2) — back goes to QR Ticket page (Page 1)
  kioskTimer.hide();
  goToPage("ticket");
});

frameEls.nextBtn.addEventListener("click", () => {
  kioskTimer.hide();

  const indicatorText = document.getElementById("shootingFrameIndicatorText");
  if (indicatorText) {
    const name = FRAME_NAMES[sessionState.frameType] || sessionState.frameType;
    const size = sessionState.frameType === "2x6" ? "2×6" : "4×6";
    indicatorText.textContent = `${name} · ${size}`;
  }

  // Navigate to camera setup (Page 2)
  goToPage("setup");
  renderCameraStatus(cameraController.status);
  kioskTimer.start(60, _proceedFromSetup);
});

function proceedFromFrame() {
  // Frame page has no timer — this function kept for compat but should not be called
  kioskTimer.hide();
  goToPage("setup");
  renderCameraStatus(cameraController.status);
  kioskTimer.start(60, _proceedFromSetup);
}

/* ---------------- PAGE 6: ALL DONE + DONE-BUTTON TIMER ---------------- */

/*
 * uploadProgress — public API for qr.js / printing.js.
 *
 * The visible upload progress bar has been removed from the UI.
 * These methods still update the hidden #uploadProgressWrap elements so
 * qr.js can call them without errors, and they drive the Done button state:
 *
 *   uploadProgress.start()      — called when printing begins (no-op for UI)
 *   uploadProgress.set(0–1)     — tracks upload fraction (no-op for UI)
 *   uploadProgress.complete()   — printing started → enable Done + start timer
 *   uploadProgress.error(msg)   — upload failed → still enable Done
 *
 * The Done button has three CSS states:
 *   default           — disabled, dim, cursor:not-allowed
 *   .ready            — amber border, clickable
 *   .ready.timer-running — amber fill sweeps left→right over 60s (CSS ::before)
 *   .timer-done       — fill complete, session auto-resets
 */
const uploadProgress = (() => {
  // Hidden elements — kept for qr.js compatibility
  const wrap  = document.getElementById("uploadProgressWrap");
  const bar   = document.getElementById("uploadProgressBar");
  const pct   = document.getElementById("uploadProgressPct");
  const label = document.getElementById("uploadProgressLabel");
  const hint  = document.getElementById("uploadProgressHint");

  const doneBtn = document.getElementById("btnPrintingDone");

  // 60-second auto-advance timer handle
  let _doneTimer = null;
  // Safety-net timer: if complete() / error() never fires (e.g. upload hangs
  // with no network and no error callback), enable Done after 25s anyway so
  // the guest is never permanently stranded on the printing page offline.
  let _safetyTimer = null;

  function _enableDone() {
    if (!doneBtn) return;
    if (_safetyTimer) { clearTimeout(_safetyTimer); _safetyTimer = null; }
    if (doneBtn.classList.contains("ready")) return; // already enabled

    // 1. Unlock the button
    doneBtn.disabled = false;
    doneBtn.classList.add("ready");

    // 2. Start the CSS fill animation
    // Force a reflow so the animation restarts cleanly if re-used
    doneBtn.classList.remove("timer-running", "timer-done");
    void doneBtn.offsetWidth; // reflow
    doneBtn.classList.add("timer-running");

    // 3. Auto-advance after 60 s
    if (_doneTimer) clearTimeout(_doneTimer);
    _doneTimer = setTimeout(() => {
      if (doneBtn.classList.contains("timer-running")) {
        doneBtn.classList.remove("timer-running");
        doneBtn.classList.add("timer-done");
        // ── Audio: begin main → standby crossfade on auto-advance ────────
        if (typeof audioManager !== "undefined") {
          audioManager.onPrintingDone();
        }
        resetSessionAndRestart();
      }
    }, 60000);
  }

  return {
    start() {
      // Update hidden elements for qr.js
      if (wrap)  { wrap.classList.remove("complete", "error", "has-progress"); }
      if (bar)   { bar.style.width = "0%"; }
      if (pct)   { pct.textContent = "0%"; }
      if (label) { label.textContent = "Uploading your photos…"; }
      if (hint)  { hint.textContent = "Your digital copy will be ready soon"; }

      // Safety net: if complete() or error() never fires (no network + no error
      // callback), enable Done after 25s so the kiosk never gets stuck offline.
      if (_safetyTimer) clearTimeout(_safetyTimer);
      _safetyTimer = setTimeout(() => {
        _safetyTimer = null;
        console.warn("[uploadProgress] Safety timer fired — enabling Done (upload may be stalled or offline).");
        _enableDone();
      }, 25000);
    },

    set(fraction) {
      const pctVal = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      if (wrap) { wrap.classList.add("has-progress"); }
      if (bar)  { bar.style.width = `${pctVal}%`; }
      if (pct)  { pct.textContent = `${pctVal}%`; }
    },

    complete() {
      if (wrap)  { wrap.classList.add("complete", "has-progress"); wrap.classList.remove("error"); }
      if (bar)   { bar.style.width = "100%"; }
      if (pct)   { pct.textContent = "100%"; }
      if (label) { label.textContent = "Upload complete!"; }
      if (hint)  { hint.textContent = "Scan the QR code to access your digital copy"; }
      _enableDone();
    },

    error(msg) {
      if (wrap)  { wrap.classList.add("error"); wrap.classList.remove("complete"); }
      if (pct)   { pct.textContent = "—"; }
      if (label) { label.textContent = msg || "Upload failed"; }
      if (hint)  { hint.textContent = "Your photos were printed. Contact staff for the digital copy."; }
      // Still enable Done so the session isn't stuck
      _enableDone();
    },

    // Called by resetSessionAndRestart() to cancel the auto-timer
    cancelTimer() {
      if (_doneTimer)   { clearTimeout(_doneTimer);   _doneTimer   = null; }
      if (_safetyTimer) { clearTimeout(_safetyTimer); _safetyTimer = null; }
      if (doneBtn) {
        doneBtn.classList.remove("timer-running", "timer-done", "ready");
        doneBtn.disabled = true;
      }
    }
  };
})();

/* Hook into the design page's "NEXT" button — defined in strip.js. */
const _origDesignNext = document.getElementById("btnNextFromDesign");
_origDesignNext.addEventListener("click", async () => {
  // ── Audio: fire printing SFX immediately on button press ──────────────
  // Must happen before any await so the sound starts without delay.
  if (typeof audioManager !== "undefined") {
    audioManager.playPrintSfx();
  }

  // Reset + start progress bar immediately
  uploadProgress.start();
  // Fire QR generation (assigns sessionState.galleryUrlPromise synchronously)
  qrModule.generateAndRender();
  // Set the video frame's aspect ratio based on frame type before init
  _setPrintingFrameAspectRatio();
  // Ensure the printing module has the latest design selection
  await printingModule.init();

  // Photo→video overlay transition removed — video strip shows directly

  // Link the QR ticket to this session (fire-and-forget)
  if (sessionState.ticketId && sessionState.id) {
    queueTickets.linkSession(sessionState.ticketId, sessionState.id).catch((e) => {
      console.warn("[app] Could not link ticket to session:", e.message || e);
    });
  }
});

/*
 * Sets the data-frame attribute on #printingVideoFrame so CSS applies the
 * correct aspect ratio (2:6 for Long Frame, 4:6 for Wide Frame).
 */
function _setPrintingFrameAspectRatio() {
  const videoFrame = document.getElementById("printingVideoFrame");
  if (!videoFrame) return;
  const frameType = sessionState.frameType || "2x6";
  videoFrame.dataset.frame = frameType;
}

/* _startPhotoToVideoTransition removed — photo overlay on Print & QR page
   has been removed per spec. Video strip shows directly without overlay. */

/* Done button — opens confirm modal. Timer keeps running behind the modal.
   If guest picks "Back", the timer simply continues from where it is.
   Only "Proceed" (end session) cancels the timer. */
document.getElementById("btnPrintingDone").addEventListener("click", () => {
  const btn = document.getElementById("btnPrintingDone");
  if (btn.disabled || !btn.classList.contains("ready")) return;
  // Do NOT cancel the timer — let it keep running behind the modal
  document.getElementById("confirmModal").hidden = false;
  document.getElementById("confirmModal").classList.add("show");
});

document.getElementById("btnConfirmBack").addEventListener("click", () => {
  const m = document.getElementById("confirmModal");
  m.classList.remove("show");
  m.hidden = true;
  // Timer is already running — nothing to restart
});

document.getElementById("btnConfirmProceed").addEventListener("click", () => {
  const m = document.getElementById("confirmModal");
  m.classList.remove("show");
  m.hidden = true;
  uploadProgress.cancelTimer();
  // ── Audio: begin main → standby crossfade immediately on confirm ──────
  // onPageChange('ticket') will also call _setZone('standby') but by then
  // main is already fading, so the transition feels seamless.
  if (typeof audioManager !== "undefined") {
    audioManager.onPrintingDone();
  }
  resetSessionAndRestart();
});

/*
 * resetSessionAndRestart — tears down the current session and returns to
 * the Frame Selection page.
 *
 * OFFLINE SAFETY: We no longer block on sessionState.uploadPromise here.
 * The upload either:
 *   a) already completed → no wait needed.
 *   b) is still in progress → offlineQueue handles it; kiosk must not be
 *      stuck waiting on a network call while the guest is standing here.
 *   c) failed → offlineQueue already enqueued it for retry.
 *
 * In all three cases the guest can tap Done and the kiosk resets immediately.
 * The pending upload continues / retries in the background via offlineQueue.
 */
async function resetSessionAndRestart() {
  kioskTimer.hide();

  // Evict blob URLs from strip cache before revoking
  sessionState.shots.forEach((s) => {
    if (s.imageUrl) {
      if (typeof stripModule !== "undefined") stripModule._imageCache.delete(s.imageUrl);
      URL.revokeObjectURL(s.imageUrl);
    }
    if (s.videoUrl) {
      if (typeof stripModule !== "undefined") stripModule._imageCache.delete(s.videoUrl);
      URL.revokeObjectURL(s.videoUrl);
    }
  });

  // Mark ticket as COMPLETED before resetting (fire-and-forget)
  if (sessionState.ticketId) {
    queueTickets.completeTicket(sessionState.ticketId).catch((e) => {
      console.warn("[resetSession] Could not complete ticket:", e.message || e);
    });
  }

  sessionState.id        = Date.now().toString(36);
  sessionState.frameType = null;
  sessionState.quantity  = 1;
  sessionState.shots     = [];
  sessionState.selectedShots = [];
  sessionState.design    = null;
  sessionState.finalStripPng   = null;
  sessionState.finalStripVideo = null;
  sessionState.printReadyPng   = null;
  sessionState.galleryUrl = null;
  sessionState.galleryUrlPromise = null;
  sessionState.uploadPromise     = null;

  // Reset ticket state
  sessionState.ticketId       = null;
  sessionState.ticketNumber   = null;
  sessionState.ticketLine     = null;
  sessionState.ticketCopies   = null;
  sessionState.ticketFrame    = null;
  sessionState.ticketKeychain = null;

  // Reset Page 6 Done button (cancels timer + removes .ready / .timer-running / .timer-done)
  uploadProgress.cancelTimer();
  const wrap = document.getElementById("uploadProgressWrap");
  if (wrap) {
    wrap.setAttribute("hidden", "");
    wrap.classList.remove("complete", "error", "has-progress");
  }
  const bar = document.getElementById("uploadProgressBar");
  if (bar) bar.style.width = "0%";

  // Reset Frame Selection UI (now the first workflow page)
  document.getElementById("frameCard2x6").classList.remove("selected");
  document.getElementById("frameCard4x6").classList.remove("selected");
  document.getElementById("btnNextFromFrame").disabled = true;
  document.getElementById("qtyValue").textContent = "1";
  document.getElementById("qtyLabelPill").textContent = "Select a frame";
  document.getElementById("qtyPricePill").textContent = "—";
  sessionState.quantity = 1;

  // Printing page always keeps white grid-bg — no yellow wave to reset

  // Reset QR wrap state
  const qrUploading = document.getElementById("qrUploading");
  if (qrUploading) qrUploading.style.display = "";
  const qrCodeCanvas = document.getElementById("qrCodeCanvas");
  if (qrCodeCanvas) qrCodeCanvas.innerHTML = "";

  // Wrap in try/catch so a camera error never prevents returning to page 1.
  try {
    cameraController.attachPreview(setupEls.video, setupEls.img);
  } catch (e) {
    console.warn("[resetSession] attachPreview failed (non-fatal):", e.message || e);
  }

  // Reset ticket scan UI
  if (typeof kioskQrScanner !== "undefined") {
    kioskQrScanner.reset();
  }

  goToPage("ticket");
}

/* Frame thumbnails — paths relative to /kiosk/ */
document.getElementById("frameThumb2x6").src = "assets/designs/thumbnail/2x6_Strip_Thumbnail.png";
document.getElementById("frameThumb4x6").src = "assets/designs/thumbnail/4x6_Strip_Thumbnail.png";

/* Page 4 overlay removed — overlay not used in this design. */

/* Strip overlay removed — not used in this design. */

/* ── Page 3: Photos Taken counter ──────────────────────────────────────── */
/*
 * shooting.js updates .shot-counter (now hidden). We hook into the same
 * session state to keep the right-panel counter in sync.
 * shooting.js exposes window.kioskShooting.getShotCount() — if that isn't
 * available yet, we watch for the global shotsTaken variable instead.
 *
 * The simplest approach: patch the shot-counter's textContent setter so
 * any write to the hidden element also updates the visible counter.
 */
(function patchShotCounter() {
  const shotCounterEl = document.getElementById("shotCounter");
  const photosTakenEl = document.getElementById("photosTakenCount");
  if (!shotCounterEl || !photosTakenEl) return;

  const _origSet = Object.getOwnPropertyDescriptor(Node.prototype, "textContent").set;
  Object.defineProperty(shotCounterEl, "textContent", {
    set(val) {
      _origSet.call(this, val);
      // Parse "PHOTO X OF Y" — update the side counter
      const m = String(val).match(/(\d+)\s*OF\s*(\d+)/i);
      if (m) {
        const taken = parseInt(m[1], 10) - 1; // current shot hasn't been taken yet
        const total = parseInt(m[2], 10);
        photosTakenEl.innerHTML =
          `${taken}<span class="photos-taken-slash">/</span><span class="photos-taken-total">${total}</span>`;
      }
    },
    get() { return shotCounterEl.innerText; }
  });
})();

/* ── Page 3: Show pose overlay for 4×6 only ────────────────────────────── */
function _updatePoseOverlay() {
  const overlay = document.getElementById("poseOverlay4x6");
  if (!overlay) return;
  overlay.style.display = sessionState.frameType === "4x6" ? "block" : "none";
}

/* ── Page 6: Printing status subtitle update ────────────────────────────── */
/*
 * Patch uploadProgress.start() to update the subtitle to show uploading state,
 * and uploadProgress.complete() to update to printing state.
 */
const _origUploadStart = uploadProgress.start.bind(uploadProgress);
uploadProgress.start = function(...args) {
  _origUploadStart(...args);
  const sub = document.getElementById("printingStatusSubtitle");
  if (sub) sub.textContent = "Uploading your photos & video…";
  // Always keep white grid-bg — no yellow wave effect
};

const _origUploadComplete = uploadProgress.complete.bind(uploadProgress);
uploadProgress.complete = function(...args) {
  _origUploadComplete(...args);
  const sub = document.getElementById("printingStatusSubtitle");
  if (sub) sub.textContent = "Your photo is now printing at the counter.";
  // No yellow wave — white grid-bg is maintained throughout
};
