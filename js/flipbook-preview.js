/*
 * FLIPBOOK-PREVIEW.JS — the "Flipbook Preview" page.
 *
 * The actual frame-cycling engine lives in flipbook-flip-animator.js so
 * the Print & QR page can run its own independent copy of the same
 * animation (Batch 2: "Show the Flipbook Preview" there too).
 *
 * On NEXT: this is the flipbook flow's equivalent of the standard photo
 * flow's "Design → Print" handoff (_origDesignNext in app.js) — it starts
 * the gallery upload (flipbook-qr.js, NOT qr.js — kept fully separate
 * from the photo/strip upload path per Batch 2) and only then hands off
 * to printingModule.
 */

const flipbookPreviewModule = createFlipbookFlipAnimator({
  stage:       document.getElementById("flipbookPreviewStage"),
  templateImg: document.getElementById("flipbookPreviewTemplateImg"),
  photoImg:    document.getElementById("flipbookPreviewPhotoImg"),
  frameCount:  document.getElementById("flipbookPreviewFrameCount")
});

document.getElementById("btnNextFromFlipbookPreview")?.addEventListener("click", async () => {
  kioskTimer.hide();
  flipbookPreviewModule.stop();
  sessionState._isFlipbook = true;

  if (typeof audioManager !== "undefined") audioManager.playPrintSfx();

  // Reset + start progress bar immediately (generic UI, shared with the
  // photo flow — see uploadProgress in app.js).
  uploadProgress.start();
  // Fire the flipbook-specific gallery upload (assigns
  // sessionState.galleryUrlPromise synchronously, same contract qr.js
  // uses, so printing.js's existing polling logic needs no changes).
  if (typeof flipbookQr !== "undefined") flipbookQr.generateAndRender();

  goToPage("printing");
  if (typeof printingModule !== "undefined") await printingModule.init();
});
