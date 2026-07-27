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
  design: null         // filled on Page 5 (next batch)
};

/* ---------------- Navigation ---------------- */
function goToPage(pageName) {
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.querySelector(`.page[data-page="${pageName}"]`).classList.add("active");

  const logo = document.getElementById("studioLogo");
  if (logo) logo.hidden = pageName !== "setup";
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

setupEls.nextBtn.addEventListener("click", () => {
  goToPage("frame");
  kioskTimer.start(60, proceedFromFrame);
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

frameEls.backBtn.addEventListener("click", () => {
  kioskTimer.hide();
  goToPage("setup");
});
frameEls.nextBtn.addEventListener("click", () => {
  kioskTimer.hide();
  goToPage("shooting");
  shootingModule.startSession();
});

/* Time's up on Page 2 — default to 2x6 / qty 1 if nothing was chosen
   yet, then proceed exactly as if NEXT had been tapped. */
function proceedFromFrame() {
  if (!sessionState.frameType) selectFrame("2x6");
  frameEls.nextBtn.click();
}

/* ---------------- PAGE 6 wiring + session reset ---------------- */
document.addEventListener("DOMContentLoaded", () => {
  const origNextFromDesign = document.getElementById("btnNextFromDesign");
});

// Hook into the design page's "NEXT" button (defined in strip.js) to init page 6
const _origDesignNext = document.getElementById("btnNextFromDesign");
_origDesignNext.addEventListener("click", async () => {
  // Fire immediately — sessionState.galleryUrlPromise is assigned
  // synchronously at the very start of generateAndRender(), so
  // printingModule.init() can safely read it right after this call.
  qrModule.generateAndRender();
  await printingModule.init();
});

function resetSessionAndRestart() {
  kioskTimer.hide();

  // Revoke old blob URLs to avoid memory leaks
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

  // Reset Page 2 UI
  document.getElementById("frameCard2x6").classList.remove("selected");
  document.getElementById("frameCard4x6").classList.remove("selected");
  document.getElementById("btnNextFromFrame").disabled = true;
  document.getElementById("qtyValue").textContent = "1";
  document.getElementById("summaryText").textContent = "Select a frame type to continue";

  // Re-lock Done for the next guest's session
  const doneBtn = document.getElementById("btnDone");
  if (doneBtn) doneBtn.disabled = true;

  goToPage("setup");
}

document.getElementById("frameThumb2x6").src = "assets/designs/2x6_Strip_Thumbnail.png";
document.getElementById("frameThumb4x6").src = "assets/designs/4x6_Strip_Thumbnail.png";
document.getElementById("btnPreviewGallery").addEventListener("click", async () => {
  const previewWindow = window.open("", "_blank", "width=420,height=780");
  if (!previewWindow) {
    alert("Please allow pop-ups for this site to preview the digital gallery.");
    return;
  }
  previewWindow.document.write(`<!DOCTYPE html><html><head><title>Loading…</title></head>
  <body style="font-family:sans-serif;text-align:center;padding-top:60px;color:#666;">Loading your gallery…</body></html>`);
  previewWindow.document.close();

  let data = null;
  if (typeof cloudStorage !== "undefined" && cloudStorage.isAvailable()) {
    try {
      data = await cloudStorage.getSession(sessionState.id);
    } catch (e) {
      console.error("[preview] Cloud fetch failed:", e);
    }
  }

  if (!data) {
    previewWindow.document.body.innerHTML = `
      <div style="font-family:sans-serif;text-align:center;padding:60px 24px;color:#333;">
        <p style="font-weight:600;">We couldn't find this gallery yet.</p>
        <p style="color:#888;font-size:0.85rem;margin-top:8px;">The session may still be uploading — try again in a moment.</p>
      </div>`;
    return;
  }

  renderPreviewWindow(previewWindow, data);
});

function renderPreviewWindow(win, data) {
  const photoUrl = data.finalStripUrl || null;
  const videoUrl = data.finalStripVideoUrl || null;
  const photos = Array.isArray(data.photos) ? data.photos : [];

  const gridItemsHtml = photos.map((p, i) => {
    const isVideo = !!p.videoUrl;
    const mediaUrl = p.videoUrl || p.imageUrl || "";
    const mediaTag = isVideo
      ? `<video src="${mediaUrl}" muted loop autoplay playsinline></video>`
      : `<img src="${mediaUrl}" alt="Photo ${i + 1}">`;
    return `<div class="card">
      ${mediaTag}
      <div class="card-footer">
        <span>Photo ${i + 1}${isVideo ? " • video" : ""}</span>
        <button class="grid-dl" data-url="${mediaUrl}" data-name="${data.id}-photo-${i + 1}.${isVideo ? "webm" : "jpg"}">⬇</button>
      </div>
    </div>`;
  }).join("");

  const doc = win.document;
  doc.open();
  doc.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Your Digital Copy — Studrio Booth</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #f4f5f7; color: #1c1e21; padding: 24px 16px 48px; }
  h1 { font-size: 1.4rem; font-weight: 800; text-align: center; }
  .sub { text-align: center; color: #666b73; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; margin: 4px 0 20px; }
  .block { background: #fff; border: 1px solid #d9dce1; border-radius: 14px; padding: 16px; max-width: 420px; margin: 0 auto 20px; }
  .media-frame { position: relative; display: flex; justify-content: center; align-items: center; width: 100%; min-height: 120px; max-height: 60vh; overflow: hidden; border-radius: 8px; background: #16171a; }
  .media-frame img, .media-frame video { max-width: 100%; max-height: 60vh; width: auto; height: auto; display: block; border-radius: 6px; }
  .mute-toggle { position: absolute; bottom: 10px; right: 10px; width: 34px; height: 34px; border-radius: 50%; border: none; background: rgba(0,0,0,0.55); color: #fff; font-size: 1rem; cursor: pointer; }
  .download-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
  .download-btn { font-family: inherit; display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 10px; border: none; background: #16171a; color: #fff; cursor: pointer; text-align: left; }
  .download-btn:disabled { opacity: 0.6; cursor: wait; }
  .download-icon { font-size: 1.1rem; }
  .download-title { font-size: 0.85rem; font-weight: 700; display: block; }
  .download-subtitle { font-size: 0.7rem; color: #b7b9bd; display: block; }
  .grid-title { font-size: 0.85rem; font-weight: 700; color: #666b73; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
  .card { background: #eef0f3; border: 1px solid #d9dce1; border-radius: 10px; overflow: hidden; }
  .card img, .card video { width: 100%; aspect-ratio: 3/4; object-fit: cover; display: block; background: #000; }
  .card-footer { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; font-size: 0.75rem; color: #666b73; }
  .grid-dl { border: 1px solid #d9dce1; background: #fff; border-radius: 6px; width: 28px; height: 28px; cursor: pointer; }
  .status { text-align: center; color: #666b73; font-size: 0.9rem; margin-top: 20px; }
  .footer { text-align: center; color: #666b73; font-size: 0.8rem; margin-top: 24px; }
</style>
</head>
<body>
  <h1>Your Digital Copy</h1>
  <p class="sub">Studrio Booth</p>

  <div class="block">
    <div class="media-frame" id="mediaFrame"></div>
    <div class="download-row">
      <button class="download-btn" id="btnDownloadPhoto" ${photoUrl ? "" : "hidden"}>
        <span class="download-icon">🖼</span>
        <span><span class="download-title">Download Photo</span><span class="download-subtitle">Save the photo strip</span></span>
      </button>
      <button class="download-btn" id="btnDownloadVideo" ${videoUrl ? "" : "hidden"}>
        <span class="download-icon">▶</span>
        <span><span class="download-title">Download Video</span><span class="download-subtitle">Save the video strip</span></span>
      </button>
    </div>
  </div>

  ${photos.length ? `<div class="block">
    <p class="grid-title">Individual Photos &amp; Videos</p>
    <div class="grid">${gridItemsHtml}</div>
  </div>` : ""}

  <p class="footer">Powered by Studrio Booth</p>

<script>
(function() {
  const photoUrl = ${JSON.stringify(photoUrl)};
  const videoUrl = ${JSON.stringify(videoUrl)};
  const sessionId = ${JSON.stringify(data.id || "studrio")};
  const mediaFrame = document.getElementById("mediaFrame");

  if (videoUrl) {
    mediaFrame.innerHTML = '<video src="' + videoUrl + '" autoplay loop muted playsinline></video><button class="mute-toggle" id="muteToggle">🔇</button>';
    const videoEl = mediaFrame.querySelector("video");
    document.getElementById("muteToggle").addEventListener("click", function () {
      videoEl.muted = !videoEl.muted;
      this.textContent = videoEl.muted ? "🔇" : "🔊";
    });
  } else if (photoUrl) {
    mediaFrame.innerHTML = '<img src="' + photoUrl + '" alt="Photo strip">';
  } else {
    mediaFrame.innerHTML = '<p class="status">Still processing — check back in a moment.</p>';
  }

  function downloadFile(url, filename, btn) {
    if (!url) return;
    const subtitleEl = btn.querySelector(".download-subtitle");
    const original = subtitleEl ? subtitleEl.textContent : "";
    btn.disabled = true;
    if (subtitleEl) subtitleEl.textContent = "Downloading…";
    fetch(url)
      .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.blob(); })
      .then(function (blob) {
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl; a.download = filename; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(objUrl); }, 10000);
        btn.disabled = false;
        if (subtitleEl) subtitleEl.textContent = original;
      })
      .catch(function (e) {
        console.error("Download failed:", e);
        btn.disabled = false;
        if (subtitleEl) subtitleEl.textContent = "Tap to retry";
      });
  }

  const photoBtn = document.getElementById("btnDownloadPhoto");
  const videoBtn = document.getElementById("btnDownloadVideo");
  if (photoBtn) photoBtn.addEventListener("click", function () { downloadFile(photoUrl, sessionId + "-photo-strip.png", photoBtn); });
  if (videoBtn) videoBtn.addEventListener("click", function () { downloadFile(videoUrl, sessionId + "-video-strip.webm", videoBtn); });

  document.querySelectorAll(".grid-dl").forEach(function (btn) {
    btn.addEventListener("click", function () {
      const url = btn.getAttribute("data-url");
      const name = btn.getAttribute("data-name");
      btn.textContent = "⏳"; btn.disabled = true;
      fetch(url)
        .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.blob(); })
        .then(function (blob) {
          const objUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = objUrl; a.download = name; a.rel = "noopener";
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(objUrl); }, 10000);
          btn.textContent = "⬇"; btn.disabled = false;
        })
        .catch(function () { btn.textContent = "⚠"; btn.disabled = false; });
    });
  });
})();
</script>
</body>
</html>`);
  doc.close();
}