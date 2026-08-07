/*
 * QR.JS — Generates the gallery QR code and drives the upload progress bar.
 *
 * Updated to:
 *   1. Generate the gallery URL first.
 *   2. Render the QR code immediately for the user.
 *   3. Generate the required blobs (Photo, Video, Photo with QR).
 *   4. Use cloudStorage.saveSession() for a clean Supabase upload.
 */

const qrModule = (() => {
  let _resolve = null;

  function generateAndRender() {
    sessionState.uploadPromise = new Promise((resolve) => { _resolve = resolve; });
    sessionState.galleryUrlPromise = sessionState.uploadPromise;

    _run().finally(() => {
      // Resolve with the actual gallery URL (set synchronously near the top
      // of _run(), on both the success and _fallback() paths) — NOT with no
      // value. printing.js awaits this exact promise to get the qrText it
      // bakes into the printed strip; resolving empty silently produced a
      // print with no QR code even though the on-screen QR rendered fine.
      if (_resolve) { _resolve(sessionState.galleryUrl); _resolve = null; }
    });
  }

  async function _run() {
    const qrUploading = document.getElementById("qrUploading");
    const galleryUrl = `${CLOUD_CONFIG.galleryBaseUrl}${sessionState.id}`;
    sessionState.galleryUrl = galleryUrl;

    // Show uploading spinner
    if (qrUploading) qrUploading.style.display = "";
    
    // Milestone 10%: Render QR immediately so the user can see it
    _renderQR(galleryUrl);
    if (typeof uploadProgress !== "undefined") uploadProgress.set(0.10);

    try {
      if (!cloudStorage.isAvailable()) {
        console.warn("[qr] Cloud storage not available, skipping upload.");
        _fallback();
        return;
      }

      // 1. Generate Photo Strip (milestone 30%)
      sessionState.finalStripPng = await stripModule.exportPNG({
        frameType: sessionState.frameType,
        selectedShots: sessionState.selectedShots,
        designId: sessionState.design
      });
      if (typeof uploadProgress !== "undefined") uploadProgress.set(0.30);

      // 2. Generate Video Strip (milestone 50%)
      try {
        sessionState.finalStripVideo = await stripModule.exportVideoStrip({
          frameType: sessionState.frameType,
          selectedShots: sessionState.selectedShots,
          designId: sessionState.design,
          durationMs: 8000 // match the guest's actual ~8s per-shot capture
        });
      } catch (videoErr) {
        console.warn("[qr] Video generation failed:", videoErr);
      }
      if (typeof uploadProgress !== "undefined") uploadProgress.set(0.50);

      // 3. Generate Photo with QR (Print-ready) (milestone 70%)
      sessionState.printReadyPng = await stripModule.exportPrintPNG({
        frameType: sessionState.frameType,
        selectedShots: sessionState.selectedShots,
        designId: sessionState.design,
        qrText: galleryUrl
      });
      if (typeof uploadProgress !== "undefined") uploadProgress.set(0.70);

      // 4. Upload all via cloudStorage (milestone 90%)
      await cloudStorage.saveSession(sessionState);
      if (typeof uploadProgress !== "undefined") uploadProgress.set(0.90);

      // Hide uploading spinner
      if (qrUploading) qrUploading.style.display = "none";

      // Progress: 100% — complete → enables Done button
      if (typeof uploadProgress !== "undefined") uploadProgress.complete();

    } catch (err) {
      console.error("[qr] Flow error:", err.message || err);
      _fallback();
      if (qrUploading) qrUploading.style.display = "none";
      if (typeof uploadProgress !== "undefined") {
        uploadProgress.error("Upload failed — check your connection");
      }
    }
  }

  function _renderQR(url) {
    const container = document.getElementById("qrCodeCanvas");
    if (!container) return;
    container.innerHTML = "";

    try {
      new QRCode(container, {
        text: url,
        width:  160,
        height: 160,
        colorDark:  "#111111",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (e) {
      console.error("[qr] QR render error:", e);
    }
  }

  function _fallback() {
    const fallbackUrl = `${CLOUD_CONFIG.galleryBaseUrl}${sessionState.id}`;
    sessionState.galleryUrl = fallbackUrl;
    _renderQR(fallbackUrl);
    if (typeof uploadProgress !== "undefined") {
      uploadProgress.error("Upload unavailable — QR may not work");
    }
  }

  return { generateAndRender };
})();
