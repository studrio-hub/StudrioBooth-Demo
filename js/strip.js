/*
 * STRIP.JS — shared strip rendering + design catalog.
 * Used by Page 4 (selection preview) and Page 5 (design preview).
 * Also imported later by printing.js / qr.js for the final render.
 */

const STRIP_DESIGNS = [
  {
    id: "original-white",
    label: "Original White",
    cssClass: "theme-minimal-white",
    overlays: {
      "2x6": "assets/designs/2x6_Original_Frame.png",
      "4x6": "assets/designs/4x6_Original_Frame.png"
    }
  },
  {
    id: "princess-peaches",
    label: "Princess Peaches",
    cssClass: "theme-black-white",
    overlays: {
      "2x6": "assets/designs/2x6_Princess_Peach.png",
      "4x6": "assets/designs/4x6_Princess_Peach.png"
    }
  },
  {
    id: "wit",
    label: "Whatever it Takes",
    cssClass: "theme-retro",
    overlays: {
      "2x6": "assets/designs/2x6_WIT.png",
      "4x6": "assets/designs/4x6_WIT.png"
    }
  },
  {
    id: "xoxo",
    label: "XOXO",
    cssClass: "theme-pastel",
    overlays: {
      "2x6": "assets/designs/2x6_XOXO.png",
      "4x6": "assets/designs/4x6_XOXO.png"
    }
  }
];

const stripModule = {
  _imageCache: new Map(),

  getDesign(id) {
    return STRIP_DESIGNS.find((d) => d.id === id) || null;
  },

  loadImage(src) {
  if (this._imageCache.has(src)) return this._imageCache.get(src);
  const promise = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  this._imageCache.set(src, promise);
  return promise;
  },

  /* Crop-to-fill: fills the exact w x h box, cropping overflow — never stretches. */
  drawCropFill(ctx, img, x, y, w, h) {
    const imgRatio = img.width / img.height;
    const boxRatio = w / h;
    let sx, sy, sw, sh;

    if (imgRatio > boxRatio) {
      sh = img.height;
      sw = sh * boxRatio;
      sx = (img.width - sw) / 2;
      sy = 0;
    } else {
      sw = img.width;
      sh = sw / boxRatio;
      sx = 0;
      sy = (img.height - sh) / 2;
    }

    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  },

  /*
   * Composites the full pixel-perfect layout onto an off-DOM canvas at
   * EXACT export resolution (2400 x 3600 @ 600dpi). This single canvas
   * is used for both the live preview (CSS-scaled down) and the final
   * PNG export, so preview and export are guaranteed to match.
   *
   * Layer order: photos (exact coords) → frame design overlay ON TOP.
   */
  async compositeLayout({ frameType, selectedShots, designId }) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    const canvas = document.createElement("canvas");
    canvas.width = config.canvasWidth;
    canvas.height = config.canvasHeight;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height); // transparent base

    // Layer: photos in exact assigned positions
    const photoImages = await Promise.all(
      (selectedShots || []).map((shot) => (shot && shot.imageUrl ? this.loadImage(shot.imageUrl) : null))
    );

    config.photoSlots.forEach((slot, i) => {
      const img = photoImages[config.slotToPhotoIndex[i]];
      if (img) {
        this.drawCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h);
      } else {
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 4;
        ctx.strokeRect(slot.x, slot.y, slot.w, slot.h);
        ctx.restore();
      }
    });

    // Layer: frame design overlay ON TOP of the photos (borders/text/logos baked into the PNG)
    const design = this.getDesign(designId);
    if (design) {
      const overlayPath = design.overlays && design.overlays[frameType];
      if (overlayPath) {
        const overlayImg = await this.loadImage(overlayPath);
        if (overlayImg) {
          ctx.drawImage(overlayImg, 0, 0, canvas.width, canvas.height);
        } else {
          console.warn(`[stripModule] Overlay not found: ${overlayPath}`);
        }
      }
    }

    return canvas;
  },

  /* Renders into a container div as a single canvas, CSS-scaled for kiosk display. */
  async render(containerEl, opts) {
    const canvas = await this.compositeLayout(opts);
    containerEl.innerHTML = "";
    canvas.classList.add("layout-canvas");
    containerEl.appendChild(canvas);
    return canvas;
  },

  /* Full-resolution PNG export — exact 2400x3600, all layers composited. */
  async exportPNG(opts) {
    const canvas = await this.compositeLayout(opts);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  },

  // renderSwatchPicker(...) — leave exactly as it was, no changes needed there

  /* Renders the 7 selectable design swatches into a container (Page 5) */
  renderSwatchPicker(containerEl, currentDesignId, onSelect) {
    containerEl.innerHTML = "";
    STRIP_DESIGNS.forEach((design) => {
      const swatch = document.createElement("button");
      swatch.className = "design-swatch" + (design.id === currentDesignId ? " selected" : "");
      swatch.dataset.designId = design.id;

      const preview = document.createElement("div");
      preview.className = `design-swatch-preview ${design.cssClass}`;

      const name = document.createElement("span");
      name.className = "design-swatch-name";
      name.textContent = design.label;

      swatch.appendChild(preview);
      swatch.appendChild(name);

      swatch.addEventListener("click", () => {
        containerEl.querySelectorAll(".design-swatch").forEach((el) => el.classList.remove("selected"));
        swatch.classList.add("selected");
        onSelect(design.id);
      });

      containerEl.appendChild(swatch);
    });
  }
};

/*
 * DESIGN SELECTION LOGIC — Page 5
 * Lives in this file since it's tightly coupled to stripModule.
 */

const designModule = {
  els: {
    options: document.getElementById("designOptions"),
    previewContainer: document.getElementById("designPreviewContainer"),
    backBtn: document.getElementById("btnBackFromDesign"),
    nextBtn: document.getElementById("btnNextFromDesign")
  },

  init() {
    if (!sessionState.design) {
      sessionState.design = STRIP_DESIGNS[0].id; // default: Minimal White
    }

    stripModule.renderSwatchPicker(this.els.options, sessionState.design, (designId) => {
      sessionState.design = designId;
      this.renderPreview();
    });

    this.renderPreview();
    this.els.nextBtn.disabled = false;
  },

  renderPreview() {
    stripModule.render(this.els.previewContainer, {
      frameType: sessionState.frameType || "2x6",
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design
    });
  }
};

document.getElementById("btnBackFromDesign").addEventListener("click", () => goToPage("selection"));
document.getElementById("btnNextFromDesign").addEventListener("click", () => {
  goToPage("printing"); // page 6 — next batch
});