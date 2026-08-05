/*
 * QR.JS — QR code generation + digital gallery abstraction.
 *
 * mediaStorage.createGallery() uploads via cloudStorage (Supabase).
 * There is no local-only fallback — the gallery is cloud-only project-wide
 * (see gallery.js / cloud-storage.js). If Supabase is unavailable, the QR
 * still resolves to the deterministic gallery URL so printing/QR-baking
 * can proceed, it just won't have media behind it until Supabase is fixed.
 *
 * Gallery URL format: https://studrio.cc/g/#<sessionId>
 * e.g. https://studrio.cc/g/#2ydgshd
 *
 * RELIABILITY CONTRACT: sessionState.galleryUrlPromise MUST resolve —
 * never reject, never hang — no matter what happens during export or
 * upload. printing.js awaits this promise to know when to hide its
 * "Uploading…" indicator and start the 60s kiosk timer.
 *
 * UPLOAD CONTRACT: sessionState.uploadPromise holds the raw cloud upload
 * in flight. app.js resetSessionAndRestart() waits for this (up to a
 * short grace period) before resetting, so blobs are never revoked while
 * an upload is still writing to Supabase.
 *
 * COMPRESSION: finalStripPng is converted to JPEG at 85% quality before
 * uploading to the gallery. This reduces the gallery copy from ~4.5 MB
 * (PNG) to ~300–600 KB (JPEG) with no visible quality loss at phone screen
 * resolution. printReadyPng stays as PNG — it is the print master and
 * needs to be lossless.
 */

const GALLERY_BASE_URL = "https://studrio.cc/g/#";
const UPLOAD_TIMEOUT_MS = 60000; // 60s — enough for even slow venue WiFi

/*
 * Converts a PNG/WebP/any-format blob to JPEG at the given quality.
 * Used to compress the gallery copy of the strip before uploading;
 * the print-ready copy is intentionally left as lossless PNG.
 */
async function compressToJpeg(blob, quality = 0.85) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

const mediaStorage = {
  async createGallery(sessionData) {
    if (cloudStorage.isAvailable()) {
      return cloudStorage.saveSession(sessionData);
    }
    console.warn("[mediaStorage] Cloud storage unavailable — QR will point to a gallery URL with no uploaded media. Check cloud-storage.js CLOUD_CONFIG.");
    return { url: `${GALLERY_BASE_URL}${sessionData.id}` };
  }
};

const qrModule = {
  async generateAndRender() {
    const container = document.getElementById("qrCodeCanvas");
    container.innerHTML = "";

    // galleryUrlPromise — printing.js waits on this to show the QR panel.
    // Resolved as soon as we have a URL (before upload finishes).
    let resolveGalleryUrl;
    sessionState.galleryUrlPromise = new Promise((resolve) => { resolveGalleryUrl = resolve; });

    // uploadPromise — app.js resetSessionAndRestart() waits on this so the
    // reset never fires while a Supabase upload is still in progress.
    // Resolved when the upload confirms (or definitively fails/times out).
    let resolveUpload;
    sessionState.uploadPromise = new Promise((resolve) => { resolveUpload = resolve; });

    // Deterministic fallback URL — computed synchronously with zero async
    // work, so there is always something valid even if everything else fails.
    const fallbackGalleryUrl = `${GALLERY_BASE_URL}${sessionState.id}`;
    let resolvedGalleryUrl = fallbackGalleryUrl;

    try {
      const finalStripPng = await stripModule.exportPNG({
        frameType: sessionState.frameType,
        selectedShots: sessionState.selectedShots,
        designId: sessionState.design
      });

      // Compress the gallery copy to JPEG before uploading.
      // The print-ready copy below stays as PNG (lossless for print quality).
      // JPEG at 85% quality is visually indistinguishable on a phone screen
      // and typically 6–10× smaller than the equivalent PNG.
      let finalStripJpeg = null;
      try {
        finalStripJpeg = await compressToJpeg(finalStripPng, 0.85);
        console.log(`[qrModule] Compressed gallery strip: ${(finalStripPng.size / 1024).toFixed(0)} KB PNG → ${(finalStripJpeg.size / 1024).toFixed(0)} KB JPEG`);
      } catch (e) {
        console.warn("[qrModule] JPEG compression failed, falling back to original PNG:", e);
        finalStripJpeg = finalStripPng;
      }

      const perShotDurationMs = (shootingModule.countdownSeconds * 1000) + 600;
      const finalStripVideo = await stripModule.exportVideoStrip({
        frameType: sessionState.frameType,
        selectedShots: sessionState.selectedShots,
        designId: sessionState.design,
        durationMs: perShotDurationMs + 500
      });

      let printReadyPng = null;
      try {
        printReadyPng = await stripModule.exportPrintPNG({
          frameType: sessionState.frameType,
          selectedShots: sessionState.selectedShots,
          designId: sessionState.design,
          qrText: fallbackGalleryUrl
        });
      } catch (e) {
        console.warn("[qrModule] Could not prepare print-ready (QR-baked) copy:", e);
      }

      // Resolve the gallery URL immediately using the fallback — printing.js
      // can show the QR and start the timer without waiting for the upload.
      resolvedGalleryUrl = fallbackGalleryUrl;
      sessionState.galleryUrl = resolvedGalleryUrl;
      resolveGalleryUrl(resolvedGalleryUrl);

      // Now kick off the actual upload. This runs after the QR is already
      // shown, so the guest isn't waiting on it. The upload promise is stored
      // on sessionState so resetSessionAndRestart() can wait for it to finish
      // before tearing down, ensuring blobs are never revoked mid-upload.
      const galleryPayload = {
        id: sessionState.id,
        frameType: sessionState.frameType,
        design: sessionState.design,
        finalStripPng: finalStripJpeg,  // compressed JPEG for gallery
        finalStripVideo,
        printReadyPng,                  // lossless PNG for print/reprint
        photos: sessionState.selectedShots.map((s) => ({
          id: s.id,
          image: s.image
        }))
      };

      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), UPLOAD_TIMEOUT_MS)
      );

      const result = await Promise.race([
        mediaStorage.createGallery(galleryPayload),
        timeout
      ]);

      if (result && result.timedOut) {
        console.warn(`[qrModule] Upload did not finish within ${UPLOAD_TIMEOUT_MS / 1000}s — session reset will proceed anyway.`);
      } else {
        console.log("[qrModule] Upload complete:", result && result.url);
      }
    } catch (e) {
      console.error("[qrModule] generateAndRender failed:", e);
      // Ensure galleryUrlPromise is always resolved even if we threw early
      if (!sessionState.galleryUrl) {
        sessionState.galleryUrl = resolvedGalleryUrl;
        resolveGalleryUrl(resolvedGalleryUrl);
      }
    } finally {
      // Always resolve uploadPromise so resetSessionAndRestart() is never
      // blocked permanently, even after an error or timeout.
      resolveUpload();
    }

    try {
      new QRCode(container, {
        text: resolvedGalleryUrl,
        width: 220,
        height: 220,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.L
      });
    } catch (e) {
      console.error("[qrModule] QR render failed:", e);
    }
  }
};
