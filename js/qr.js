/*
 * QR.JS — Generates the gallery QR code and drives the upload progress bar.
 *
 * Changes from previous version:
 *   — uploadProgress.start() called by app.js before this runs
 *   — uploadProgress.set(fraction) called at key upload milestones
 *   — uploadProgress.complete() / uploadProgress.error() called on finish
 *   — Done button is now enabled ONLY inside uploadProgress.complete()
 *     (moved out of this file to keep the source of truth in one place)
 *
 * Progress milestones reported:
 *   0%   — generateAndRender() begins (set by app.js calling uploadProgress.start())
 *  20%   — Supabase upload begins (blobs handed off)
 *  60%   — strip PNG upload confirmed
 *  80%   — video upload confirmed (or skipped)
 *  90%   — session row inserted
 * 100%   — QR rendered, uploadProgress.complete() called → Done enabled
 */

const qrModule = (() => {
  let _resolve = null;

  /*
   * generateAndRender()
   * Called synchronously by app.js when the guest taps NEXT on the design page.
   * Sets sessionState.galleryUrlPromise BEFORE returning so printingModule.init()
   * can attach to it immediately on the same tick.
   */
  function generateAndRender() {
    // Expose a promise that resolves when the upload fully completes.
    sessionState.uploadPromise = new Promise((resolve) => { _resolve = resolve; });
    sessionState.galleryUrlPromise = sessionState.uploadPromise;

    // Run the actual upload work async (does not block the caller)
    _run().finally(() => {
      if (_resolve) { _resolve(); _resolve = null; }
    });
  }

  async function _run() {
    const qrUploading = document.getElementById("qrUploading");
    const qrWrap      = document.getElementById("qrWrap");

    // Show uploading spinner on the QR side
    if (qrUploading) qrUploading.style.display = "";

    // Progress: 20% — starting upload
    if (typeof uploadProgress !== "undefined") uploadProgress.set(0.20);

    try {
      if (!cloudStorage.isAvailable() || !sessionState.finalStripPng) {
        // No upload possible — generate a placeholder URL and bail gracefully
        _fallback();
        return;
      }

      // ── Upload strip PNG (milestone 60%) ──────────────────────────────
      const stripUrl = await cloudStorage.uploadBlob(
        sessionState.finalStripPng,
        `sessions/${sessionState.id}/strip.png`
      );
      if (typeof uploadProgress !== "undefined") uploadProgress.set(0.60);

      // ── Upload video (milestone 80%, skipped gracefully if absent) ────
      let videoUrl = null;
      if (sessionState.finalStripVideo) {
        const ext = sessionState.finalStripVideo.type?.includes("mp4") ? "mp4" : "webm";
        try {
          videoUrl = await cloudStorage.uploadBlob(
            sessionState.finalStripVideo,
            `sessions/${sessionState.id}/strip-live.${ext}`
          );
        } catch (videoErr) {
          console.warn("[qr] Video upload failed (non-fatal):", videoErr.message || videoErr);
        }
      }
      if (typeof uploadProgress !== "undefined") uploadProgress.set(0.80);

      // ── Upload print-ready PNG (if exists) ───────────────────────────
      let printReadyUrl = null;
      if (sessionState.printReadyPng) {
        try {
          printReadyUrl = await cloudStorage.uploadBlob(
            sessionState.printReadyPng,
            `sessions/${sessionState.id}/strip-print.png`
          );
        } catch (prErr) {
          console.warn("[qr] Print-ready upload failed (non-fatal):", prErr.message || prErr);
        }
      }

      // ── Insert session row (milestone 90%) ───────────────────────────
      try {
        const client = getSupabaseClient();
        await client.from("sessions").insert({
          id: sessionState.id,
          frame_type: sessionState.frameType,
          design: sessionState.design,
          final_strip_url: stripUrl,
          final_strip_video_url: videoUrl,
          print_ready_url: printReadyUrl
        });
      } catch (dbErr) {
        console.warn("[qr] Session DB insert failed (non-fatal):", dbErr.message || dbErr);
      }
      if (typeof uploadProgress !== "undefined") uploadProgress.set(0.90);

      // ── Render QR ────────────────────────────────────────────────────
      const galleryUrl = `${CLOUD_CONFIG.galleryBaseUrl}${sessionState.id}`;
      sessionState.galleryUrl = galleryUrl;
      _renderQR(galleryUrl);

      // Hide uploading spinner
      if (qrUploading) qrUploading.style.display = "none";

      // Progress: 100% — complete → enables Done button
      if (typeof uploadProgress !== "undefined") uploadProgress.complete();

    } catch (err) {
      console.error("[qr] Upload error:", err.message || err);
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
      // QRCode from qrcodejs CDN
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
    // No cloud available — generate a local session URL for staff to use manually
    const fallbackUrl = `${CLOUD_CONFIG.galleryBaseUrl}${sessionState.id}`;
    sessionState.galleryUrl = fallbackUrl;
    _renderQR(fallbackUrl);
    if (typeof uploadProgress !== "undefined") {
      uploadProgress.error("Upload unavailable — QR may not work");
    }
  }

  return { generateAndRender };
})();
