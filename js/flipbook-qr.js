/*
 * FLIPBOOK-QR.JS
 *
 * Deliberately NOT qr.js — Batch 2 asks to keep the flipbook system
 * separate from the existing photo/strip products, and qr.js's upload
 * packages photo-specific sessionState fields (finalStripPng /
 * finalStripVideo / printReadyPng) that a flipbook session never
 * populates. This module uploads the flipbook's own artifacts instead:
 *
 *   finalStripVideo — the guest's SELECTED video, with the active
 *     design's Cover Page template art baked on top (via
 *     flipbookGenerator.compositeCoverVideo()) — same framing the guest
 *     saw on Video Selection / Print & QR. Falls back to the plain
 *     original clip if the design has no Cover Page template, or if
 *     compositing fails for any reason (the guest should never be left
 *     without a download because of an overlay problem).
 *   finalStripPng — the guest's SELECTED cover photo, same overlay
 *     treatment via flipbookGenerator.compositeCoverPhoto().
 *
 * These map onto cloudStorage's existing generic fields — gallery.js's
 * "Download Photo" / "Download Video" buttons and cloud-storage.js's
 * upload/compression pipeline are unchanged; they don't know or care
 * these came from flipbook's own compositing step.
 *
 * Reuses cloudStorage.saveSession()'s generic upload/session-row/offline-
 * queue plumbing (cloud-storage.js is shared infrastructure, not a
 * photo-specific module) so flipbook sessions show up in the same
 * `sessions` table / admin dashboard / gallery page as everything else —
 * only the print pipeline and this upload trigger are separate.
 *
 * Contract matches qr.js exactly so printing.js needs no special-casing:
 *   - generateAndRender() assigns sessionState.galleryUrlPromise
 *     synchronously
 *   - calls uploadProgress.complete() / .error() on the shared
 *     app.js uploadProgress module
 */

const flipbookQr = {
  generateAndRender() {
    const promise = this._run();
    sessionState.galleryUrlPromise = promise;
    return promise;
  },

  async _run() {
    const clip = sessionState.selectedFlipbookVideo;
    if (!clip || !clip.video) {
      uploadProgress.error("No video selected");
      throw new Error("[flipbookQr] No selected flipbook video to upload");
    }

    try {
      const [finalStripPng, finalStripVideo] = await Promise.all([
        (typeof flipbookGenerator !== "undefined"
          ? flipbookGenerator.compositeCoverPhoto()
          : Promise.resolve(sessionState.selectedFlipbookCoverPhoto?.image || null)
        ).catch((e) => {
          console.warn("[flipbookQr] Cover photo compositing failed, uploading original:", e.message || e);
          return sessionState.selectedFlipbookCoverPhoto?.image || null;
        }),
        (typeof flipbookGenerator !== "undefined"
          ? flipbookGenerator.compositeCoverVideo()
          : Promise.resolve(clip.video)
        ).catch((e) => {
          console.warn("[flipbookQr] Video compositing failed, uploading original:", e.message || e);
          return clip.video;
        })
      ]);

      const { url } = await cloudStorage.saveSession({
        id: sessionState.id,
        frameType: "flipbook",
        design: sessionState.design,
        finalStripPng,   // Cover Page photo, overlay baked in (or original)
        finalStripVideo  // selected video, overlay baked in (or original)
      });

      sessionState.galleryUrl = url;
      this._renderQrCode(url);
      uploadProgress.complete();
      return url;
    } catch (e) {
      console.error("[flipbookQr] Upload failed:", e.message || e);
      uploadProgress.error("Upload failed");
      throw e;
    }
  },

  _renderQrCode(url) {
    const el = document.getElementById("qrCodeCanvas");
    if (!el || typeof QRCode === "undefined") return;
    el.innerHTML = "";
    new QRCode(el, {
      text: url,
      width: 180,
      height: 180,
      correctLevel: QRCode.CorrectLevel.M
    });
  }
};
