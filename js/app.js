/*
 * APP.JS — global session state + page navigation + wiring for
 * Page 1 (setup) and Page 2 (frame/quantity).
 */

const sessionState = {
  id: `session-${Date.now()}`,
  frameType: null,   // "2x6" | "4x6"
  quantity: 1,
  shots: [],          // filled by shooting.js
  selectedShots: [],   // filled on Page 4 (next batch)
  design: null         // filled on Page 5 (next batch)
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
  statusIndicator: document.getElementById("statusIndicator"),
  detailModel: document.getElementById("statusDetailModel"),
  detailConn: document.getElementById("statusDetailConn"),
  detailPreview: document.getElementById("statusDetailPreview"),
  mockTag: document.getElementById("mockTag"),
  connectBtn: document.getElementById("btnConnect"),
  zoomOutBtn: document.getElementById("btnZoomOut"),
  zoomInBtn: document.getElementById("btnZoomIn"),
  zoomResetBtn: document.getElementById("btnZoomReset"),
  zoomLevelLabel: document.getElementById("zoomLevelLabel"),
  zoomTypeLabel: document.getElementById("zoomTypeLabel"),
  testPhotoBtn: document.getElementById("btnTestPhoto"),
  testPhotoImg: document.getElementById("testPhotoImg"),
  nextBtn: document.getElementById("btnNextFromSetup")
};

let currentZoom = 1.0;

setupEls.connectBtn.addEventListener("click", async () => {
  setupEls.connectBtn.disabled = true;
  setupEls.connectBtn.textContent = "Connecting...";
  try {
    const status = await cameraController.connect();
    renderCameraStatus(status);
    cameraController.attachPreview(setupEls.video, setupEls.img);
    setupEls.placeholder.hidden = true;
    setupEls.nextBtn.disabled = false;
  } catch (e) {
    renderCameraStatus({ connected: false });
    alert("Could not connect to camera. Check DSLR power / USB / bridge, or allow webcam access for mock mode.");
  }
  setupEls.connectBtn.disabled = false;
  setupEls.connectBtn.textContent = "Connect Camera";
});

function renderCameraStatus(status) {
  if (status.connected) {
    setupEls.statusIndicator.innerHTML = `<span class="dot dot-on"></span> DSLR CONNECTED`;
    setupEls.detailModel.textContent = `Camera: ${status.model}`;
    setupEls.detailConn.textContent = `Connection: ${status.connection}`;
    setupEls.detailPreview.textContent = `Live Preview: ${status.previewAvailable ? "Available" : "Unavailable"}`;
    setupEls.mockTag.hidden = !cameraController.isMock();
  } else {
    setupEls.statusIndicator.innerHTML = `<span class="dot dot-off"></span> DSLR NOT CONNECTED`;
    setupEls.detailModel.textContent = "Camera: —";
    setupEls.detailConn.textContent = "Connection: —";
    setupEls.detailPreview.textContent = "Live Preview: —";
    setupEls.mockTag.hidden = true;
  }
}

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
  setupEls.video.classList.toggle("mirrored", mirrorEnabled);
  setupEls.img.classList.toggle("mirrored", mirrorEnabled);
  cameraController.mirrorEnabled = mirrorEnabled; // read by capturePhoto for mock flip
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

setupEls.testPhotoBtn.addEventListener("click", async () => {
  try {
    const blob = await cameraController.capturePhoto();
    setupEls.testPhotoImg.src = URL.createObjectURL(blob);
    setupEls.testPhotoImg.hidden = false;
  } catch (e) {
    alert("Connect the camera before taking a test photo.");
  }
});

setupEls.nextBtn.addEventListener("click", () => {
  goToPage("frame");
});

/* ---------------- PAGE 2: FRAME + QUANTITY ---------------- */
const frameEls = {
  card2x6: document.getElementById("frameCard2x6"),
  card4x6: document.getElementById("frameCard4x6"),
  qtyValue: document.getElementById("qtyValue"),
  qtyMinus: document.getElementById("btnQtyMinus"),
  qtyPlus: document.getElementById("btnQtyPlus"),
  summaryText: document.getElementById("summaryText"),
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
  updateFrameSummary();
}

frameEls.qtyMinus.addEventListener("click", () => setQuantity(sessionState.quantity - 1));
frameEls.qtyPlus.addEventListener("click", () => setQuantity(sessionState.quantity + 1));

function setQuantity(qty) {
  sessionState.quantity = Math.max(1, Math.min(20, qty));
  frameEls.qtyValue.textContent = sessionState.quantity;
  updateFrameSummary();
}

function updateFrameSummary() {
  if (!sessionState.frameType) {
    frameEls.summaryText.textContent = "Select a frame type to continue";
    return;
  }
  const qty = sessionState.quantity;
  if (sessionState.frameType === "2x6") {
    const printed = qty * 2;
    frameEls.summaryText.textContent = `In ${qty} cop${qty === 1 ? "y" : "ies"}, we will print ${printed} copies of the strip.`;
  } else {
    frameEls.summaryText.textContent = `In ${qty} cop${qty === 1 ? "y" : "ies"}, we will print ${qty} copies of the film.`;
  }
}

frameEls.backBtn.addEventListener("click", () => goToPage("setup"));
frameEls.nextBtn.addEventListener("click", () => goToPage("shooting"));

/* ---------------- PAGE 6 wiring + session reset ---------------- */
document.addEventListener("DOMContentLoaded", () => {
  const origNextFromDesign = document.getElementById("btnNextFromDesign");
});

// Hook into the design page's "NEXT" button (defined in strip.js) to init page 6
const _origDesignNext = document.getElementById("btnNextFromDesign");
_origDesignNext.addEventListener("click", async () => {
  await printingModule.init();
  qrModule.generateAndRender();
});

function resetSessionAndRestart() {
  // Revoke old blob URLs to avoid memory leaks
  sessionState.shots.forEach((s) => {
    if (s.imageUrl) URL.revokeObjectURL(s.imageUrl);
    if (s.videoUrl) URL.revokeObjectURL(s.videoUrl);
  });

  sessionState.id = `session-${Date.now()}`;
  sessionState.frameType = null;
  sessionState.quantity = 1;
  sessionState.shots = [];
  sessionState.selectedShots = [];
  sessionState.design = null;

  // Reset Page 2 UI
  document.getElementById("frameCard2x6").classList.remove("selected");
  document.getElementById("frameCard4x6").classList.remove("selected");
  document.getElementById("btnNextFromFrame").disabled = true;
  document.getElementById("qtyValue").textContent = "1";
  document.getElementById("summaryText").textContent = "Select a frame type to continue";

  // Reset Page 1 test photo
  document.getElementById("testPhotoImg").hidden = true;

  goToPage("setup");
}

document.getElementById("frameThumb2x6").src = STRIP_DESIGNS[0].overlays["2x6"];
document.getElementById("frameThumb4x6").src = STRIP_DESIGNS[0].overlays["4x6"];
document.getElementById("btnPreviewGallery").addEventListener("click", () => {
  window.open(`${window.location.pathname}?gallery=${sessionState.id}`, "_blank");
});
