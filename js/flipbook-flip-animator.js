/*
 * FLIPBOOK-FLIP-ANIMATOR.JS
 *
 * Extracted from flipbook-preview.js so the same "flip through all 19
 * pages" animation can run in two places at once with independent DOM
 * targets and independent play/stop lifecycles:
 *   - the Flipbook Preview page (full-size stage)
 *   - the Print & QR page (small preview column, per Batch 2: "Show the
 *     Flipbook Preview" alongside the selected video)
 *
 * createFlipbookFlipAnimator(els) → { init(), stop() }
 *   els = { stage, templateImg, photoImg, frameCount (optional) }
 *
 * See the original flipbook-preview.js header for why both layers swap
 * together every tick instead of animating within a page.
 */

function createFlipbookFlipAnimator(els) {
  const FRAME_MS = 120; // ~8fps flip speed — full 19-frame loop ≈ 2.3s
  let frameUrls = [];
  let templateCropUrls = [];
  let idx = 0;
  let intervalId = null;

  function positionLayers() {
    if (els.stage) {
      els.stage.style.aspectRatio = `${SLOT_W} / ${SLOT_H}`;
    }
    [els.templateImg, els.photoImg].forEach((el) => {
      if (!el) return;
      el.style.left = "0";
      el.style.top = "0";
      el.style.width = "100%";
      el.style.height = "100%";
    });
  }

  async function buildTemplateCrops() {
    templateCropUrls = [];
    if (typeof flipbookGenerator === "undefined") return;

    const urls = flipbookGenerator.getTemplateUrls();
    const [a4Page1Img, a4Page2Img] = await Promise.all([
      flipbookGenerator._loadImage(urls.a4Page1Url),
      flipbookGenerator._loadImage(urls.a4Page2Url)
    ]);
    const overlays = { a4Page1: a4Page1Img, a4Page2: a4Page2Img };

    for (let i = 0; i < FLIPBOOK_TOTAL_FRAMES; i++) {
      const pageSlot = flipbookLayout.getPageSlot(i);
      const overlayImg = pageSlot ? overlays[pageSlot.sheet] : null;
      templateCropUrls.push(cropToDataUrl(overlayImg, pageSlot));
    }
  }

  function cropToDataUrl(overlayImg, slot) {
    if (!overlayImg || !slot) return "";
    const canvas = document.createElement("canvas");
    canvas.width = slot.w;
    canvas.height = slot.h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(overlayImg, slot.x, slot.y, slot.w, slot.h, 0, 0, slot.w, slot.h);
    return canvas.toDataURL("image/png");
  }

  function renderFrame() {
    if (els.photoImg && frameUrls.length) els.photoImg.src = frameUrls[idx];
    if (els.templateImg && templateCropUrls.length) els.templateImg.src = templateCropUrls[idx] || "";
    if (els.frameCount) els.frameCount.textContent = `${idx + 1} / ${frameUrls.length}`;
  }

  function teardownUrls() {
    frameUrls.forEach((u) => URL.revokeObjectURL(u));
    frameUrls = [];
    templateCropUrls = [];
  }

  return {
    async init() {
      teardownUrls();
      frameUrls = (sessionState.flipbookFrames || []).map((blob) => URL.createObjectURL(blob));
      idx = 0;
      positionLayers();
      await buildTemplateCrops();
      renderFrame();
      this.play();
    },
    play() {
      this.stop();
      if (!frameUrls.length) return;
      intervalId = setInterval(() => {
        idx = (idx + 1) % frameUrls.length;
        renderFrame();
      }, FRAME_MS);
    },
    stop() {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    },
    teardown() {
      this.stop();
      teardownUrls();
    }
  };
}
