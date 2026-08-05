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
  uploadPromise: null
};

/* ---------------- Navigation ---------------- */
function goToPage(pageName) {
  const allPages = document.querySelectorAll(".page");
  const currentPage = document.querySelector(".page.active");
  const nextPage = document.querySelector(`.page[data-page="${pageName}"]`);

  if (!nextPage || currentPage === nextPage) return;

  const tl = gsap.timeline();

  if (currentPage) {
    tl.to(currentPage, {
      opacity: 0,
      x: -30,
      duration: 0.4,
      ease: "power2.inOut",
      onComplete: () => {
        currentPage.classList.remove("active");
        gsap.set(currentPage, { x: 0 }); // Reset position
      }
    });
  }

  tl.fromTo(nextPage, 
    { opacity: 0, x: 30 },
    { 
      opacity: 1, 
      x: 0, 
      duration: 0.5, 
      ease: "power2.out",
      onStart: () => {
        nextPage.classList.add("active");
        if (typeof uiAnimations !== 'undefined') {
          uiAnimations.animatePageIn(nextPage);
        }
      }
    },
    "-=0.2"
  );
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

function renderCameraStatus(status) {}

const btnZoomWide   = document.getElementById("btnZoomWide");
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

/* ---------------- PAGE HOME: LANDING ------------------- */
document.getElementById("btnStartSession").addEventListener("click", () => {
  goToPage("setup");
  kioskTimer.start(60, _proceedFromSetup);
});

function _proceedFromSetup() {
  kioskTimer.hide();
  goToPage("home");
}

document.getElementById("btnBackFromSetup").addEventListener("click", () => {
  kioskTimer.hide();
  goToPage("home");
});

setupEls.nextBtn.addEventListener("click", () => {
  kioskTimer.hide();
  goToPage("frame");
  kioskTimer.start(60, proceedFromFrame);
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
  kioskTimer.hide();
  goToPage("setup");
  kioskTimer.start(60, _proceedFromSetup);
});

frameEls.nextBtn.addEventListener("click", () => {
  kioskTimer.hide();

  const indicatorText = document.getElementById("shootingFrameIndicatorText");
  if (indicatorText) {
    const name = FRAME_NAMES[sessionState.frameType] || sessionState.frameType;
    const size = sessionState.frameType === "2x6" ? "2×6" : "4×6";
    indicatorText.textContent = `${name} · ${size}`;
  }

  goToPage("shooting");
  shootingModule.startSession();
});

function proceedFromFrame() {
  kioskTimer.hide();
  goToPage("setup");
  kioskTimer.start(60, _proceedFromSetup);
}

/* ---------------- PAGE 6: ALL DONE + UPLOAD PROGRESS ---------------- */

/*
 * uploadProgress — public API for qr.js to drive the progress bar.
 *
 * Usage:
 *   uploadProgress.start()           — show indeterminate bar
 *   uploadProgress.set(0.45)         — set 0–1 fraction (adds .has-progress)
 *   uploadProgress.complete()        — fill to 100%, mark done, enable Done btn
 *   uploadProgress.error(msg)        — show error state
 */
const uploadProgress = (() => {
  const wrap  = document.getElementById("uploadProgressWrap");
  const bar   = document.getElementById("uploadProgressBar");
  const pct   = document.getElementById("uploadProgressPct");
  const label = document.getElementById("uploadProgressLabel");
  const hint  = document.getElementById("uploadProgressHint");
  const doneBtn = document.getElementById("btnPrintingDone");

  function show() {
    if (wrap) wrap.removeAttribute("hidden");
  }

  return {
    start() {
      show();
      if (wrap)  { wrap.classList.remove("complete", "error", "has-progress"); }
      if (bar)   { bar.style.width = "0%"; }
      if (pct)   { pct.textContent = "0%"; }
      if (label) { label.textContent = "Uploading your photos…"; }
      if (hint)  { hint.textContent = "Your digital copy will be ready soon"; }
    },

    set(fraction) {
      show();
      const pctVal = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      if (wrap)  { wrap.classList.add("has-progress"); }
      if (bar)   { bar.style.width = `${pctVal}%`; }
      if (pct)   { pct.textContent = `${pctVal}%`; }
    },

    complete() {
      show();
      if (wrap)  { wrap.classList.add("complete", "has-progress"); wrap.classList.remove("error"); }
      if (bar)   { bar.style.width = "100%"; }
      if (pct)   { pct.textContent = "100%"; }
      if (label) { label.textContent = "Upload complete!"; }
      if (hint)  { hint.textContent = "Scan the QR code to access your digital copy"; }
      // Enable Done button now that QR is ready
      if (doneBtn) { doneBtn.disabled = false; }
    },

    error(msg) {
      show();
      if (wrap)  { wrap.classList.add("error"); wrap.classList.remove("complete"); }
      if (pct)   { pct.textContent = "—"; }
      if (label) { label.textContent = msg || "Upload failed"; }
      if (hint)  { hint.textContent = "Your photos were printed. Contact staff for the digital copy."; }
      // Still enable Done so the session isn't stuck
      if (doneBtn) { doneBtn.disabled = false; }
    }
  };
})();

/* Hook into the design page's "NEXT" button — defined in strip.js. */
const _origDesignNext = document.getElementById("btnNextFromDesign");
_origDesignNext.addEventListener("click", async () => {
  // Reset + start progress bar immediately
  uploadProgress.start();
  // Fire QR generation (assigns sessionState.galleryUrlPromise synchronously)
  qrModule.generateAndRender();
  await printingModule.init();
});

/* Done button */
document.getElementById("btnPrintingDone").addEventListener("click", () => {
  kioskTimer.hide();
  document.getElementById("confirmModal").hidden = false;
  document.getElementById("confirmModal").classList.add("show");
});

document.getElementById("btnConfirmBack").addEventListener("click", () => {
  const m = document.getElementById("confirmModal");
  m.classList.remove("show");
  m.hidden = true;
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
 * finish before tearing down the session and returning to Home.
 */
async function resetSessionAndRestart() {
  kioskTimer.hide();

  if (sessionState.uploadPromise) {
    const uploadGracePeriod = new Promise((resolve) => setTimeout(resolve, 10000));
    await Promise.race([sessionState.uploadPromise, uploadGracePeriod]);
  }

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

  sessionState.id        = Date.now().toString(36);
  sessionState.frameType = null;
  sessionState.quantity  = 1;
  sessionState.shots     = [];
  sessionState.selectedShots = [];
  sessionState.design    = null;
  sessionState.galleryUrl = null;
  sessionState.galleryUrlPromise = null;
  sessionState.uploadPromise     = null;

  // Reset Page 6 Done button + upload progress
  document.getElementById("btnPrintingDone").disabled = true;
  const wrap = document.getElementById("uploadProgressWrap");
  if (wrap) {
    wrap.setAttribute("hidden", "");
    wrap.classList.remove("complete", "error", "has-progress");
  }
  const bar = document.getElementById("uploadProgressBar");
  if (bar) bar.style.width = "0%";

  // Reset Page 2 UI
  document.getElementById("frameCard2x6").classList.remove("selected");
  document.getElementById("frameCard4x6").classList.remove("selected");
  document.getElementById("btnNextFromFrame").disabled = true;
  document.getElementById("qtyValue").textContent = "1";
  document.getElementById("qtyLabelPill").textContent = "Select a frame";
  document.getElementById("qtyPricePill").textContent = "—";

  // Reset QR wrap state
  const qrUploading = document.getElementById("qrUploading");
  if (qrUploading) qrUploading.style.display = "";
  const qrCodeCanvas = document.getElementById("qrCodeCanvas");
  if (qrCodeCanvas) qrCodeCanvas.innerHTML = "";

  cameraController.attachPreview(setupEls.video, setupEls.img);
  goToPage("home");
}

/* Frame thumbnails — paths relative to /kiosk/ */
document.getElementById("frameThumb2x6").src = "assets/designs/2x6_Strip_Thumbnail.png";
document.getElementById("frameThumb4x6").src = "assets/designs/4x6_Strip_Thumbnail.png";
