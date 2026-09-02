/*
 * QR.JS — Generates the gallery QR code and drives the upload progress bar.
 *
 * Updated to:
 *   1. Generate the gallery URL first.
 *   2. Render the QR code immediately for the user.
 *   3. Generate the required blobs (Photo, stitched Video, Photo with QR,
 *      4 compressed individual photos).
 *   4. Use cloudStorage.saveSession() for a clean Supabase upload.
 *
 * Minor Fix — Print & QR / Gallery:
 *   The "video strip" (4 clips playing simultaneously, framed into the
 *   print-layout's photo slots) is replaced by a single STITCHED clip —
 *   the 4 selected videos played back-to-back in order, via
 *   stripModule.exportStitchedVideo() — used as sessionState.finalStripVideo
 *   for both the digital gallery and Page 6 (Print & QR). See
 *   exportStitchedVideo's doc comment in strip.js for the freeze-hold
 *   trimming / filter-baking details.
 *
 *   sessionState.finalStripVideoPromise is set synchronously as soon as
 *   generateAndRender() runs (before the cloud-availability check, and
 *   independently of the rest of the upload), so printing.js can await
 *   just the stitched video and swap Page 6's photo-strip preview over to
 *   it as soon as it's ready, without waiting on the (slower, or
 *   unavailable) cloud upload.
 *
 *   sessionState.individualPhotos is a new array of the 4 selected shots'
 *   photos, each re-encoded as JPEG and downscaled as needed so the 4
 *   together total 1.5MB or less, for upload to the digital gallery as
 *   individually-downloadable photos. NOTE: this file only prepares the
 *   compressed blobs — cloud-storage.js needs to actually upload each one
 *   and return public URLs (e.g. as session.individualPhotoUrls) for
 *   gallery.js's photo grid to use; that wiring isn't in this file.
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

    // Kick off the stitched video (Video 1 → 2 → 3 → 4, filtered,
    // freeze-hold trimmed — see exportStitchedVideo in strip.js)
    // immediately and independently of the cloud upload below. printing.js
    // awaits this exact promise so Page 6 can swap its photo-strip preview
    // over to the stitched video as soon as it's ready, without waiting on
    // the (potentially much slower, or entirely unavailable) cloud upload.
    const videoPromise = stripModule.exportStitchedVideo({
      selectedShots: sessionState.selectedShots
    }).catch((videoErr) => {
      console.warn("[qr] Stitched video generation failed:", videoErr);
      return null;
    });
    sessionState.finalStripVideoPromise = videoPromise;
    videoPromise.then((blob) => { if (blob) sessionState.finalStripVideo = blob; });

    try {
      if (!cloudStorage.isAvailable()) {
        console.warn("[qr] Cloud storage not available, skipping upload.");
        _fallback();
        return;
      }

      // Generate the photo strip, print-ready (QR-baked) PNG, and the 4
      // compressed individual photos concurrently — none of them depend on
      // each other's output, only on selectedShots/designId (and the print
      // PNG on the gallery URL, already known above). The stitched video
      // (videoPromise, above) runs alongside these too; it's awaited
      // separately below since saveSession() needs the finished blob, not
      // the still-pending promise.
      // singleStrip:true — for 2x6 sessions the print layout has two identical
      // strips side by side, but the gallery download/photo should be a single
      // clean strip. The print export (exportPrintPNG) still uses the full layout.
      const [finalStripPng, printReadyPng, individualPhotos] = await Promise.all([
        stripModule.exportPNG({
          frameType: sessionState.frameType,
          selectedShots: sessionState.selectedShots,
          designId: sessionState.design,
          singleStrip: true
        }),
        stripModule.exportPrintPNG({
          frameType: sessionState.frameType,
          selectedShots: sessionState.selectedShots,
          designId: sessionState.design,
          qrText: galleryUrl
        }),
        _compressIndividualPhotos(sessionState.selectedShots, 1.5 * 1024 * 1024).catch((e) => {
          console.warn("[qr] Individual photo compression failed:", e);
          return [];
        })
      ]);
      sessionState.finalStripPng = finalStripPng;
      sessionState.printReadyPng = printReadyPng;
      // See file header note — cloud-storage.js still needs to upload these.
      sessionState.individualPhotos = individualPhotos;
      if (typeof uploadProgress !== "undefined") uploadProgress.set(0.60);

      // The other assets above don't depend on the stitched video, but the
      // upload below does need the finished blob rather than the pending
      // promise, so wait for it here (it's likely already done or close to
      // it, since it started at the very top of this function).
      const finalStripVideo = await videoPromise;
      if (finalStripVideo) sessionState.finalStripVideo = finalStripVideo;
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

  /*
   * Re-encodes the 4 selected shots' photos as JPEG, trying progressively
   * lower quality and (if still too big) progressively smaller dimensions,
   * until the 4 blobs together total maxTotalBytes or less. Order matches
   * selectedShots (nulls/missing photos are skipped). Falls back to the
   * smallest attempt if the target still isn't met, rather than uploading
   * nothing.
   */
  async function _compressIndividualPhotos(selectedShots, maxTotalBytes) {
    const shots = (selectedShots || []).filter((s) => s && s.imageUrl);
    if (!shots.length) return [];

    const images = await Promise.all(shots.map((s) => stripModule.loadImage(s.imageUrl)));

    const encode = (img, quality, maxDim) => new Promise((resolve) => {
      if (!img) { resolve(null); return; }
      let w = img.naturalWidth, h = img.naturalHeight;
      if (maxDim && Math.max(w, h) > maxDim) {
        const ratio = maxDim / Math.max(w, h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    });

    const QUALITY_STEPS = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.35, 0.3];
    const MAX_DIM_STEPS = [null, 1600, 1280, 1024, 800];

    let lastAttempt = null;
    for (const maxDim of MAX_DIM_STEPS) {
      for (const quality of QUALITY_STEPS) {
        const blobs = await Promise.all(images.map((img) => encode(img, quality, maxDim)));
        lastAttempt = blobs;
        const total = blobs.reduce((sum, b) => sum + (b ? b.size : 0), 0);
        if (total <= maxTotalBytes) return blobs;
      }
    }
    // Couldn't hit the target even at the smallest/lowest settings tried —
    // use that smallest attempt anyway rather than uploading nothing.
    return lastAttempt || [];
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
