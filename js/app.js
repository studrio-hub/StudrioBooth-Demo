/*
 * APP.JS — global session state + page navigation + wiring for
 * Page 1 (setup) and Page 2 (frame/quantity).
 */

const sessionState = {
  id: Date.now().toString(36), // short, still unique, keeps the QR's encoded text as compact as possible
  frameType: null,   // "2x6" | "4x6"
  quantity: 1,
  shots: [],          // filled by shooting.js
  selectedShots: [],   // filled on Page 4 (next batch)
  design: null,        // filled on Page 5 (next batch)
  galleryUrl: null,
  galleryUrlPromise: null,
  uploadPromise: null  // set by qr.js; resolves when Supabase upload finishes (or times out)
};

/* ---------------- Navigation ---------------- */
function goToPage(pageName) {
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.querySelector(`.page[data-page="${pageName}"]`).classList.add("active");
}

/* ---------------- PAGE 1: SETUP ---------------- */
const setupEls = {
  video: document.getElementById("livePreviewVideo"),
  img: document.getElementById("livePreviewImg"),
  placeholder: document.getElementById("previewPlaceholder"),
  zoomLevelLabel: document.getElementById("zoomLevelLabel"),
  zoomTypeLabel: document.getElementById("zoomTypeLabel"),
  nextBtn: document.getElementById("btnNextFromSetup")
};

let currentZoom = 1.0;

// Camera connection now happens automatically on boot (see boot.js) — the
// home screen no longer has a manual "Connect Camera" button or a mock-mode
// warning. Kept as a no-op so boot.js's existing renderCameraStatus(status)
// call stays harmless.
function renderCameraStatus(status) {}

const btnZoomWide = document.getElementById("btnZoomWide");
const btnZoomNormal = document.getElementById("btnZoomNormal");
const btnMirrorToggle = document.getElementById("btnMirrorToggle");

btnZoomWide.addEventListener("click", () => setFixedZoom(1.0));
btnZoomNormal.addEventListener("click", () => setFixedZoom(2.0));

async function setFixedZoom(level) {
  await updateZoom(level);
  btnZoomWide.classList.toggle("active", level === 1.0);
  btnZoomNormal.classList.toggle("active", level === 2.0);
}

let mirrorEnabled = false;
btnMirrorToggle.addEventListener("click", () => {
  mirrorEnabled = !mirrorEnabled;
  btnMirrorToggle.classList.toggle("active", mirrorEnabled);
  cameraController.setMirror(mirrorEnabled); // updates the combined zoom+mirror transform
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

/* ---------------- PAGE HOME: LANDING ------------------- */
/*
 * The Home page is shown immediately after staff authenticates (no boot
 * screen). Boot → Home (Start button) → Setup (60s timer) → Frame → …
 * After a session ends, we also return to Home (camera stays live in the
 * background throughout).
 */
document.getElementById("btnStartSession").addEventListener("click", () => {
  goToPage("setup");
  kioskTimer.start(60, _proceedFromSetup);
});

function _proceedFromSetup() {
  // Timer expired on setup page — go back to home
  kioskTimer.hide();
  goToPage("home");
}

/* Back button on Setup — returns to Home */
document.getElementById("btnBackFromSetup").addEventListener("click", () => {
  kioskTimer.hide();
  goToPage("home");
});

/* Setup Next button — goes to frame selection */
setupEls.nextBtn.addEventListener("click", () => {
  kioskTimer.hide(); // stop the 60s setup timer
  goToPage("frame");
  kioskTimer.start(60, proceedFromFrame);
});

/* ---------------- PAGE 2: FRAME + QUANTITY ---------------- */

/*
 * Pricing rules (both frame types share the same structure):
 *   1 copy  = ₱50
 *   2 copies = ₱75  (+₱25)
 *   3 copies = ₱100 (+₱25 each)
 *   n copies = ₱50 + (n-1) × ₱25
 */
const FRAME_NAMES = {
  "2x6": "Long Frame",
  "4x6": "Wide Frame"
};

function calcPrice(qty) {
  return 50 + Math.max(0, qty - 1) * 25;
}

const frameEls = {
  card2x6: document.getElementById("frameCard2x6"),
  card4x6: document.getElementById("frameCard4x6"),
  qtyValue: document.getElementById("qtyValue"),
  qtyMinus: document.getElementById("btnQtyMinus"),
  qtyPlus: document.getElementById("btnQtyPlus"),
  labelPill: document.getElementById("qtyLabelPill"),
  pricePill: document.getElementById("qtyPricePill"),
  backBtn: document.getElementById("btnBackFromFrame"),
  nextBtn: document.getElementById("btnNextFromFrame")
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
frameEls.qtyPlus.addEventListener("click", () => setQuantity(sessionState.quantity + 1));

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
  kioskTimer.hide();
  goToPage("setup");
  kioskTimer.start(60, _proceedFromSetup); // restart 60s idle timer on setup
});
frameEls.nextBtn.addEventListener("click", () => {
  kioskTimer.hide();

  // Update the frame size indicator shown bottom-left on the shooting screen
  const indicatorText = document.getElementById("shootingFrameIndicatorText");
  if (indicatorText) {
    const name = FRAME_NAMES[sessionState.frameType] || sessionState.frameType;
    const size = sessionState.frameType === "2x6" ? "2×6" : "4×6";
    indicatorText.textContent = `${name} · ${size}`;
  }

  goToPage("shooting");
  shootingModule.startSession();
});

/* Time's up on Page 2 without a frame being selected — return to Setup.
   We do NOT auto-advance to shooting; the guest must make an active choice.
   Restart the 60s setup timer so the kiosk returns to Home if nobody acts. */
function proceedFromFrame() {
  kioskTimer.hide();
  goToPage("setup");
  kioskTimer.start(60, _proceedFromSetup);
}

/* ---------------- PAGE 6 wiring + session reset ---------------- */

// Hook into the design page's "NEXT" button (defined in strip.js) to init page 6.
// Auto-print is triggered inside printingModule.init() immediately after navigating.
const _origDesignNext = document.getElementById("btnNextFromDesign");
_origDesignNext.addEventListener("click", async () => {
  // Fire immediately — sessionState.galleryUrlPromise is assigned
  // synchronously at the very start of generateAndRender(), so
  // printingModule.init() can safely read it right after this call.
  qrModule.generateAndRender();
  await printingModule.init();
});

/* Done button on Page 6 — shows the "End session?" confirmation modal.
   The button stays disabled until printingModule enables it after upload. */
document.getElementById("btnPrintingDone").addEventListener("click", () => {
  kioskTimer.hide(); // pause the 60s countdown while modal is open
  document.getElementById("confirmModal").hidden = false;
  document.getElementById("confirmModal").classList.add("show");
});

/* Confirmation modal — wired for both the Done button path and the
   auto-timeout "End Session" path used by printingModule.endSessionOnTimeout(). */
document.getElementById("btnConfirmBack").addEventListener("click", () => {
  const m = document.getElementById("confirmModal");
  m.classList.remove("show");
  m.hidden = true;
  // Resume the 60s timer after the guest cancels
  kioskTimer.start(60, () => printingModule.endSessionOnTimeout());
});
document.getElementById("btnConfirmProceed").addEventListener("click", () => {
  const m = document.getElementById("confirmModal");
  m.classList.remove("show");
  m.hidden = true;
  resetSessionAndRestart();
});

/*
 * resetSessionAndRestart — waits for any in-progress Supabase upload to
 * finish before tearing down the session. This prevents blob URLs from
 * being revoked mid-upload, which was causing sessions to upload nothing
 * when the guest hit Done before the upload completed.
 *
 * The wait is capped at 10 seconds. If the upload hasn't confirmed by
 * then it has either already finished, already timed out inside qr.js
 * (which resolves uploadPromise), or is genuinely stuck — in all cases
 * it is safe to proceed with the reset.
 */
async function resetSessionAndRestart() {
  kioskTimer.hide();

  // Wait for the upload to finish before revoking anything.
  // uploadPromise is always resolved by qr.js (via its own finally block),
  // so this await will never hang indefinitely. The extra 10s race here is
  // a belt-and-suspenders guard in case uploadPromise was never set at all
  // (e.g. the guest navigated directly to this page without a full session).
  if (sessionState.uploadPromise) {
    const uploadGracePeriod = new Promise((resolve) => setTimeout(resolve, 10000));
    await Promise.race([sessionState.uploadPromise, uploadGracePeriod]);
  }

  // Safe to revoke now — upload has confirmed or definitively ended.
  sessionState.shots.forEach((s) => {
    if (s.imageUrl) URL.revokeObjectURL(s.imageUrl);
    if (s.videoUrl) URL.revokeObjectURL(s.videoUrl);
  });

  sessionState.id = Date.now().toString(36);
  sessionState.frameType = null;
  sessionState.quantity = 1;
  sessionState.shots = [];
  sessionState.selectedShots = [];
  sessionState.design = null;
  sessionState.galleryUrl = null;
  sessionState.galleryUrlPromise = null;
  sessionState.uploadPromise = null;

  // Reset Page 6 Done button
  document.getElementById("btnPrintingDone").disabled = true;

  // Reset Page 2 UI
  document.getElementById("frameCard2x6").classList.remove("selected");
  document.getElementById("frameCard4x6").classList.remove("selected");
  document.getElementById("btnNextFromFrame").disabled = true;
  document.getElementById("qtyValue").textContent = "1";
  document.getElementById("qtyLabelPill").textContent = "Select a frame";
  document.getElementById("qtyPricePill").textContent = "—";

  cameraController.attachPreview(setupEls.video, setupEls.img);

  // Return to Home (not Setup) between guests — matches the flow everywhere
  // else (Boot → Home → Setup). Authentication is still only required once
  // at kiosk startup, not between individual guest sessions.
  goToPage("home");
}

document.getElementById("frameThumb2x6").src = "assets/designs/2x6_Strip_Thumbnail.png";
document.getElementById("frameThumb4x6").src = "assets/designs/4x6_Strip_Thumbnail.png";
