/*
 * STRIP.JS — shared strip rendering + design catalog.
 * Used by Page 4 (selection preview) and Page 5 (design preview).
 * Also imported later by printing.js / qr.js for the final render.
 */

let STRIP_DESIGNS = [];

/*
 * Renders a QR code into a detached, invisible container using the same
 * qrcode.js library Page 6 already uses for the on-screen QR, then hands
 * back the resulting canvas/img so it can be drawn directly onto a print
 * canvas at exact pixel coordinates. Never touches the visible DOM.
 */
/*
 * Renders a QR code by drawing its module grid ourselves, directly onto a
 * canvas, instead of relying on qrcode.js's own small-size rendering
 * (which tends to blur/anti-alias edges at tiny print sizes and hurts
 * scan reliability). `_oQRCode` is the library's internal data model —
 * a widely-used technique for this specific library to get pixel-perfect
 * control over module size, quiet zone, and contrast.
 */
function generateQrCanvas(text, size = 200, options = {}) {
  const {
    correctLevel = QRCode.CorrectLevel.L, // fewest modules → largest, most scannable squares
    quietModules = 2                       // thin blank border baked inside the same footprint
  } = options;

  const holder = document.createElement("div");
  const widget = new QRCode(holder, { text, width: 1, height: 1, correctLevel });
  const model = widget._oQRCode;

  if (!model || typeof model.isDark !== "function") {
    // Fallback in case the library's internals ever change — still
    // functional, just back to the library's own (softer) rendering.
    console.warn("[stripModule] QR internal module grid unavailable, falling back to library's own render.");
    const fallbackHolder = document.createElement("div");
    new QRCode(fallbackHolder, { text, width: size, height: size, correctLevel });
    return fallbackHolder.querySelector("canvas") || document.createElement("canvas");
  }

  const moduleCount = model.moduleCount;
  const totalModules = moduleCount + quietModules * 2;
  const pixelsPerModule = Math.max(1, Math.round(size / totalModules));
  const canvasSize = pixelsPerModule * totalModules;

  const canvas = document.createElement("canvas");
  canvas.width = canvasSize;
  canvas.height = canvasSize;
  const ctx = canvas.getContext("2d");

  // Solid white base doubles as the quiet zone — maximum black/white
  // contrast for the scanner, no gray anti-aliased edges.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvasSize, canvasSize);

  ctx.fillStyle = "#000000";
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (model.isDark(row, col)) {
        const x = (col + quietModules) * pixelsPerModule;
        const y = (row + quietModules) * pixelsPerModule;
        ctx.fillRect(x, y, pixelsPerModule, pixelsPerModule);
      }
    }
  }

  return canvas;
}

const stripModule = {
  _imageCache: new Map(),

  getDesign(id) {
    return STRIP_DESIGNS.find((d) => String(d.id) === String(id)) || null;
  },

  /*
   * Called by boot.js after assetSync.init() completes.
   * Maps the Supabase template rows into the format strip.js expects.
   */
  initDesigns() {
    if (typeof assetSync === "undefined") return;
    const templates = assetSync.getTemplates();
    STRIP_DESIGNS = templates.map(t => ({
      id: t.id,
      label: t.name,
      cssClass: `theme-${t.id}`,
      thumbnail: t.thumbnailUrl,
      overlays: {
        "2x6": t.overlayUrl2x6,
        "4x6": t.overlayUrl4x6
      }
    }));
    console.log(`[stripModule] Loaded ${STRIP_DESIGNS.length} designs from assetSync.`);
    this.preloadDesignOverlays();
    this._updateFrameAvailability();
  },

  /*
   * Hides frame size cards on Page 2 when no uploaded template has an
   * overlay for that size. If a size has zero templates, its card and
   * any existing selection are hidden so guests can't choose it.
   */
  _updateFrameAvailability() {
    const has2x6 = STRIP_DESIGNS.some(d => d.overlays && d.overlays["2x6"]);
    const has4x6 = STRIP_DESIGNS.some(d => d.overlays && d.overlays["4x6"]);

    const card2x6 = document.getElementById("frameCard2x6");
    const card4x6 = document.getElementById("frameCard4x6");

    if (card2x6) {
      card2x6.style.display = has2x6 ? "" : "none";
      // If this frame type was previously selected but is now unavailable, deselect it
      if (!has2x6 && typeof sessionState !== "undefined" && sessionState.frameType === "2x6") {
        sessionState.frameType = null;
        card2x6.classList.remove("selected");
        const nextBtn = document.getElementById("btnNextFromFrame");
        if (nextBtn) nextBtn.disabled = true;
      }
    }

    if (card4x6) {
      card4x6.style.display = has4x6 ? "" : "none";
      if (!has4x6 && typeof sessionState !== "undefined" && sessionState.frameType === "4x6") {
        sessionState.frameType = null;
        card4x6.classList.remove("selected");
        const nextBtn = document.getElementById("btnNextFromFrame");
        if (nextBtn) nextBtn.disabled = true;
      }
    }

    // Auto-select if only one size is available and nothing is selected yet
    if (typeof sessionState !== "undefined" && !sessionState.frameType) {
      if (has2x6 && !has4x6 && card2x6) {
        // Only 2x6 available — auto-select it but don't advance the page
        console.log("[stripModule] Only 2x6 templates available — auto-selecting.");
      } else if (has4x6 && !has2x6 && card4x6) {
        console.log("[stripModule] Only 4x6 templates available — auto-selecting.");
      }
    }

    console.log(`[stripModule] Frame availability — 2x6: ${has2x6}, 4x6: ${has4x6}`);
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
   *
   * singleStrip (default false) — when true and frameType is "2x6",
   * the returned canvas is cropped to the first strip's width only
   * (half of canvasWidth). Used by the digital gallery exports so
   * guests download a single clean strip, not the two-up print layout.
   * Print exports always pass singleStrip:false.
   */
  /*
   * _isSingleStripOverlay — detects whether a 2×6 overlay PNG was uploaded
   * as a single strip (1200×3600 or any image whose width ≤ half the full
   * sheet width). Single-strip uploads are mirrored side-by-side at print time.
   */
  _isSingleStripOverlay(overlayImg, frameType) {
    if (frameType !== "2x6") return false;
    // Full sheet for 2×6 is 2400px wide; a single strip is ~1200px wide.
    // We treat the overlay as single-strip when its naturalWidth is less
    // than 75% of the full sheet width (2400 * 0.75 = 1800px).
    return overlayImg && overlayImg.naturalWidth > 0 && overlayImg.naturalWidth < 1800;
  },

  async compositeLayout({ frameType, selectedShots, designId, singleStrip = false }) {
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
          if (this._isSingleStripOverlay(overlayImg, frameType)) {
            // Single-strip upload (new format): tile it twice side-by-side
            // to fill the full 2400×3600 print sheet.
            const stripW = config.canvasWidth / 2;
            ctx.drawImage(overlayImg, 0, 0, stripW, config.canvasHeight);
            ctx.drawImage(overlayImg, stripW, 0, stripW, config.canvasHeight);
          } else {
            // Full double-strip overlay (legacy format): draw at full width
            ctx.drawImage(overlayImg, 0, 0, canvas.width, canvas.height);
          }
        } else {
          console.warn(`[stripModule] Overlay not found: ${overlayPath}`);
        }
      }
    }

    // If the caller only wants one strip (digital gallery download), crop
    // the 2x6 two-up canvas down to the left half after compositing.
    // The full-width overlay PNG was already drawn above at full width so
    // it renders correctly; we then blit the left strip portion onto a new
    // half-width canvas and return that instead.
    if (singleStrip && frameType === "2x6") {
      const copies = 2;
      const stripW = Math.round(canvas.width / copies);
      const cropped = document.createElement("canvas");
      cropped.width  = stripW;
      cropped.height = canvas.height;
      cropped.getContext("2d").drawImage(canvas, 0, 0, stripW, canvas.height, 0, 0, stripW, canvas.height);
      return cropped;
    }

    return canvas;
  },

  /*
   * Kick off background loading of every design's overlay PNG as soon as
   * this file runs (well before the guest ever reaches Page 5). By the
   * time they get there, the images are already decoded/cached, so
   * swatch thumbnails composite almost instantly.
   */
  preloadDesignOverlays() {
    STRIP_DESIGNS.forEach((design) => {
      if (design.overlays && design.overlays["2x6"]) this.loadImage(design.overlays["2x6"]);
      if (design.overlays && design.overlays["4x6"]) this.loadImage(design.overlays["4x6"]);
    });
  },

  /*
   * Lightweight version of compositeLayout for small on-screen swatch
   * thumbnails — draws at a fraction of the full 2400x3600 export
   * resolution, which is far cheaper to rasterize since it's never
   * printed or exported, only shown at a few hundred pixels wide.
   */
  async compositeLayoutScaled({ frameType, selectedShots, designId }, scale = 0.18) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(config.canvasWidth * scale);
    canvas.height = Math.round(config.canvasHeight * scale);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const photoImages = await Promise.all(
      (selectedShots || []).map((shot) => (shot && shot.imageUrl ? this.loadImage(shot.imageUrl) : null))
    );

    config.photoSlots.forEach((slot, i) => {
      const img = photoImages[config.slotToPhotoIndex[i]];
      const x = slot.x * scale, y = slot.y * scale, w = slot.w * scale, h = slot.h * scale;
      if (img) {
        this.drawCropFill(ctx, img, x, y, w, h);
      } else {
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
      }
    });

    const design = this.getDesign(designId);
    if (design) {
      const overlayPath = design.overlays && design.overlays[frameType];
      if (overlayPath) {
        const overlayImg = await this.loadImage(overlayPath);
        if (overlayImg) {
          if (this._isSingleStripOverlay(overlayImg, frameType)) {
            // Single-strip upload: tile twice for the scaled preview
            const stripW = canvas.width / 2;
            ctx.drawImage(overlayImg, 0, 0, stripW, canvas.height);
            ctx.drawImage(overlayImg, stripW, 0, stripW, canvas.height);
          } else {
            ctx.drawImage(overlayImg, 0, 0, canvas.width, canvas.height);
          }
        }
      }
    }

    return canvas;
  },

  /*
   * _getOriginalDesign — returns the "Original" template (first enabled design,
   * preferring one named "Original"). Used as the default overlay on the
   * selection preview (Page 4) when no specific design has been chosen yet.
   */
  _getOriginalDesign() {
    // First look for an explicitly-named "Original" template
    const named = STRIP_DESIGNS.find(d => d.label && d.label.toLowerCase() === "original");
    if (named) return named;
    // Fall back to the first available design
    return STRIP_DESIGNS[0] || null;
  },

  /*
   * PREVIEW-ONLY composite — used by Page 4 (selection) and Page 5 (design)
   * strip preview columns. Never used for printing or export.
   *
   * For 2×6: produces a TRUE single-strip canvas (half the sheet width).
   *   - Only the first copy's photo slots are drawn (no doubling).
   *   - Photo coordinates are offset-corrected to fit [0, stripW] × [0, H].
   *   - The overlay is sampled from the left-half of the full overlay PNG.
   * For 4×6: delegates to compositeLayout() as usual — no change.
   *
   * Layer order (Page 4 specific, 3-layer spec):
   *   1 (bottom) — frame thumbnail selected on Page 1 (solid background reference)
   *   2 (middle) — photos only, no overlay baked in
   *   3 (top)    — Original.png overlay (from Admin Panel)
   *
   * Page 5 uses the selected design overlay instead of always forcing Original.
   *
   * Print output is 100% unaffected — compositeLayout() is unchanged.
   */
  async compositeLayoutPreview({ frameType, selectedShots, designId }) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    if (frameType === "4x6") {
      // ── 4×6: full canvas (no duplication), 3-layer spec ──────────────────
      const canvasW = config.canvasWidth;
      const canvasH = config.canvasHeight;

      const canvas = document.createElement("canvas");
      canvas.width  = canvasW;
      canvas.height = canvasH;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvasW, canvasH);

      // ── Layer 1 (bottom): 4×6 strip thumbnail background ─────────────────
      const thumbSrc4x6 = "assets/designs/thumbnail/4x6_Strip_Thumbnail.png";
      try {
        const thumbImg = await this.loadImage(thumbSrc4x6);
        if (thumbImg) {
          this.drawCropFill(ctx, thumbImg, 0, 0, canvasW, canvasH);
          // Soft white wash so photos on top are clearly readable
          ctx.save();
          ctx.globalAlpha = 0.18;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvasW, canvasH);
          ctx.restore();
        }
      } catch (_) { /* thumbnail optional */ }

      // ── Layer 2 (middle): captured photos ────────────────────────────────
      const photoImages = await Promise.all(
        (selectedShots || []).map((shot) =>
          shot && shot.imageUrl ? this.loadImage(shot.imageUrl) : Promise.resolve(null)
        )
      );
      config.photoSlots.forEach((slot, i) => {
        const img = photoImages[config.slotToPhotoIndex[i]];
        if (img) {
          this.drawCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h);
        } else {
          ctx.save();
          ctx.strokeStyle = "rgba(180,180,180,0.5)";
          ctx.lineWidth = 3;
          ctx.strokeRect(slot.x + 2, slot.y + 2, slot.w - 4, slot.h - 4);
          ctx.restore();
        }
      });

      // ── Layer 3 (top): template overlay ──────────────────────────────────
      // Page 4 (no designId) → Original; Page 5 → selected designId.
      const overlayDesignId4x6 = designId || (this._getOriginalDesign() || {}).id;
      const design4x6 = this.getDesign(overlayDesignId4x6);
      if (design4x6) {
        const overlayPath = design4x6.overlays && design4x6.overlays["4x6"];
        if (overlayPath) {
          const overlayImg = await this.loadImage(overlayPath);
          if (overlayImg) {
            ctx.drawImage(overlayImg, 0, 0, canvasW, canvasH);
          }
        }
      }

      return canvas;
    }

    // ── 2×6: single-strip canvas ────────────────────────────────────────────
    // The full sheet is 2400×3600. One strip is 1200×3600.
    const copies = 2;
    const stripW = Math.round(config.canvasWidth / copies);
    const stripH = config.canvasHeight;

    const canvas = document.createElement("canvas");
    canvas.width  = stripW;
    canvas.height = stripH;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, stripW, stripH);

    // ── Layer 1 (bottom): 2×6 strip thumbnail background ───────────────────
    const thumbSrc = "assets/designs/thumbnail/2x6_Strip_Thumbnail.png";
    try {
      const thumbImg = await this.loadImage(thumbSrc);
      if (thumbImg) {
        this.drawCropFill(ctx, thumbImg, 0, 0, stripW, stripH);
        ctx.save();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, stripW, stripH);
        ctx.restore();
      }
    } catch (_) { /* thumbnail is optional — skip silently */ }

    // ── Layer 2 (middle): photos only, copy-0 slots ──────────────────────────
    const slotsPerCopy = Math.round(config.photoSlots.length / copies);
    const copy0Slots   = config.photoSlots.slice(0, slotsPerCopy);

    const photoImages = await Promise.all(
      (selectedShots || []).map((shot) =>
        shot && shot.imageUrl ? this.loadImage(shot.imageUrl) : Promise.resolve(null)
      )
    );

    copy0Slots.forEach((slot, i) => {
      const img = photoImages[config.slotToPhotoIndex[i]];
      if (img) {
        this.drawCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h);
      } else {
        ctx.save();
        ctx.strokeStyle = "rgba(180,180,180,0.5)";
        ctx.lineWidth = 3;
        ctx.strokeRect(slot.x + 2, slot.y + 2, slot.w - 4, slot.h - 4);
        ctx.restore();
      }
    });

    // ── Layer 3 (top): template overlay ─────────────────────────────────────
    const overlayDesignId = designId || (this._getOriginalDesign() || {}).id;
    const design = this.getDesign(overlayDesignId);
    if (design) {
      const overlayPath = design.overlays && design.overlays["2x6"];
      if (overlayPath) {
        const overlayImg = await this.loadImage(overlayPath);
        if (overlayImg) {
          const isSingle = this._isSingleStripOverlay(overlayImg, "2x6");
          if (isSingle) {
            ctx.drawImage(overlayImg, 0, 0, stripW, stripH);
          } else {
            const srcW = Math.round(overlayImg.naturalWidth  / 2);
            const srcH = overlayImg.naturalHeight;
            ctx.drawImage(overlayImg, 0, 0, srcW, srcH, 0, 0, stripW, stripH);
          }
        }
      }
    }

    return canvas;
  },

  /*
   * Renders into a container div as a single canvas, CSS-scaled for kiosk display.
   *
   * For Page 4 (stripPreviewContainer) and Page 5 (designPreviewContainer):
   *   - Uses compositeLayoutPreview() which produces a true single-strip canvas
   *     for 2×6 (no doubling). No CSS clip wrapper is needed.
   *   - Print paths always use compositeLayout() — this method is never called
   *     by exportPNG / exportPrintPNG / printing.js.
   *
   * For all other containers: compositeLayout() as before.
   */
  async render(containerEl, opts) {
    containerEl.innerHTML = "";

    const isPreviewCol =
      containerEl.id === "stripPreviewContainer" ||
      containerEl.id === "designPreviewContainer";

    let canvas;

    if (isPreviewCol) {
      /*
       * Two-layer preview so CSS filter can be applied only to photos,
       * not the frame/template overlay.
       *
       * Layer A (bottom): photos-only canvas — receives CSS filter
       * Layer B (top):    overlay-only canvas — never filtered
       *
       * Both are positioned absolutely inside a relative clip wrapper
       * that matches the canvas dimensions.
       */
      const photoCanvas = await this._compositePhotosOnly(opts);
      const overlayCanvas = await this._compositeOverlayOnly(opts);

      photoCanvas.classList.add("layout-canvas", "layout-canvas-preview", "layout-canvas-photos");
      overlayCanvas.classList.add("layout-canvas-overlay");

      const clip = document.createElement("div");
      clip.className = "single-strip-clip";
      clip.dataset.frame = opts.frameType === "2x6" ? "preview-single" : (opts.frameType || "4x6");

      // Wrapper is positioned relative; both canvases fill it absolutely
      clip.style.position = "relative";
      photoCanvas.style.position = "relative"; // base layer
      overlayCanvas.style.position = "absolute";
      overlayCanvas.style.inset = "0";
      overlayCanvas.style.width = "100%";
      overlayCanvas.style.height = "100%";
      overlayCanvas.style.pointerEvents = "none";

      clip.appendChild(photoCanvas);
      clip.appendChild(overlayCanvas);
      containerEl.appendChild(clip);

      // Return the photos canvas as the "main" canvas reference
      canvas = photoCanvas;
    } else {
      // Full composite for all non-preview uses (printing.js, video export, etc.)
      canvas = await this.compositeLayout(opts);
      canvas.classList.add("layout-canvas");
      containerEl.appendChild(canvas);
    }

    return canvas;
  },

  /*
   * _compositePhotosOnly — renders only the photo slots and thumbnail
   * background onto a canvas for the preview column. No overlay.
   * Used by render() for the filterable bottom layer.
   */
  async _compositePhotosOnly({ frameType, selectedShots }) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    const is2x6 = frameType === "2x6";
    const copies = is2x6 ? 2 : 1;
    const canvasW = is2x6 ? Math.round(config.canvasWidth / copies) : config.canvasWidth;
    const canvasH = config.canvasHeight;

    const canvas = document.createElement("canvas");
    canvas.width  = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvasW, canvasH);

    // Thumbnail background layer
    const thumbSrc = is2x6
      ? "assets/designs/thumbnail/2x6_Strip_Thumbnail.png"
      : "assets/designs/thumbnail/4x6_Strip_Thumbnail.png";
    try {
      const thumbImg = await this.loadImage(thumbSrc);
      if (thumbImg) {
        this.drawCropFill(ctx, thumbImg, 0, 0, canvasW, canvasH);
        ctx.save();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvasW, canvasH);
        ctx.restore();
      }
    } catch (_) {}

    // Photo slots
    const slotsPerCopy = is2x6 ? Math.round(config.photoSlots.length / copies) : config.photoSlots.length;
    const slots = config.photoSlots.slice(0, slotsPerCopy);

    const photoImages = await Promise.all(
      (selectedShots || []).map((shot) =>
        shot && shot.imageUrl ? this.loadImage(shot.imageUrl) : Promise.resolve(null)
      )
    );

    slots.forEach((slot, i) => {
      const img = photoImages[config.slotToPhotoIndex[i]];
      if (img) {
        this.drawCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h);
      } else {
        ctx.save();
        ctx.strokeStyle = "rgba(180,180,180,0.5)";
        ctx.lineWidth = 3;
        ctx.strokeRect(slot.x + 2, slot.y + 2, slot.w - 4, slot.h - 4);
        ctx.restore();
      }
    });

    return canvas;
  },

  /*
   * _compositeOverlayOnly — renders only the template overlay onto a
   * transparent canvas for the preview column. No photos.
   * Used by render() for the non-filterable top layer.
   */
  async _compositeOverlayOnly({ frameType, designId }) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    const is2x6 = frameType === "2x6";
    const copies = is2x6 ? 2 : 1;
    const canvasW = is2x6 ? Math.round(config.canvasWidth / copies) : config.canvasWidth;
    const canvasH = config.canvasHeight;

    const canvas = document.createElement("canvas");
    canvas.width  = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvasW, canvasH); // fully transparent

    const overlayDesignId = designId || (this._getOriginalDesign() || {}).id;
    const design = this.getDesign(overlayDesignId);
    if (!design) return canvas;

    const overlayPath = design.overlays && design.overlays[frameType];
    if (!overlayPath) return canvas;

    const overlayImg = await this.loadImage(overlayPath);
    if (!overlayImg) return canvas;

    if (is2x6) {
      const isSingle = this._isSingleStripOverlay(overlayImg, "2x6");
      if (isSingle) {
        ctx.drawImage(overlayImg, 0, 0, canvasW, canvasH);
      } else {
        const srcW = Math.round(overlayImg.naturalWidth / 2);
        const srcH = overlayImg.naturalHeight;
        ctx.drawImage(overlayImg, 0, 0, srcW, srcH, 0, 0, canvasW, canvasH);
      }
    } else {
      ctx.drawImage(overlayImg, 0, 0, canvasW, canvasH);
    }

    return canvas;
  },

  /*
   * LIVE VIDEO STRIP — renders one strip of live <video> / <img> elements
   * into containerEl, used on Page 6 (printing) and the digital gallery.
   *
   * For 2×6 layouts the print sheet has two identical strips side-by-side,
   * but we only render ONE here (the first copy / slots 0–3). Showing both
   * would shrink each strip to half-width and look cramped inside the narrow
   * center column. The overlay PNG slice covers the first strip only.
   *
   * All video elements are synchronised: once every <video> can play, they
   * are all seeked to 0 and started together in the same microtask so they
   * stay in lockstep. Each is individually looped, so they stay together for
   * the lifetime of the session (loop durations are identical because every
   * video was recorded from the same shooting session).
   */
  renderLive(containerEl, { frameType, selectedShots, designId }) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    const design = this.getDesign(designId);
    const overlayPath = design && design.overlays && design.overlays[frameType];

    // Always render exactly ONE strip regardless of frame type.
    // For 2×6 the sheet has two identical strips, but on-screen we only
    // show the first one (slots 0 through slotsPerCopy-1).
    const copies = frameType === "2x6" ? 2 : 1;
    const slotsPerCopy = config.photoSlots.length / copies;

    containerEl.innerHTML = "";
    containerEl.classList.add("live-strip-row");

    const wrap = document.createElement("div");
    wrap.className = "live-strip-wrap";
    // Aspect ratio is that of one single strip, not the full sheet
    wrap.style.aspectRatio = `${config.canvasWidth / copies} / ${config.canvasHeight}`;

    const videoEls = [];

    for (let i = 0; i < slotsPerCopy; i++) {
      // Always read from copy 0 (slot indices 0–slotsPerCopy-1)
      const slotIndex = i;
      const slot = config.photoSlots[slotIndex];
      const shot = selectedShots[config.slotToPhotoIndex[slotIndex]];

      // Convert absolute px coords into % relative to one strip's own width
      const stripWidth = config.canvasWidth / copies;
      const leftPct   = (slot.x / stripWidth) * 100;
      const topPct    = (slot.y / config.canvasHeight) * 100;
      const widthPct  = (slot.w / stripWidth) * 100;
      const heightPct = (slot.h / config.canvasHeight) * 100;

      const isVideo = shot && shot.videoUrl;
      const media = document.createElement(isVideo ? "video" : "img");
      media.className = "live-strip-media";
      media.style.left   = `${leftPct}%`;
      media.style.top    = `${topPct}%`;
      media.style.width  = `${widthPct}%`;
      media.style.height = `${heightPct}%`;
      media.style.borderRadius = `${config.slotCornerRadiusPct || 0}%`;

      if (isVideo) {
        media.src = shot.videoUrl;
        media.muted      = true;
        media.loop       = true;
        media.playsInline = true;
        media.preload    = "auto";
        // Do NOT autoplay yet — we start all videos together below
        videoEls.push(media);
      } else if (shot && shot.imageUrl) {
        media.src = shot.imageUrl;
        media.alt = "Selected photo";
      }

      wrap.appendChild(media);
    }

    if (overlayPath) {
      const overlayImg = document.createElement("img");
      overlayImg.className = "live-strip-overlay";
      overlayImg.src = overlayPath;
      overlayImg.alt = "Frame design";

      // For single-strip uploads the image is already one-strip wide,
      // so it maps 1:1 to the rendered strip (no CSS width trick needed).
      // For legacy double-strip overlays, slice the left half by making
      // the img 200% wide (copies=2 for 2×6) so only copy 0 is visible.
      overlayImg.addEventListener("load", () => {
        const isSingle = this._isSingleStripOverlay(overlayImg, frameType);
        if (!isSingle && copies > 1) {
          overlayImg.style.width  = `${copies * 100}%`;
          overlayImg.style.left   = "0%";
          overlayImg.style.height = "100%";
          overlayImg.style.top    = "0";
        }
        // Single-strip: default 100% width / height is already correct
      }, { once: true });

      wrap.appendChild(overlayImg);
    }

    containerEl.appendChild(wrap);

    // Synchronised playback: wait for every video to be ready, then start
    // them all at currentTime=0 in the same microtask. This prevents the
    // visible stagger where earlier-loaded clips start playing while later
    // ones are still buffering.
    if (videoEls.length > 0) {
      const readyPromises = videoEls.map(
        (v) =>
          new Promise((resolve) => {
            if (v.readyState >= 3) { resolve(); return; }
            v.addEventListener("canplay", resolve, { once: true });
            v.addEventListener("error",   resolve, { once: true }); // don't hang on error
          })
      );

      Promise.all(readyPromises).then(() => {
        // Seek and play all videos atomically
        videoEls.forEach((v) => { v.currentTime = 0; });
        videoEls.forEach((v) => { v.play().catch(() => {}); });
      });
    }
  },

  /*
   * COMBINED VIDEO STRIP EXPORT — records the full composited layout
   * (all 4 videos playing in their exact slots + frame overlay on top)
   * into ONE downloadable/shareable .webm file, matching the print
   * layout exactly but animated. Recording length matches durationMs —
   * default is 8000ms to match the guest's actual ~8s per-shot countdown
   * (see shooting.js's countdownSeconds) plus stopVideoRecording's ~600ms
   * freeze-hold; previously this defaulted to 3000ms and no caller
   * overrode it, so the digital copy was cut down to a fraction of what
   * was actually recorded regardless of the real clip length.
   *
   * singleStrip (default false) — when true and frameType is "2x6",
   * only the first copy's slots are rendered onto a half-width canvas.
   * Used by the digital gallery export so guests download one clean strip.
   * Print-preview (Page 6 inline playback) is unaffected.
   */
  async exportVideoStrip({ frameType, selectedShots, designId, durationMs = 8000, scale = 0.3, singleStrip = false }) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    // For 2x6 singleStrip mode, work with one copy's worth of slots only.
    const copies = (frameType === "2x6" && singleStrip) ? 1 : (frameType === "2x6" ? 2 : 1);
    const totalCopies = frameType === "2x6" ? 2 : 1;
    const slotsPerCopy = Math.round(config.photoSlots.length / totalCopies);
    // Slots to draw: first copy only in singleStrip mode, all slots otherwise.
    const slotsToRender = singleStrip ? config.photoSlots.slice(0, slotsPerCopy) : config.photoSlots;
    // Canvas is half-width for singleStrip 2x6, full width otherwise.
    const canvasW = Math.round((config.canvasWidth / totalCopies) * copies * scale);
    const canvasH = Math.round(config.canvasHeight * scale);

    const canvas = document.createElement("canvas");
    canvas.width  = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");

    // Preload hidden <video> elements for every slot that has a video,
    // and <img> fallbacks for slots that don't.
    // In singleStrip mode we only load the first copy's slots.
    const mediaEls = await Promise.all(
      slotsToRender.map((slot, i) => {
        const shot = selectedShots[config.slotToPhotoIndex[i]];
        return new Promise((resolve) => {
          if (shot && shot.videoUrl) {
            const v = document.createElement("video");
            v.src = shot.videoUrl;
            v.muted = true;
            v.loop = true;
            v.playsInline = true;
            v.oncanplay = () => { v.play(); resolve(v); };
            v.onerror = () => resolve(null);
          } else if (shot && shot.imageUrl) {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = shot.imageUrl;
          } else {
            resolve(null);
          }
        });
      })
    );

    const design = this.getDesign(designId);
    const overlayPath = design && design.overlays && design.overlays[frameType];
    const overlayImg = overlayPath ? await this.loadImage(overlayPath) : null;

    const drawMediaCropFill = (media, x, y, w, h) => {
      const mw = media.videoWidth || media.width;
      const mh = media.videoHeight || media.height;
      const mediaRatio = mw / mh;
      const boxRatio = w / h;
      let sx, sy, sw, sh;
      if (mediaRatio > boxRatio) {
        sh = mh; sw = sh * boxRatio; sx = (mw - sw) / 2; sy = 0;
      } else {
        sw = mw; sh = sw / boxRatio; sx = 0; sy = (mh - sh) / 2;
      }
      ctx.drawImage(media, sx, sy, sw, sh, x, y, w, h);
    };

    const drawFrame = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      slotsToRender.forEach((slot, i) => {
        const media = mediaEls[i];
        if (media) {
          // slot.x is relative to the full sheet; copy 0 starts at x=0,
          // so no offset adjustment is needed for the first strip.
          drawMediaCropFill(media, slot.x * scale, slot.y * scale, slot.w * scale, slot.h * scale);
        }
      });
      if (overlayImg) {
        if (singleStrip && frameType === "2x6") {
          // The overlay PNG spans the full two-strip sheet at its natural
          // resolution (e.g. 2400 × 3600px). We need to source only the
          // left half (copy 0) of that image.
          //
          // IMPORTANT: drawImage source coordinates are always in the image's
          // own natural pixel dimensions — NOT in scaled canvas units. Using
          // canvasW/canvasH as the source rect samples only a tiny sliver of
          // the overlay (because canvasW ≈ 360px but the image is 2400px wide),
          // then stretches it to fill the canvas, producing the oversized/
          // misaligned overlay visible in the screenshot.
          const srcW = Math.round(overlayImg.naturalWidth  / 2); // left strip only
          const srcH = overlayImg.naturalHeight;                  // full height
          ctx.drawImage(
            overlayImg,
            0, 0, srcW, srcH,         // source: left-half of the full-sheet overlay (natural px)
            0, 0, canvasW, canvasH    // dest: fill the entire half-width canvas
          );
        } else {
          ctx.drawImage(overlayImg, 0, 0, canvas.width, canvas.height);
        }
      }
    };

    const stream = canvas.captureStream(30);
    // Prefer MP4/H.264 — plays natively on iOS/Android/most phones, unlike
    // WebM which many mobile browsers (notably Safari/iOS) can't play.
    const videoMimeCandidates = [
      "video/mp4;codecs=h264",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm"
    ];
    const mimeType = videoMimeCandidates.find(
      (type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)
    ) || "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    return new Promise((resolve) => {
      recorder.onstop = async () => {
        mediaEls.forEach((m) => { if (m && m.pause) m.pause(); });
        const rawBlob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
        // Re-mux into a properly finalized MP4 so the downloaded video can
        // be posted to Instagram, TikTok, etc. without "Can't access media".
        const finalBlob = await remuxToMp4(rawBlob);
        resolve(finalBlob);
      };

      let rafId;
      const tick = () => { drawFrame(); rafId = requestAnimationFrame(tick); };
      tick();

      recorder.start();
      setTimeout(() => {
        cancelAnimationFrame(rafId);
        recorder.stop();
      }, durationMs);
    });
  },

/* Full-resolution PNG export — exact 2400x3600, all layers composited. */
  async exportPNG(opts) {
    const canvas = await this.compositeLayout(opts);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  },

  /* Exact pixel placements for the printed QR code(s), per your spec.
     2x6 has two identical strips side by side, each gets its own QR;
     4x6 gets a single QR. Units match the 2400x3600 @ 600dpi canvas. */
  QR_PLACEMENTS: {
    "2x6": [
      { x: 881,  y: 33.09, w: 250, h: 250 },
      { x: 2081, y: 33.09, w: 250, h: 250 }
    ],
    "4x6": [
      { x: 2089, y: 34.09, w: 250, h: 250 }
    ]
  },

  /*
   * PRINT-ONLY export — same full-resolution composite as exportPNG(),
   * plus the gallery QR code baked in at the exact coordinates above.
   * Used exclusively by printingModule.print(); the digital copy (gallery
   * upload, Supabase strip.png, downloads) keeps using plain exportPNG()
   * with no QR embedded.
   */
async exportPrintPNG({ frameType, selectedShots, designId, qrText }) {
    const canvas = await this.compositeLayout({ frameType, selectedShots, designId });

    if (qrText) {
      const ctx = canvas.getContext("2d");
      const placements = this.QR_PLACEMENTS[frameType] || [];

      if (placements.length) {
        const qrSize = placements[0].w; // all placements use the same 200x200 footprint
        const qrSource = generateQrCanvas(qrText, qrSize, {
          correctLevel: QRCode.CorrectLevel.L,
          quietModules: 2
        });

        placements.forEach((p) => {
          // White backing at the exact QR footprint first — guarantees
          // full contrast regardless of whatever artwork sits underneath.
          ctx.save();
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(p.x, p.y, p.w, p.h);
          ctx.restore();

          ctx.save();
          ctx.imageSmoothingEnabled = false; // keep module edges crisp, not blurred
          ctx.drawImage(qrSource, p.x, p.y, p.w, p.h);
          ctx.restore();
        });
      }
    } else {
      console.warn("[stripModule] exportPrintPNG called with no qrText — printing without a QR code.");
    }

    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  },

  /*
   * renderCoverFlowCarousel — builds a center-mode Cover Flow carousel.
   *
   * Parameters:
   *   trackEl       — the .coverflow-track element to populate
   *   titleEl       — the .coverflow-active-title element to update on change
   *   items         — array of { id, label, thumbnailUrl, isFilter }
   *   activeId      — initially selected item id
   *   onSelect(id)  — called whenever the snapped card changes
   *   thumbAspect   — optional CSS aspect-ratio string for thumbnails (default "2/3")
   *
   * Implementation:
   *   - Cards are flex children with scroll-snap-align:center.
   *   - IntersectionObserver + scrollend detect which card is centered.
   *   - The active card gets .coverflow-active; adjacent ones get .coverflow-near.
   *   - Clicking any card scrolls it smoothly into center (which triggers snap).
   */
  /*
   * renderCoverFlowCarousel — infinite-looping center-mode Cover Flow.
   *
   * Strategy: clone items × COPIES to create a "virtual infinite" list.
   * The user always starts at the middle copy. When scrolling approaches
   * either end we silently jump back into the middle copy so scrolling
   * feels endless. This works without any JS-driven continuous animation —
   * it uses native CSS scroll-snap, so kiosk touch / mouse drag works too.
   *
   * Parameters unchanged from the original implementation.
   */
  renderCoverFlowCarousel(trackEl, titleEl, items, activeId, onSelect, thumbAspect) {
    trackEl.innerHTML = "";

    if (!items || items.length === 0) return;

    const aspect = thumbAspect || "2 / 3";

    /*
     * Infinite-loop strategy: replicate items × TOTAL_COPIES.
     * The middle copy (index COPIES) is where the user always lives.
     * When they scroll into an outer copy we silently teleport scrollTop
     * to the equivalent position in the middle copy — invisible to the eye
     * because the content is identical.
     *
     * COPIES=3 → 7 total copies → 3 before + real + 3 after.
     * This gives ample runway for fast swipes before needing a jump.
     */
    const COPIES = 3;
    const TOTAL_COPIES = COPIES * 2 + 1;
    const N = items.length;

    // ── Card factory ────────────────────────────────────────────────────────
    const buildCard = (item, copyIndex) => {
      const card = document.createElement("button");
      card.className = "coverflow-card" + (item.isFilter ? " coverflow-filter" : "");
      card.dataset.cfId   = String(item.id);
      card.dataset.cfCopy = String(copyIndex);
      card.type = "button";

      const thumb = document.createElement("img");
      thumb.className = "coverflow-thumb";
      thumb.style.aspectRatio = aspect;
      thumb.alt = item.label;
      if (item.thumbnailUrl) {
        if (item.isFilter && item.cssFilter && item.cssFilter !== "none") {
          thumb.style.filter = item.cssFilter;
        }
        thumb.src = item.thumbnailUrl;
      } else {
        thumb.style.background = "var(--panel-light)";
      }

      const name = document.createElement("span");
      name.className = "coverflow-card-name";
      name.textContent = item.label;

      card.appendChild(thumb);
      card.appendChild(name);
      return card;
    };

    // ── Populate all virtual copies ─────────────────────────────────────────
    const allCards = [];
    for (let c = 0; c < TOTAL_COPIES; c++) {
      items.forEach((item, i) => {
        const card = buildCard(item, c);
        trackEl.appendChild(card);
        allCards.push({ card, item, virtualIndex: c * N + i });
      });
    }

    const realStartVIdx = COPIES * N; // virtual index of copy COPIES, item 0

    let currentRealIdx = Math.max(0, items.findIndex(it => String(it.id) === String(activeId)));

    // ── Active/near visual state ─────────────────────────────────────────────
    const updateActiveStyles = (realIdx) => {
      allCards.forEach(({ card }, absIdx) => {
        const itemIdx = absIdx % N;
        const diff = Math.abs(itemIdx - realIdx);
        const wrappedDiff = Math.min(diff, N - diff);
        card.classList.toggle("coverflow-active", itemIdx === realIdx);
        card.classList.toggle("coverflow-near",   wrappedDiff === 1 && itemIdx !== realIdx);
      });
      if (titleEl && items[realIdx]) {
        titleEl.textContent = items[realIdx].label;
      }
    };

    // ── Padding: half container height so first/last cards can center-snap ──
    const setPadding = () => {
      const half = Math.round(trackEl.clientHeight / 2);
      trackEl.style.paddingTop    = `${half}px`;
      trackEl.style.paddingBottom = `${half}px`;
    };

    /*
     * getScrollTopForVIdx — compute the exact scrollTop needed to center
     * virtual card vIdx in the track's viewport.
     *
     * card.offsetTop is measured from the top border-edge of offsetParent.
     * For a flex column with paddingTop, card.offsetTop already includes that
     * padding (e.g. first card: offsetTop = paddingTop). So the formula:
     *
     *   scrollTop = card.offsetTop + card.offsetHeight/2 − trackEl.clientHeight/2
     *
     * correctly centers the card regardless of padding size.
     */
    const getScrollTopForVIdx = (vIdx) => {
      const { card } = allCards[vIdx];
      return card.offsetTop + card.offsetHeight / 2 - trackEl.clientHeight / 2;
    };

    /*
     * scrollToVIdx — jump or animate to center a virtual card.
     *
     * Always uses direct scrollTop assignment for "instant" to avoid
     * scrollIntoView, which can scroll through all intermediate virtual cards
     * as one long animated scroll (visually broken on large virtual lists).
     */
    let isSilentScrolling = false;

    const scrollToVIdx = (vIdx, behavior = "instant") => {
      const top = getScrollTopForVIdx(vIdx);
      if (behavior === "instant") {
        isSilentScrolling = true;
        trackEl.scrollTop = top;
        // Clear flag after browser has processed the scroll
        requestAnimationFrame(() => requestAnimationFrame(() => {
          isSilentScrolling = false;
        }));
      } else {
        trackEl.scrollTo({ top, behavior });
      }
    };

    // ── Scroll-based active detection (replaces IntersectionObserver) ────────
    /*
     * IntersectionObserver fires asynchronously and batches entries, which
     * causes two problems:
     *  1. On a loop jump, IO fires for clone cards during the jump, triggering
     *     spurious onSelect calls and visual glitches on the filter carousel.
     *  2. The 80 ms onSelect delay compounds with IO latency, making filter
     *     selection feel sluggish and sometimes misfire.
     *
     * Replacement: listen to the "scroll" event on trackEl, debounce it, then
     * compute which card is closest to center using scrollTop arithmetic.
     * This is synchronous, deterministic, and immune to clone-card confusion.
     */
    let scrollDebounce = null;

    const onScroll = () => {
      if (isSilentScrolling) return;

      // Find the card whose center is closest to the track's center
      const trackCenter = trackEl.scrollTop + trackEl.clientHeight / 2;
      let bestAbsIdx = 0;
      let bestDist = Infinity;
      allCards.forEach(({ card }, absIdx) => {
        const cardCenter = card.offsetTop + card.offsetHeight / 2;
        const dist = Math.abs(cardCenter - trackCenter);
        if (dist < bestDist) { bestDist = dist; bestAbsIdx = absIdx; }
      });

      const newRealIdx = bestAbsIdx % N;

      if (newRealIdx !== currentRealIdx) {
        currentRealIdx = newRealIdx;
        updateActiveStyles(currentRealIdx);
        // Notify caller (debounced so rapid scrolls don't fire too often)
        clearTimeout(scrollDebounce);
        scrollDebounce = setTimeout(() => {
          onSelect(String(items[currentRealIdx].id));
        }, 60);
      }

      // ── Loop jump: teleport to middle copy when user scrolls into a clone ──
      const copyIndex = Math.floor(bestAbsIdx / N);
      if (copyIndex < COPIES || copyIndex >= COPIES + 1) {
        clearTimeout(scrollDebounce); // cancel pending onSelect during jump
        const targetVIdx = COPIES * N + newRealIdx;
        requestAnimationFrame(() => {
          isSilentScrolling = true;
          trackEl.scrollTop = getScrollTopForVIdx(targetVIdx);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            isSilentScrolling = false;
          }));
        });
      }
    };

    trackEl.addEventListener("scroll", onScroll, { passive: true });

    // ── Click: center the real-copy equivalent of the clicked card ──────────
    allCards.forEach(({ card }, absIdx) => {
      card.addEventListener("click", () => {
        const realIdx = absIdx % N;
        const targetVIdx = COPIES * N + realIdx;
        scrollToVIdx(targetVIdx, "smooth");
        // Fire onSelect immediately on click — don't wait for scroll to settle
        if (realIdx !== currentRealIdx) {
          currentRealIdx = realIdx;
          updateActiveStyles(currentRealIdx);
          clearTimeout(scrollDebounce);
          onSelect(String(items[currentRealIdx].id));
        }
      });
    });

    // ── Initialise ───────────────────────────────────────────────────────────
    // Two rAFs: first applies padding (layout), second reads offsetTop (stable).
    requestAnimationFrame(() => {
      setPadding();
      requestAnimationFrame(() => {
        updateActiveStyles(currentRealIdx);
        isSilentScrolling = true;
        trackEl.scrollTop = getScrollTopForVIdx(realStartVIdx + currentRealIdx);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          isSilentScrolling = false;
        }));
      });
    });

    // ── ResizeObserver: re-center after layout changes ───────────────────────
    const ro = new ResizeObserver(() => {
      setPadding();
      requestAnimationFrame(() => {
        isSilentScrolling = true;
        trackEl.scrollTop = getScrollTopForVIdx(COPIES * N + currentRealIdx);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          isSilentScrolling = false;
        }));
      });
    });
    ro.observe(trackEl);

    // ── Mouse drag for kiosk touchscreen ─────────────────────────────────────
    let dragStartY = 0, dragScrollTop = 0, isDragging = false;
    trackEl.addEventListener("mousedown",  (e) => { isDragging = true; dragStartY = e.clientY; dragScrollTop = trackEl.scrollTop; });
    trackEl.addEventListener("mousemove",  (e) => { if (!isDragging) return; e.preventDefault(); trackEl.scrollTop = dragScrollTop - (e.clientY - dragStartY); });
    trackEl.addEventListener("mouseup",    ()  => { isDragging = false; });
    trackEl.addEventListener("mouseleave", ()  => { isDragging = false; });

    return { allCards, ro };
  },

  /*
   * Renders the selectable design swatches into a container (Page 5).
   * Now uses Cover Flow — delegates to renderCoverFlowCarousel().
   *
   * Legacy callers that still reference designOptions as a swatch grid will
   * get the Cover Flow; the onSelect callback signature is unchanged.
   */
  async renderSwatchPicker(containerEl, currentDesignId, onSelect) {
    containerEl.innerHTML = "";

    if (!STRIP_DESIGNS.length) return;

    // Filter by current frame type so only relevant designs are shown
    const frameType = (typeof sessionState !== "undefined" && sessionState.frameType) || "2x6";
    const filteredDesigns = STRIP_DESIGNS.filter(d => d.overlays && d.overlays[frameType]);
    const designs = filteredDesigns.length > 0 ? filteredDesigns : STRIP_DESIGNS;

    const items = designs.map(d => ({
      id:           d.id,
      label:        d.label,
      thumbnailUrl: d.thumbnail || null,
      isFilter:     false
    }));

    let titleEl = containerEl.closest(".design-carousel-col")
      ? containerEl.closest(".design-carousel-col").querySelector(".coverflow-active-title")
      : null;

    this.renderCoverFlowCarousel(
      containerEl,
      titleEl,
      items,
      currentDesignId || (designs[0] && designs[0].id),
      (id) => onSelect(id)
    );
  }
};

/*
 * DESIGN SELECTION LOGIC — Page 5
 * Lives in this file since it's tightly coupled to stripModule.
 */

/*
 * BUILT-IN PHOTO FILTERS
 * These are applied as CSS filter values to the photos canvas.
 * The filter thumbnail uses Photo-Filter-Thumbnail.png from assets/designs/thumbnail/.
 * Filters are also manageable through the Admin Panel (stored in STRIP_FILTERS,
 * injected by asset-sync.js or falling back to these defaults).
 */
let STRIP_FILTERS = [
  { id: "none",        label: "Original",    cssFilter: "none"                                              },
  { id: "bw",         label: "B&W",          cssFilter: "grayscale(1)"                                     },
  { id: "vintage",    label: "Vintage",       cssFilter: "sepia(0.55) contrast(1.05) brightness(1.08)"     },
  { id: "cool",       label: "Cool",          cssFilter: "hue-rotate(20deg) saturate(1.15) brightness(1.05)"},
  { id: "warm",       label: "Warm",          cssFilter: "sepia(0.3) saturate(1.3) brightness(1.05)"       },
  { id: "vivid",      label: "Vivid",         cssFilter: "saturate(1.6) contrast(1.1)"                     },
  { id: "fade",       label: "Fade",          cssFilter: "opacity(0.88) brightness(1.12) saturate(0.82)"   },
  { id: "highcon",    label: "High Contrast", cssFilter: "contrast(1.45) brightness(0.95)"                 },
  { id: "soft",       label: "Soft",          cssFilter: "brightness(1.08) saturate(0.88) blur(0.4px)"     }
];

const designModule = {
  els: {
    options:         document.getElementById("designOptions"),
    filterCarousel:  document.getElementById("filterCarousel"),
    previewContainer: document.getElementById("designPreviewContainer"),
    backBtn:         document.getElementById("btnBackFromDesign"),
    nextBtn:         document.getElementById("btnNextFromDesign")
  },

  /*
   * Current active filter — stored separately from sessionState.design
   * because filters are a preview/export concern, not a template choice.
   */
  _activeFilter: "none",

  async init() {
    if (!sessionState.design && STRIP_DESIGNS.length) {
      sessionState.design = STRIP_DESIGNS[0].id;
    }
    this._activeFilter = "none";

    // ── Templates Cover Flow (left column) ─────────────────────────────
    this._initTemplateCoverFlow();

    // ── Filters Cover Flow (right column) ──────────────────────────────
    this._initFilterCoverFlow();

    this.renderPreview();
    this.els.nextBtn.disabled = false;

    kioskTimer.start(60, () => {
      if (this.els.nextBtn && !this.els.nextBtn.disabled) this.els.nextBtn.click();
    });
  },

  _initTemplateCoverFlow() {
    const trackEl = this.els.options;
    if (!trackEl || !STRIP_DESIGNS.length) return;

    const col      = trackEl.closest(".design-carousel-col");
    const titleEl  = col ? col.querySelector(".coverflow-active-title") : null;

    // Only show templates that have an overlay for the current frame type.
    // e.g. 2x6 → only designs with overlays["2x6"], 4x6 → only designs with overlays["4x6"].
    const frameType = (typeof sessionState !== "undefined" && sessionState.frameType) || "2x6";
    const filteredDesigns = STRIP_DESIGNS.filter(
      d => d.overlays && d.overlays[frameType]
    );

    // Fallback: if filtering leaves nothing, show all designs
    const designs = filteredDesigns.length > 0 ? filteredDesigns : STRIP_DESIGNS;

    const items = designs.map(d => ({
      id:           d.id,
      label:        d.label,
      thumbnailUrl: d.thumbnail || null,
      isFilter:     false
    }));

    // If the currently-selected design is not valid for this frame type, pick the first available
    const validIds = new Set(designs.map(d => String(d.id)));
    if (!validIds.has(String(sessionState.design))) {
      sessionState.design = designs[0] ? designs[0].id : null;
    }

    stripModule.renderCoverFlowCarousel(
      trackEl,
      titleEl,
      items,
      sessionState.design || (items[0] && items[0].id),
      (id) => {
        sessionState.design = id;
        this.renderPreview();
      }
    );
  },

  _initFilterCoverFlow() {
    const trackEl = this.els.filterCarousel;
    if (!trackEl) return;

    const col     = trackEl.closest(".design-carousel-col");
    const titleEl = col ? col.querySelector(".coverflow-active-title") : null;

    // Always start with "Original" (id: "none") — ensure it's first.
    const sortedFilters = [...STRIP_FILTERS].sort((a, b) => {
      if (a.id === "none") return -1;
      if (b.id === "none") return 1;
      return 0;
    });

    // Filter thumbnail base image — the CSS filter is applied on top of it
    // by renderCoverFlowCarousel so each card visually shows the effect.
    const filterThumb = "assets/designs/thumbnail/Photo-Filter-Thumbnail.png";

    const items = sortedFilters.map(f => ({
      id:           f.id,
      label:        f.label,
      thumbnailUrl: filterThumb,
      isFilter:     true,
      // Pass cssFilter so renderCoverFlowCarousel can apply it to the thumb img
      cssFilter:    f.cssFilter
    }));

    // Reset active filter to "none" (Original) each time the carousel inits
    this._activeFilter = "none";

    stripModule.renderCoverFlowCarousel(
      trackEl,
      titleEl,
      items,
      "none",  // always start at Original
      (id) => {
        this._activeFilter = id;
        this._applyFilterToPreview(id);
      },
      "4 / 3"  // filter thumbnails are landscape
    );
  },

  /*
   * Applies a CSS filter to the PHOTOS-ONLY canvas layer in the strip preview.
   * The overlay canvas (top layer) is intentionally NOT filtered so the
   * frame design is never affected by the colour filter.
   *
   * This is a purely visual preview effect — the final print composite
   * (compositeLayout / exportPrintPNG) is 100% unaffected.
   */
  _applyFilterToPreview(filterId) {
    const f = STRIP_FILTERS.find(x => x.id === filterId);
    const cssFilter = (f && f.cssFilter !== "none") ? f.cssFilter : "";
    const container = this.els.previewContainer;
    if (!container) return;

    // Target only the photos layer — the overlay canvas has .layout-canvas-overlay
    // and must not receive any filter.
    const photosCanvas = container.querySelector(".layout-canvas-photos");
    if (photosCanvas) {
      photosCanvas.style.filter = cssFilter || "";
    }
  },

  renderPreview() {
    stripModule.render(this.els.previewContainer, {
      frameType:     sessionState.frameType || "2x6",
      selectedShots: sessionState.selectedShots,
      designId:      sessionState.design
    }).then(() => {
      // Re-apply any active filter after canvas is re-rendered
      if (this._activeFilter && this._activeFilter !== "none") {
        this._applyFilterToPreview(this._activeFilter);
      }
    });
  }
};

// Warm the image cache immediately so design thumbnails render fast later.
stripModule.preloadDesignOverlays();

const btnBackFromDesign = document.getElementById("btnBackFromDesign");
const btnNextFromDesign = document.getElementById("btnNextFromDesign");
if (btnBackFromDesign) {
  btnBackFromDesign.addEventListener("click", () => {
    kioskTimer.hide();
    goToPage("selection");
  });
}
if (btnNextFromDesign) {
  btnNextFromDesign.addEventListener("click", () => {
    kioskTimer.hide();
    goToPage("printing"); // page 6
  });
}