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
      /*
       * category — normalised to lowercase kiosk tab key.
       * assetSync exposes the Supabase `asset_type` column as t.assetType
       * (e.g. "Originals" | "Designs" | "Accessories"). We normalise here
       * so templateModule._getCategory() can do a simple string compare
       * instead of fragile substring matching on the template name.
       */
      category: (() => {
        // Supabase returns snake_case column names (asset_type), not camelCase.
        // Read both forms so we work whether or not a JS layer camelCases it.
        const raw = (t.asset_type || t.assetType || t.category || "").trim().toLowerCase();
        if (raw === "originals")   return "originals";
        if (raw === "accessories") return "accessories";
        if (raw === "designs")     return "designs";
        if (raw === "flipbook")    return "flipbook";
        return "originals"; // default for legacy entries with no category
      })(),
      overlays: {
        "2x6":      t.overlayUrl2x6,
        "4x6":      t.overlayUrl4x6,
        "long-duo": t.overlayUrlLongDuo  || null,
        "long-mini":t.overlayUrlLongMini || null,
        "film-duo": t.overlayUrlFilmDuo  || null,
        "wide-mini":t.overlayUrlWideMini || null
      },
      /*
       * previewOverlays — strip preview overlay URLs per frame type.
       * These are used ONLY on the selection/printing preview canvas; they
       * are sized to the preview region (1200×3600 or 2400×1800) so they
       * align exactly with the cropped photo slots shown in the preview.
       * The full-frame overlay (overlays[frameType]) is used for print.
       *
       * Supabase column names come through as snake_case via assetSync.
       * adminTemplates.listTemplates() resolves them to public URLs as
       * preview_overlay_url_<format>. assetSync maps them to camelCase
       * as previewOverlayUrl<Format>. We read both forms defensively.
       */
      previewOverlays: {
        "long-duo":  t.preview_overlay_url_long_duo  || t.previewOverlayUrlLongDuo  || null,
        "long-mini": t.preview_overlay_url_long_mini || t.previewOverlayUrlLongMini || null,
        "film-duo":  t.preview_overlay_url_film_duo  || t.previewOverlayUrlFilmDuo  || null,
        "wide-mini": t.preview_overlay_url_wide_mini || t.previewOverlayUrlWideMini || null
      },
      // Linked keychain template overlay URL — populated when this 2×6 design
      // has a corresponding keychain template (keychain_overlay_path in Supabase,
      // resolved to a blob: URL by asset-sync.js as keychainOverlayUrl).
      keychainOverlayUrl: t.keychainOverlayUrl || null,
      /*
       * Flipbook — 3 independent template slots (Cover Page, A4 Page 1,
       * A4 Page 2), resolved to blob: URLs by asset-sync.js. A template
       * counts as a flipbook template as soon as any one slot is set
       * (see templateModule._getFrameType() in app.js); this is what makes
       * it appear under the kiosk's Flipbook category tab and routes
       * selection into the flipbook video-taking flow instead of a
       * standard photo strip.
       */
      flipbookCoverUrl:   t.flipbookCoverUrl   || null,
      flipbookA4Page1Url: t.flipbookA4Page1Url || null,
      flipbookA4Page2Url: t.flipbookA4Page2Url || null
    }));
    console.log(`[stripModule] Loaded ${STRIP_DESIGNS.length} designs from assetSync.`);
    this.preloadDesignOverlays();
    this._updateFrameAvailability();
    // Refresh the new template carousel (page-template) if it has been initialised
    if (typeof templateModule !== "undefined" && typeof templateModule.refresh === "function") {
      templateModule.refresh();
    }
  },

  /*
   * Frame availability — now informational only.
   * The old page-frame cards are hidden stubs; the new templateModule
   * handles filtering by frame type directly. We keep this method so
   * any callers don't throw, but no UI manipulation of hidden stubs is done.
   */
  _updateFrameAvailability() {
    const ALL_FRAME_TYPES = ["2x6", "4x6", "long-duo", "long-mini", "film-duo", "wide-mini"];
    const availability = {};
    ALL_FRAME_TYPES.forEach(ft => {
      availability[ft] = STRIP_DESIGNS.some(d => d.overlays && d.overlays[ft]);
    });
    console.log("[stripModule] Frame availability —", Object.entries(availability).map(([k,v]) => `${k}: ${v}`).join(", "));
    // If sessionState has an invalid frameType, clear it so the carousel re-selects correctly.
    if (typeof sessionState !== "undefined" && sessionState.frameType) {
      const ft = sessionState.frameType;
      if (ALL_FRAME_TYPES.includes(ft) && !availability[ft]) sessionState.frameType = null;
    }
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
   * drawRotatedCropFill — draws an image into a bounding box (x, y, w, h) rotated
   * by `angleDeg` degrees clockwise around the centre of that box.
   * The image is crop-to-filled within the rotated frame.
   *
   * Used for photo slots that specify `angle: 90` (or any angle) in LAYOUT_CONFIGS.
   * The canvas context is saved and restored so the rotation is isolated.
   *
   * COORDINATE CONTRACT:
   *   x, y, w, h are the ABSOLUTE bounding-box coordinates on the master canvas
   *   (2400 × 3600 px) exactly as written in LAYOUT_CONFIGS.  They must never be
   *   swapped, scaled, or reinterpreted here.
   *
   *   The visual bounding box on the canvas is always w × h at position (x, y)
   *   BEFORE rotation is applied. Rotation pivots around the centre of that
   *   box, so the box's content — not its footprint — is what gets rotated.
   *
   *   The crop-fill step below always uses the plain w/h ratio (identical to
   *   the non-rotated drawCropFill), because the image is cropped and drawn
   *   to fill that local w × h rectangle BEFORE rotation is applied. Rotating
   *   a correctly-filled w × h rectangle by 90° is a rigid transform — it
   *   does not distort the image, it just reorients it, and the rectangle's
   *   footprint on the canvas naturally becomes h × w as a consequence.
   *
   *   A previous version of this function cropped to the transposed h/w
   *   ratio (reasoning that the rotated interior is h wide × w tall) but
   *   still drew into a w × h destination rect. Since drawImage stretches
   *   the source rect to fit the destination independently on each axis,
   *   cropping to h/w while drawing into w×h forced a non-uniform stretch
   *   whenever w ≠ h — visible as squished/stretched photos in any
   *   strongly non-square rotated slot (e.g. the long-mini tiny strips,
   *   wide-mini side frames, and the film-duo filmstrip).
   */
  drawRotatedCropFill(ctx, img, x, y, w, h, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    // Centre of the bounding box — rotation pivot, never changes.
    const cx  = x + w / 2;
    const cy  = y + h / 2;

    // Crop-fill uses the local (pre-rotation) w/h ratio — same as the
    // non-rotated case — because rotation is applied to the already-filled
    // w × h rectangle as a rigid transform (see comment above).
    const imgRatio = img.width / img.height;
    const boxRatio = w / h;
    let sx, sy, sw, sh;
    if (imgRatio > boxRatio) {
      sh = img.height; sw = sh * boxRatio; sx = (img.width  - sw) / 2; sy = 0;
    } else {
      sw = img.width;  sh = sw / boxRatio; sx = 0; sy = (img.height - sh) / 2;
    }

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rad);
    // Draw at (-w/2, -h/2, w, h) so the destination bounding box is always
    // the spec-exact w × h rectangle centred on (cx, cy).
    ctx.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
    ctx.restore();
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

  async compositeLayout({ frameType, selectedShots, designId, singleStrip = false, debugSlots = false }) {
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
      // Per-slot photoIndex takes priority over the legacy slotToPhotoIndex array.
      const photoIdx = (slot.photoIndex !== undefined) ? slot.photoIndex : config.slotToPhotoIndex[i];
      const img = photoImages[photoIdx];
      if (img) {
        if (slot.angle) {
          this.drawRotatedCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h, slot.angle);
        } else {
          this.drawCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h);
        }
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
            // Full overlay: draw at full canvas size
            ctx.drawImage(overlayImg, 0, 0, canvas.width, canvas.height);
          }
        } else {
          console.warn(`[stripModule] Overlay not found: ${overlayPath}`);
        }
      }
    }

    // DEBUG ONLY — draws every configured photo slot's exact bounding box
    // (per LAYOUT_CONFIGS) on top of everything, including the design
    // overlay artwork. Use this to check whether an overlay PNG's own
    // transparent "windows" actually line up with the real slot coordinates —
    // any opaque overlay area that covers part of a red box below is the
    // overlay artwork, not a slot/coordinate bug.
    // Toggle: compositeLayout({ ..., debugSlots: true }) or
    // stripModule.exportDebugPNG({ frameType, selectedShots, designId }).
    // REMOVE before shipping to production — for verification only.
    if (debugSlots) {
      config.photoSlots.forEach((slot, i) => {
        ctx.save();
        ctx.strokeStyle = "#ff0033";
        ctx.lineWidth = 6;
        ctx.setLineDash([18, 10]);
        ctx.strokeRect(slot.x, slot.y, slot.w, slot.h);
        ctx.setLineDash([]);
        ctx.fillStyle = "#ff0033";
        ctx.font = "bold 36px sans-serif";
        ctx.fillText(`#${i}`, slot.x + 10, slot.y + 44);
        ctx.restore();
      });
      (config.qrPlacements || []).forEach((p) => {
        ctx.save();
        ctx.strokeStyle = "#00aaff";
        ctx.lineWidth = 6;
        ctx.setLineDash([18, 10]);
        ctx.strokeRect(p.x, p.y, p.w, p.h);
        ctx.restore();
      });
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
    // All supported frame type keys — extend this list when new frame types are added.
    const ALL_FRAME_TYPES = ["2x6", "4x6", "long-duo", "long-mini", "film-duo", "wide-mini"];
    const PREVIEW_FRAME_TYPES = ["long-duo", "long-mini", "film-duo", "wide-mini"];
    STRIP_DESIGNS.forEach((design) => {
      if (design.overlays) {
        ALL_FRAME_TYPES.forEach((ft) => {
          if (design.overlays[ft]) this.loadImage(design.overlays[ft]);
        });
      }
      // Also warm strip preview overlay cache
      if (design.previewOverlays) {
        PREVIEW_FRAME_TYPES.forEach((ft) => {
          if (design.previewOverlays[ft]) this.loadImage(design.previewOverlays[ft]);
        });
      }
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
      const photoIdx = (slot.photoIndex !== undefined) ? slot.photoIndex : config.slotToPhotoIndex[i];
      const img = photoImages[photoIdx];
      const x = slot.x * scale, y = slot.y * scale, w = slot.w * scale, h = slot.h * scale;
      if (img) {
        if (slot.angle) {
          this.drawRotatedCropFill(ctx, img, x, y, w, h, slot.angle);
        } else {
          this.drawCropFill(ctx, img, x, y, w, h);
        }
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

    // ── 2×6: single-strip canvas (half the print sheet width) ──────────────
    if (frameType === "2x6") {
      const copies = 2;
      const stripW = Math.round(config.canvasWidth / copies);
      const stripH = config.canvasHeight;

      const canvas = document.createElement("canvas");
      canvas.width  = stripW;
      canvas.height = stripH;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, stripW, stripH);

      // Layer 1: thumbnail background
      const thumbSrc = "assets/designs/thumbnail/2x6_Strip_Thumbnail.png";
      try {
        const thumbImg = await this.loadImage(thumbSrc);
        if (thumbImg) {
          this.drawCropFill(ctx, thumbImg, 0, 0, stripW, stripH);
          ctx.save(); ctx.globalAlpha = 0.18; ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, stripW, stripH); ctx.restore();
        }
      } catch (_) { /* thumbnail is optional */ }

      // Layer 2: photos — copy-0 slots only
      const slotsPerCopy = Math.round(config.photoSlots.length / copies);
      const copy0Slots   = config.photoSlots.slice(0, slotsPerCopy);
      const photoImages  = await Promise.all(
        (selectedShots || []).map((shot) =>
          shot && shot.imageUrl ? this.loadImage(shot.imageUrl) : Promise.resolve(null)
        )
      );
      copy0Slots.forEach((slot, i) => {
        const photoIdx = (slot.photoIndex !== undefined) ? slot.photoIndex : config.slotToPhotoIndex[i];
        const img = photoImages[photoIdx];
        if (img) {
          this.drawCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h);
        } else {
          ctx.save(); ctx.strokeStyle = "rgba(180,180,180,0.5)"; ctx.lineWidth = 3;
          ctx.strokeRect(slot.x + 2, slot.y + 2, slot.w - 4, slot.h - 4); ctx.restore();
        }
      });

      // Layer 3: overlay
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
              const srcW = Math.round(overlayImg.naturalWidth / 2);
              const srcH = overlayImg.naturalHeight;
              ctx.drawImage(overlayImg, 0, 0, srcW, srcH, 0, 0, stripW, stripH);
            }
          }
        }
      }
      return canvas;
    }

    // ── 4×6: full-canvas composite (unchanged) ──────────────────────────────
    if (frameType === "4x6") {
      const canvasW = config.canvasWidth;
      const canvasH = config.canvasHeight;

      const canvas = document.createElement("canvas");
      canvas.width  = canvasW;
      canvas.height = canvasH;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvasW, canvasH);

      // Layer 1: thumbnail background
      const thumbSrc = this._getFrameThumbnail(frameType);
      try {
        const thumbImg = await this.loadImage(thumbSrc);
        if (thumbImg) {
          this.drawCropFill(ctx, thumbImg, 0, 0, canvasW, canvasH);
          ctx.save(); ctx.globalAlpha = 0.18; ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvasW, canvasH); ctx.restore();
        }
      } catch (_) { /* thumbnail optional */ }

      const photoImages = await Promise.all(
        (selectedShots || []).map((shot) =>
          shot && shot.imageUrl ? this.loadImage(shot.imageUrl) : Promise.resolve(null)
        )
      );
      config.photoSlots.forEach((slot, i) => {
        const photoIdx = (slot.photoIndex !== undefined) ? slot.photoIndex : config.slotToPhotoIndex[i];
        const img = photoImages[photoIdx];
        if (img) {
          this.drawCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h);
        } else {
          ctx.save(); ctx.strokeStyle = "rgba(180,180,180,0.5)"; ctx.lineWidth = 3;
          ctx.strokeRect(slot.x + 2, slot.y + 2, slot.w - 4, slot.h - 4); ctx.restore();
        }
      });

      // Layer 3: overlay
      const overlayDesignId = designId || (this._getOriginalDesign() || {}).id;
      const design = this.getDesign(overlayDesignId);
      if (design) {
        const overlayPath = design.overlays && design.overlays[frameType];
        if (overlayPath) {
          const overlayImg = await this.loadImage(overlayPath);
          if (overlayImg) ctx.drawImage(overlayImg, 0, 0, canvasW, canvasH);
        }
      }
      return canvas;
    }

    // ── New frame types: cropped preview canvas (left half or top half) ──────
    // long-duo, long-mini, film-duo → W=1200, H=3600 (left strip, 4 slots)
    // wide-mini                     → W=2400, H=1800 (top half, 4 slots)
    // Only Frame 1 slots are drawn; the full canvas is used for print only.
    const previewCfg = this._getPreviewConfig(frameType);
    if (!previewCfg) throw new Error(`Unhandled frame type in compositeLayoutPreview: ${frameType}`);

    const { canvasW, canvasH, slots } = previewCfg;

    const canvas = document.createElement("canvas");
    canvas.width  = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvasW, canvasH);

    // Layer 1: thumbnail background
    const thumbSrc = this._getFrameThumbnail(frameType);
    try {
      const thumbImg = await this.loadImage(thumbSrc);
      if (thumbImg) {
        this.drawCropFill(ctx, thumbImg, 0, 0, canvasW, canvasH);
        ctx.save(); ctx.globalAlpha = 0.18; ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvasW, canvasH); ctx.restore();
      }
    } catch (_) { /* thumbnail optional */ }

    // Layer 2: preview slots only (4 photos, Frame 1 region)
    const photoImages = await Promise.all(
      (selectedShots || []).map((shot) =>
        shot && shot.imageUrl ? this.loadImage(shot.imageUrl) : Promise.resolve(null)
      )
    );
    slots.forEach((slot) => {
      const img = photoImages[slot.photoIndex];
      if (img) {
        if (slot.angle) {
          this.drawRotatedCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h, slot.angle);
        } else {
          this.drawCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h);
        }
      } else {
        ctx.save(); ctx.strokeStyle = "rgba(180,180,180,0.5)"; ctx.lineWidth = 3;
        ctx.strokeRect(slot.x + 2, slot.y + 2, slot.w - 4, slot.h - 4); ctx.restore();
      }
    });

    // Layer 3: overlay — drawn into the preview region.
    // Priority: strip preview overlay (sized for preview canvas) > full-frame overlay clipped.
    const overlayDesignId = designId || (this._getOriginalDesign() || {}).id;
    const design = this.getDesign(overlayDesignId);
    if (design) {
      const previewPath = design.previewOverlays && design.previewOverlays[frameType];
      if (previewPath) {
        const previewImg = await this.loadImage(previewPath);
        if (previewImg) {
          // Purpose-built preview overlay — draw 1:1 into the preview canvas
          ctx.drawImage(previewImg, 0, 0, canvasW, canvasH);
        }
      } else {
        // Fallback: full-frame overlay, drawn at print scale, clipped by canvas size.
        // film-duo landscape preview: rotate the portrait overlay 90° CW.
        const overlayPath = design.overlays && design.overlays[frameType];
        if (overlayPath) {
          const overlayImg = await this.loadImage(overlayPath);
          if (overlayImg) {
            if (previewCfg && previewCfg.previewIsLandscape) {
              ctx.save();
              ctx.translate(canvasW, 0);
              ctx.rotate(Math.PI / 2);
              ctx.drawImage(overlayImg,
                0, 0, 1200, config.canvasHeight,
                0, 0, 1200, config.canvasHeight
              );
              ctx.restore();
            } else {
              ctx.drawImage(overlayImg, 0, 0, config.canvasWidth, config.canvasHeight);
            }
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
    /*
     * Concurrency guard — Page 4 (selection.js) calls render() on every
     * single tap. Each call does up to two full-resolution (2400×3600
     * @600dpi) canvas composites, so rapid taps used to queue up several
     * of these in parallel: each one clearing the container and racing
     * the others to append its result, all decoding/drawing at once. On
     * the 4th photo (the point where selectedShots first has 4 real,
     * non-empty images to draw instead of cheap placeholder outlines)
     * that pile-up of concurrent heavy composites is what froze/crashed
     * the page.
     *
     * Fix: stamp a generation id on the container for every render()
     * call. After each await, bail out silently if a newer call has
     * since been made for this same container — a stale/superseded
     * render never touches the DOM or does further work.
     */
    const myGen = (containerEl._renderGen = (containerEl._renderGen || 0) + 1);

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
      if (containerEl._renderGen !== myGen) return null; // superseded — discard

      const overlayCanvas = await this._compositeOverlayOnly(opts);
      if (containerEl._renderGen !== myGen) return null; // superseded — discard

      photoCanvas.classList.add("layout-canvas", "layout-canvas-preview", "layout-canvas-photos");
      overlayCanvas.classList.add("layout-canvas-overlay");

      const clip = document.createElement("div");
      clip.className = "single-strip-clip";
      // 2×6 shows a single-strip preview (half canvas); all other frame types show full canvas
      // 2×6          → "preview-single"  (true single-strip canvas, no clip needed)
      // 4×6          → "4x6"             (full canvas, full-width clip)
      // new formats  → their own key so CSS can apply the right aspect-ratio sizing
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

      // Only now — after all async work finishes and this call is still
      // the latest one for this container — do we touch the live DOM.
      containerEl.innerHTML = "";
      containerEl.appendChild(clip);

      // Return the photos canvas as the "main" canvas reference
      canvas = photoCanvas;
    } else {
      // Full composite for all non-preview uses (printing.js, video export, etc.)
      canvas = await this.compositeLayout(opts);
      if (containerEl._renderGen !== myGen) return null; // superseded — discard

      canvas.classList.add("layout-canvas");
      containerEl.innerHTML = "";
      containerEl.appendChild(canvas);
    }

    return canvas;
  },

  /*
   * _compositePhotosOnly — renders only the photo slots and thumbnail
   * background onto a canvas for the preview column. No overlay.
   * Used by render() for the filterable bottom layer.
   *
   * 2×6         — half-canvas (left strip only)
   * 4×6         — full canvas
   * new frames  — cropped preview canvas via _getPreviewConfig():
   *               long-duo / long-mini / film-duo → 1200×3600 (left strip, 4 slots)
   *               wide-mini                       → 2400×1800 (top half, 4 slots)
   */
  async _compositePhotosOnly({ frameType, selectedShots }) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    const previewCfg = this._getPreviewConfig(frameType); // null for 2×6 and 4×6

    // Determine canvas dimensions and which slots to draw
    let canvasW, canvasH, slots;

    if (frameType === "2x6") {
      const copies = 2;
      canvasW = Math.round(config.canvasWidth / copies);
      canvasH = config.canvasHeight;
      const slotsPerCopy = Math.round(config.photoSlots.length / copies);
      slots = config.photoSlots.slice(0, slotsPerCopy);
    } else if (previewCfg) {
      // New frame types: use the cropped preview region
      canvasW = previewCfg.canvasW;
      canvasH = previewCfg.canvasH;
      slots   = previewCfg.slots;
    } else {
      // 4×6: full canvas, all slots
      canvasW = config.canvasWidth;
      canvasH = config.canvasHeight;
      slots   = config.photoSlots;
    }

    const canvas = document.createElement("canvas");
    canvas.width  = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvasW, canvasH);

    // Thumbnail background layer — use per-format thumbnails when available
    const thumbSrc = this._getFrameThumbnail(frameType);
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

    const photoImages = await Promise.all(
      (selectedShots || []).map((shot) =>
        shot && shot.imageUrl ? this.loadImage(shot.imageUrl) : Promise.resolve(null)
      )
    );

    slots.forEach((slot, i) => {
      // previewCfg slots have photoIndex directly; legacy slots use slotToPhotoIndex
      const photoIdx = (slot.photoIndex !== undefined) ? slot.photoIndex : config.slotToPhotoIndex[i];
      const img = photoImages[photoIdx];
      if (img) {
        if (slot.angle) {
          this.drawRotatedCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h, slot.angle);
        } else {
          this.drawCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h);
        }
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
   * _getFrameThumbnail — returns the background thumbnail asset path for a
   * given frame type, used as the bottom layer in preview composites.
   * Falls back to the 2×6 thumbnail for new frame types that don't have
   * their own dedicated thumbnail image yet.
   */
  _getFrameThumbnail(frameType) {
    const map = {
      "2x6":      "assets/designs/thumbnail/2x6_Strip_Thumbnail.png",
      "4x6":      "assets/designs/thumbnail/4x6_Strip_Thumbnail.png",
      "long-duo": "assets/designs/thumbnail/Long_Duo_and_Mini_Thumbnail.png",
      "long-mini":"assets/designs/thumbnail/Long_Duo_and_Mini_Thumbnail.png",
      "film-duo": "assets/designs/thumbnail/Film_Duo_Thumbnail.png",
      "wide-mini":"assets/designs/thumbnail/Wide_Mini_Thumbnail.png"
    };
    return map[frameType] || "assets/designs/thumbnail/2x6_Strip_Thumbnail.png";
  },

  /*
   * _getPreviewConfig — returns the canvas dimensions and photo slot list for
   * the strip/canvas preview of the four new frame types.
   *
   * These frame types have more than 4 slots across multiple sub-frames, but
   * the preview shows only a cropped region (left half or top half) containing
   * one representative set of 4 photos at the exact pixel positions specified
   * for preview output. The full LAYOUT_CONFIGS slots are still used for print.
   *
   * Returns null for 2×6 and 4×6 (handled by existing logic).
   *
   * Preview specs (px, matching the left/top region of the full canvas):
   *   long-duo / long-mini  — W=1200, H=3600, left strip (4 slots, x=87)
   *   film-duo              — W=1200, H=3600, left strip (4 slots, rotated 90°)
   *   wide-mini             — W=2400, H=1800, top half  (4 slots)
   *
   * Photo positions for each frame type come directly from the spec and match
   * the corresponding slots already defined in LAYOUT_CONFIGS (Frame 1 only).
   */
  _getPreviewConfig(frameType) {
    switch (frameType) {
      case "long-duo":
      case "long-mini":
        return {
          canvasW: 1200,
          canvasH: 3600,
          slots: [
            { x: 87, y: 178,  w: 1026, h: 808.66, photoIndex: 0 },
            { x: 87, y: 1030, w: 1026, h: 808.66, photoIndex: 1 },
            { x: 87, y: 1881, w: 1026, h: 808.66, photoIndex: 2 },
            { x: 87, y: 2731, w: 1026, h: 808.66, photoIndex: 3 }
          ]
        };

      case "film-duo":
        /*
         * Film Duo preview is LANDSCAPE — W=3600, H=1200.
         * The full print canvas is 2400×3600 portrait. The left strip
         * has 4 photos with angle:90, so when read "upright" each photo is
         * landscape-oriented. The preview shows these 4 photos in a single
         * landscape row (left→right) at 3600×1200.
         *
         * Coordinate transform: rotate the print canvas 90° clockwise to get
         * the preview canvas.
         *   print (x, y, w, h, angle:90)  →  each slot becomes a horizontal
         *   region in the landscape preview at:
         *     previewSlot.x = print slot y   (step along landscape width —
         *                     print slot y is 44.565 / 895.785 / 1746.975 /
         *                     2598.195; see LAYOUT_CONFIGS["film-duo"].
         *                     photoSlots, which are offset by ±(h-w)/2 from
         *                     x=86.47/y=121.5-etc. to compensate for
         *                     drawRotatedCropFill's rotation-pivot shift)
         *     previewSlot.w = print slot h   (956.08 → landscape slot width)
         *     previewSlot.h = print slot w   (802.21 → landscape slot height)
         *     angle: 0 (photos are already upright in the landscape view)
         *
         * Vertical centering: centre each slot in the 1200px height.
         *   slotH = 802.21, centreY = (1200 - 802.21) / 2 ≈ 198.90
         */
        return {
          canvasW: 3600,
          canvasH: 1200,
          // previewIsLandscape flag tells _compositeOverlayOnly to clip the overlay differently
          previewIsLandscape: true,
          slots: [
            { x: 44.565,   y: 198.90, w: 956.08, h: 802.21, angle: 0, photoIndex: 0 },
            { x: 895.785,  y: 198.90, w: 956.08, h: 802.21, angle: 0, photoIndex: 1 },
            { x: 1746.975, y: 198.90, w: 956.08, h: 802.21, angle: 0, photoIndex: 2 },
            { x: 2598.195, y: 198.90, w: 956.08, h: 802.21, angle: 0, photoIndex: 3 }
          ]
        };

      case "wide-mini":
        // Top half — 2×2 grid of large landscape photos.
        return {
          canvasW: 2400,
          canvasH: 1800,
          slots: [
            { x: 87.75,   y: 155.59, w: 1091.89, h: 756.48, photoIndex: 0 },
            { x: 1223.56, y: 155.59, w: 1091.89, h: 756.48, photoIndex: 1 },
            { x: 87.75,   y: 951.94, w: 1091.89, h: 756.48, photoIndex: 2 },
            { x: 1223.56, y: 951.94, w: 1091.89, h: 756.48, photoIndex: 3 }
          ]
        };

      default:
        return null; // 2×6 and 4×6 handled by existing logic
    }
  },

  /*
   * _compositeOverlayOnly — renders only the template overlay onto a
   * transparent canvas for the preview column. No photos.
   * Used by render() for the non-filterable top layer.
   *
   * For new frame types the overlay covers the full print canvas (2400×3600),
   * so we draw it at full print scale onto the smaller preview canvas — the
   * canvas size naturally clips to the preview region (left strip or top half).
   */
  async _compositeOverlayOnly({ frameType, designId }) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    const previewCfg = this._getPreviewConfig(frameType); // null for 2×6 and 4×6

    let canvasW, canvasH;
    if (frameType === "2x6") {
      canvasW = Math.round(config.canvasWidth / 2);
      canvasH = config.canvasHeight;
    } else if (previewCfg) {
      canvasW = previewCfg.canvasW;
      canvasH = previewCfg.canvasH;
    } else {
      // 4×6
      canvasW = config.canvasWidth;
      canvasH = config.canvasHeight;
    }

    const canvas = document.createElement("canvas");
    canvas.width  = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvasW, canvasH); // fully transparent

    const overlayDesignId = designId || (this._getOriginalDesign() || {}).id;
    const design = this.getDesign(overlayDesignId);
    if (!design) return canvas;

    if (frameType === "2x6") {
      // ── 2×6: left-strip crop of the full overlay ─────────────────────────
      const overlayPath = design.overlays && design.overlays["2x6"];
      if (!overlayPath) return canvas;
      const overlayImg = await this.loadImage(overlayPath);
      if (!overlayImg) return canvas;
      const isSingle = this._isSingleStripOverlay(overlayImg, "2x6");
      if (isSingle) {
        ctx.drawImage(overlayImg, 0, 0, canvasW, canvasH);
      } else {
        const srcW = Math.round(overlayImg.naturalWidth / 2);
        const srcH = overlayImg.naturalHeight;
        ctx.drawImage(overlayImg, 0, 0, srcW, srcH, 0, 0, canvasW, canvasH);
      }
    } else if (previewCfg) {
      /*
       * New frame types (long-duo, long-mini, film-duo, wide-mini).
       *
       * Priority:
       *   1. Strip preview overlay (previewOverlays[frameType]) — purpose-built
       *      at the preview canvas dimensions. Drawn at 1:1 into the preview canvas.
       *   2. Full-frame overlay (overlays[frameType]) — drawn at full print scale
       *      so the canvas size clips to the correct region.
       *
       * film-duo special case: the preview canvas is LANDSCAPE (3600×1200), so the
       * portrait full-frame overlay (2400×3600) must be rotated 90° CW to align.
       */
      const previewPath = design.previewOverlays && design.previewOverlays[frameType];
      if (previewPath) {
        const previewImg = await this.loadImage(previewPath);
        if (previewImg) {
          // Preview overlay is sized exactly for this canvas — draw 1:1
          ctx.drawImage(previewImg, 0, 0, canvasW, canvasH);
          return canvas;
        }
      }
      // Fallback: use full-frame overlay
      const overlayPath = design.overlays && design.overlays[frameType];
      if (!overlayPath) return canvas;
      const overlayImg = await this.loadImage(overlayPath);
      if (!overlayImg) return canvas;

      if (previewCfg.previewIsLandscape) {
        // film-duo landscape preview: rotate the portrait overlay 90° CW so
        // it aligns with the landscape preview canvas.
        // The overlay is 2400×3600 (portrait). After 90° CW rotation it becomes
        // 3600×2400 logically. We draw only the top 1200px of that rotated view,
        // which corresponds to the left strip of the portrait canvas.
        ctx.save();
        ctx.translate(canvasW, 0);      // move origin to top-right of landscape canvas
        ctx.rotate(Math.PI / 2);        // rotate 90° CW
        // Now drawing in "rotated portrait space": (0,0)=top-left of portrait canvas
        // Draw the left-strip region of the overlay (0..1200 wide × full height).
        // canvasH (landscape) = 1200 = the left-strip width in portrait space.
        ctx.drawImage(overlayImg,
          0, 0, 1200, config.canvasHeight,   // src: left 1200px of portrait overlay
          0, 0, 1200, config.canvasHeight     // dst: same — rotation handles the rest
        );
        ctx.restore();
      } else {
        // Standard: draw full overlay at print scale, canvas clips to preview region
        ctx.drawImage(overlayImg, 0, 0, config.canvasWidth, config.canvasHeight);
      }
    } else {
      // ── 4×6: full-canvas overlay ──────────────────────────────────────────
      const overlayPath = design.overlays && design.overlays[frameType];
      if (!overlayPath) return canvas;
      const overlayImg = await this.loadImage(overlayPath);
      if (!overlayImg) return canvas;
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

    // Stop any previous renderLive()'s per-frame LUT-filter loop before
    // rebuilding the DOM below — otherwise every re-render (repeat guest,
    // page revisit) leaks another rAF loop drawing into now-orphaned
    // canvases forever.
    if (this._liveFilterRAF) {
      cancelAnimationFrame(this._liveFilterRAF);
      this._liveFilterRAF = null;
    }

    const design = this.getDesign(designId);
    const overlayPath = design && design.overlays && design.overlays[frameType];

    // Determine the preview region for this frame type:
    //   2×6         — left strip only (half canvas width)
    //   new formats — cropped preview via _getPreviewConfig() (left strip or top half)
    //   4×6         — full canvas
    const previewCfg = this._getPreviewConfig(frameType); // null for 2×6 and 4×6

    let previewW, previewH, liveSlots;
    if (frameType === "2x6") {
      const copies = 2;
      previewW   = config.canvasWidth / copies;
      previewH   = config.canvasHeight;
      const slotsPerCopy = Math.round(config.photoSlots.length / copies);
      liveSlots  = config.photoSlots.slice(0, slotsPerCopy);
    } else if (previewCfg) {
      previewW  = previewCfg.canvasW;
      previewH  = previewCfg.canvasH;
      liveSlots = previewCfg.slots;
    } else {
      // 4×6: full canvas
      previewW  = config.canvasWidth;
      previewH  = config.canvasHeight;
      liveSlots = config.photoSlots;
    }

    containerEl.innerHTML = "";
    containerEl.classList.add("live-strip-row");

    const wrap = document.createElement("div");
    wrap.className = "live-strip-wrap";
    wrap.style.aspectRatio = `${previewW} / ${previewH}`;

    const videoEls = [];
    // { video, canvas, ctx, w, h } — one entry per video slot, drawn +
    // LUT-filtered every frame by the shared rAF loop below. Every other
    // shot in Print & QR (the still photos, the printed sheet) is already
    // filtered at capture time by cameraController.capturePhoto(); the
    // recorded video clips are NOT (recording has no filter-bake step —
    // see camera-controller.js), so without this the selected videos shown
    // here would be the only unfiltered thing on the page.
    const filteredVideoSlots = [];

    for (let i = 0; i < liveSlots.length; i++) {
      const slot = liveSlots[i];
      const photoIdx = (slot.photoIndex !== undefined) ? slot.photoIndex : config.slotToPhotoIndex[i];
      const shot = selectedShots[photoIdx];

      // Convert absolute px coords into % relative to the preview canvas dimensions
      const leftPct   = (slot.x / previewW) * 100;
      const topPct    = (slot.y / previewH) * 100;
      const widthPct  = (slot.w / previewW) * 100;
      const heightPct = (slot.h / previewH) * 100;

      const isVideo = shot && shot.videoUrl;
      const media = document.createElement(isVideo ? "video" : "img");
      media.className = "live-strip-media";
      media.style.borderRadius = `${config.slotCornerRadiusPct || 0}%`;

      // Apply CSS rotation for rotated slots (angle: 90).
      //
      // COORDINATE CONTRACT: slot.x/y/w/h are the absolute bounding-box
      // coordinates on the master canvas.  The visual bounding box must remain
      // exactly w × h at position (x, y) after any rotation.
      //
      // CSS transform: rotate() rotates around the element's centre (transform-
      // origin: 50% 50% by default).  After a 90° rotation the element's visual
      // size becomes h × w — the dimensions swap on screen.  To keep the visual
      // box at the spec-exact w × h position we therefore:
      //   1. Place the element at the rotated-interior size (h × w) so that after
      //      rotation it visually occupies the spec's w × h box.
      //   2. Shift left/top so the centre of the element aligns with the centre of
      //      the spec bounding box: cx = x + w/2, cy = y + h/2.
      //      Element's top-left (before rotation) = (cx − h/2, cy − w/2).
      if (slot.angle && slot.angle % 180 !== 0) {
        // Rotated case (90° or 270°): pre-swap w/h for CSS sizing so the post-
        // rotation visual box is the spec's w × h.  Reposition so the element
        // centre equals the spec bounding-box centre.
        const cx = slot.x + slot.w / 2;
        const cy = slot.y + slot.h / 2;
        const cssLeft   = ((cx - slot.h / 2) / previewW) * 100;
        const cssTop    = ((cy - slot.w / 2) / previewH) * 100;
        const cssWidth  = (slot.h / previewW) * 100;  // swapped
        const cssHeight = (slot.w / previewH) * 100;  // swapped
        media.style.left      = `${cssLeft}%`;
        media.style.top       = `${cssTop}%`;
        media.style.width     = `${cssWidth}%`;
        media.style.height    = `${cssHeight}%`;
        media.style.transform = `rotate(${slot.angle}deg)`;
        media.style.objectFit = "cover";
      } else {
        // Un-rotated (or 0°/180°): place directly at spec coordinates.
        media.style.left   = `${leftPct}%`;
        media.style.top    = `${topPct}%`;
        media.style.width  = `${widthPct}%`;
        media.style.height = `${heightPct}%`;
        if (slot.angle) {
          media.style.transform = `rotate(${slot.angle}deg)`;
          media.style.objectFit = "cover";
        }
      }

      if (isVideo) {
        media.src = shot.videoUrl;
        media.muted      = true;
        // Looping is handled manually by the synced loop ticker set up
        // below (see _createSyncedLoopTicker) instead of native <video>.loop,
        // so every clip stays in lockstep instead of drifting apart.
        media.loop       = false;
        media.playsInline = true;
        media.preload    = "auto";
        // Do NOT autoplay yet — we start all videos together below.
        // media itself is never shown — it's only a decode source for the
        // filtered canvas appended below. Kept in the DOM (not detached)
        // so playback/decoding stays reliable across browsers, just hidden.
        media.style.display = "none";
        videoEls.push(media);

        // Visible element: a canvas the same size/position as `media` would
        // have been, redrawn from it every frame by the shared rAF loop
        // below with the active photobooth.cube LUT baked in — see
        // filteredVideoSlots comment above.
        const canvas = document.createElement("canvas");
        canvas.className = "live-strip-media";
        canvas.style.cssText = media.style.cssText;
        canvas.style.display = ""; // undo media's display:none — canvas IS shown
        // Pixel resolution: the slot's own box size (already the swapped
        // h×w for rotated slots, matching the cssWidth/cssHeight set above)
        // — plenty sharp for an on-screen preview, no need to match the
        // video's native recording resolution.
        const boxPxW = (slot.angle && slot.angle % 180 !== 0) ? slot.h : slot.w;
        const boxPxH = (slot.angle && slot.angle % 180 !== 0) ? slot.w : slot.h;
        canvas.width  = Math.max(1, Math.round(boxPxW));
        canvas.height = Math.max(1, Math.round(boxPxH));

        wrap.appendChild(media);
        wrap.appendChild(canvas);
        filteredVideoSlots.push({ video: media, canvas, ctx: canvas.getContext("2d") });
      } else if (shot && shot.imageUrl) {
        media.src = shot.imageUrl;
        media.alt = "Selected photo";
        wrap.appendChild(media);
      }
    }

    if (overlayPath) {
      const overlayImg = document.createElement("img");
      overlayImg.className = "live-strip-overlay";
      overlayImg.src = overlayPath;
      overlayImg.alt = "Frame design";

      overlayImg.addEventListener("load", () => {
        if (frameType === "2x6") {
          // For single-strip uploads the image is already one-strip wide,
          // so it maps 1:1 to the rendered strip (no CSS width trick needed).
          // For legacy double-strip overlays, slice the left half by making
          // the img 200% wide so only copy 0 is visible.
          const isSingle = this._isSingleStripOverlay(overlayImg, frameType);
          if (!isSingle) {
            overlayImg.style.width  = "200%";
            overlayImg.style.left   = "0%";
            overlayImg.style.height = "100%";
            overlayImg.style.top    = "0";
          }
          // Single-strip: default 100% width / height is already correct
        } else if (previewCfg && previewCfg.previewIsLandscape) {
          /*
           * film-duo landscape preview:
           * The overlay PNG is the full 2400×3600 portrait print canvas.
           * The wrap is 3600×1200 landscape (aspect-ratio applied via CSS).
           * We need to rotate the overlay 90° CW and show only the left-strip
           * region (which becomes the top 1200px in portrait space).
           *
           * CSS approach: position the img at natural portrait size
           * (width = previewH = 1200px = 100% of wrap height),
           * rotate it 90° CW around the top-left corner, then shift.
           * This is complex with % units. Instead we use a simpler trick:
           * set width = wrap height (100% of a landscape parent = 1200px tall),
           * height = wrap width (100% of 3600px landscape width),
           * rotate transform-origin top-left 90deg CW, then translate.
           *
           * Simpler reliable approach: use a rotated absolutely-positioned img.
           *   - img natural ratio: 2400:3600 = 2:3 portrait.
           *   - After rotation, it's 3:2 landscape — but we only show the
           *     left 1200px of the portrait (which becomes the top 1200px of
           *     the landscape). We use overflow:hidden on the wrap.
           *
           * We express sizes relative to the wrap (3600×1200):
           *   Full portrait width (2400px) as % of wrap-height (1200px) = 200%
           *   Full portrait height (3600px) as % of wrap-width (3600px)  = 100%
           * Rotate 90° CW: translate(-100%, 0) rotate(90deg) — standard trick.
           */
          overlayImg.style.position        = "absolute";
          overlayImg.style.width           = `${(config.canvasHeight / previewH) * 100}%`; // 3600/1200=300%
          overlayImg.style.height          = `${(config.canvasWidth  / previewW) * 100}%`; // 2400/3600≈66.7%
          overlayImg.style.left            = "0";
          overlayImg.style.top             = "0";
          overlayImg.style.transformOrigin = "top left";
          overlayImg.style.transform       = "rotate(90deg) translateY(-100%)";
          overlayImg.style.pointerEvents   = "none";
        } else if (previewCfg) {
          // New frame types (long-duo, long-mini, wide-mini):
          // The overlay covers the full print canvas. Scale it so the
          // preview region fills 100% of the wrap, anchored at top-left.
          const config = LAYOUT_CONFIGS[frameType];
          const overlayWPct = (config.canvasWidth  / previewW) * 100;
          const overlayHPct = (config.canvasHeight / previewH) * 100;
          overlayImg.style.width  = `${overlayWPct}%`;
          overlayImg.style.height = `${overlayHPct}%`;
          overlayImg.style.left   = "0";
          overlayImg.style.top    = "0";
        }
        // 4×6: default 100% width / height is already correct
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

      Promise.all(readyPromises)
        // Fix MediaRecorder blobs reporting duration:Infinity before the
        // synced loop ticker below tries to read each clip's real length.
        .then(() => Promise.all(videoEls.map((v) => this._fixVideoDuration(v))))
        .then(() => {
        // Seek and play all videos atomically
        videoEls.forEach((v) => { v.currentTime = 0; });
        videoEls.forEach((v) => { v.play().catch(() => {}); });

        // Same smooth, synchronized 9-second-loop system used by the
        // uploaded/gallery video export (_createSyncedLoopTicker): every
        // clip loops together instead of drifting apart, and each clip's
        // trailing still-photo freeze-hold is trimmed so the loop never
        // shows a static frame. This preview loops indefinitely (no
        // recorder to stop), so only the loop mechanism is reused here,
        // not the fixed 9000ms recording length.
        const loopTick = this._createSyncedLoopTicker(videoEls);

        // Start the shared per-frame draw+filter loop for the visible
        // canvases now that their source videos are actually playing.
        if (filteredVideoSlots.length > 0) {
          const drawFilteredFrame = () => {
            loopTick();
            filteredVideoSlots.forEach(({ video, canvas, ctx }) => {
              if (video.readyState < 2) return; // no frame data yet this tick
              // Crop-to-fill the video's current frame into the canvas —
              // same behaviour object-fit:cover gave the plain <video> this
              // canvas replaced (canvas is already sized to the slot box).
              const vw = video.videoWidth, vh = video.videoHeight;
              if (!vw || !vh) return;
              const boxRatio = canvas.width / canvas.height;
              const vidRatio = vw / vh;
              let sx, sy, sw, sh;
              if (vidRatio > boxRatio) {
                sh = vh; sw = sh * boxRatio; sx = (vw - sw) / 2; sy = 0;
              } else {
                sw = vw; sh = sw / boxRatio; sx = 0; sy = (vh - sh) / 2;
              }
              ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
              if (typeof cameraFilterManager !== "undefined") {
                cameraFilterManager.applyLutToCanvasGL(canvas);
              }
            });
            this._liveFilterRAF = requestAnimationFrame(drawFilteredFrame);
          };
          this._liveFilterRAF = requestAnimationFrame(drawFilteredFrame);
        }
      });
    }
  },

  /*
   * Chromium/Electron MediaRecorder blobs commonly report `.duration` as
   * Infinity until the browser is forced to re-index the file by seeking
   * near the end and back to the start. The synced loop below needs each
   * clip's real length to know where to loop, so every video used by
   * exportVideoStrip is run through this first.
   */
  _fixVideoDuration(v) {
    return new Promise((resolve) => {
      if (v.duration && isFinite(v.duration)) { resolve(); return; }
      const done = () => { v.removeEventListener("timeupdate", done); v.currentTime = 0; resolve(); };
      v.addEventListener("timeupdate", done);
      v.currentTime = 1e7;
      // Safety net in case this browser never fires timeupdate for the seek.
      setTimeout(resolve, 400);
    });
  },

  /*
   * Keeps every clip in a video-strip export looping together instead of
   * each one restarting independently the instant IT reaches its own end.
   * Per-shot clip lengths differ by small amounts (recording start/stop is
   * async per shot), so native <video>.loop drifts the clips out of sync
   * with each other over several loop cycles. It also loops straight into
   * the ~600ms still-photo freeze-hold baked onto the end of every clip
   * (see shooting.js / cameraController.stopVideoRecording), which showed
   * up as a static photo inside what should be an all-video strip.
   *
   * Fix: disable native loop, trim every clip's usable window to end just
   * before its freeze-hold tail, and share the SHORTEST trimmed window
   * across all clips as the loop length — then manually rewind + replay
   * every clip together whenever that shared length is reached. Call the
   * returned function once per animation-frame tick.
   */
  _createSyncedLoopTicker(mediaEls) {
    const FREEZE_HOLD_SEC = 0.6; // matches stopVideoRecording's freeze-hold
    const videos = mediaEls.filter((m) => m && m.tagName === "VIDEO");
    if (!videos.length) return () => {};

    videos.forEach((v) => { v.loop = false; });

    const loopPoint = Math.max(
      0.15,
      Math.min(...videos.map((v) => {
        const d = (isFinite(v.duration) && v.duration > 0) ? v.duration : (FREEZE_HOLD_SEC + 0.15);
        return d - FREEZE_HOLD_SEC;
      }))
    );

    let resetting = false;
    return () => {
      if (resetting) return;
      if (!videos.some((v) => v.currentTime >= loopPoint)) return;
      resetting = true;
      videos.forEach((v) => { v.currentTime = 0; });
      Promise.all(videos.map((v) => {
        const p = v.play();
        return (p && p.then) ? p.catch(() => {}) : Promise.resolve();
      })).then(() => { resetting = false; });
    };
  },

  /*
   * COMBINED VIDEO STRIP EXPORT — records the full composited layout
   * (all 4 videos playing in their exact slots + frame overlay on top)
   * into ONE downloadable/shareable .webm/.mp4 file, matching the print
   * layout exactly but animated. Recording length matches durationMs —
   * default is 9000ms so the export plays a full 9-second loop of the
   * guest's clips.
   *
   * Video-only: slots with no recorded clip are left empty rather than
   * falling back to the still photo (see the `else` branches below), and
   * every clip's native `.loop` is disabled in favour of
   * _createSyncedLoopTicker(), which keeps all clips looping together and
   * trims each clip's trailing still-photo freeze-hold so the loop never
   * shows a static frame.
   *
   * singleStrip (default false) — when true and frameType is "2x6",
   * "long-duo", or "long-mini", only the LEFT strip (Frame 1) is rendered
   * onto a half-width canvas, matching the still-photo gallery export's
   * crop exactly. Used by the digital gallery export so guests download
   * one clean strip. Print-preview (Page 6 inline playback) is unaffected.
   */
  async exportVideoStrip({ frameType, selectedShots, designId, durationMs = 9000, scale = 0.3, singleStrip = false }) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    // film-duo uses a landscape preview canvas (3600×1200) with re-mapped slots.
    // Use the preview config slots/dimensions so the exported video matches what
    // the guest sees in the kiosk preview and gallery exactly.
    const previewCfg = this._getPreviewConfig(frameType);
    if (previewCfg && previewCfg.previewIsLandscape) {
      // Landscape film-duo export: 3600×1200 scaled canvas, landscape slots.
      const canvasW = Math.round(previewCfg.canvasW * scale);
      const canvasH = Math.round(previewCfg.canvasH * scale);

      const canvas = document.createElement("canvas");
      canvas.width  = canvasW;
      canvas.height = canvasH;
      const ctx = canvas.getContext("2d");

      const mediaEls = await Promise.all(
        previewCfg.slots.map((slot) => {
          const shot = selectedShots[slot.photoIndex];
          return new Promise((resolve) => {
            if (shot && shot.videoUrl) {
              const v = document.createElement("video");
              v.src = shot.videoUrl; v.muted = true; v.loop = true; v.playsInline = true;
              // Wait for play() itself to resolve, not just "canplay" — canplay
              // only means the browser COULD start playing, it fires before any
              // frame has actually begun decoding/rendering. Resolving here
              // (right after calling play(), not waiting for it) let drawFrame()
              // start compositing before the video had a real frame ready,
              // which is what produced the black screen at the start of the
              // exported clip.
              v.oncanplay = () => {
                const p = v.play();
                if (p && p.then) p.then(() => resolve(v)).catch(() => resolve(v));
                else resolve(v);
              };
              v.onerror = () => resolve(null);
            } else {
              // Video-only strip: no still-photo fallback for slots
              // without a recorded clip — leave the slot empty instead.
              resolve(null);
            }
          });
        })
      );

      // Fix MediaRecorder blobs reporting duration:Infinity, then start a
      // manually-synchronized, seamless loop across every clip instead of
      // relying on native <video>.loop (see _createSyncedLoopTicker above).
      await Promise.all(
        mediaEls.filter((m) => m && m.tagName === "VIDEO").map((v) => this._fixVideoDuration(v))
      );
      const _loopTick = this._createSyncedLoopTicker(mediaEls);

      const design = this.getDesign(designId);
      const overlayPath = design && design.overlays && design.overlays[frameType];
      const overlayImg = overlayPath ? await this.loadImage(overlayPath) : null;

      const drawFrame = () => {
        ctx.clearRect(0, 0, canvasW, canvasH);
        previewCfg.slots.forEach((slot, i) => {
          const media = mediaEls[i];
          if (!media) return;
          const mw = media.videoWidth || media.width;
          const mh = media.videoHeight || media.height;
          const boxRatio = (slot.w * scale) / (slot.h * scale);
          const mediaRatio = mw / mh;
          let sx, sy, sw, sh;
          if (mediaRatio > boxRatio) {
            sh = mh; sw = sh * boxRatio; sx = (mw - sw) / 2; sy = 0;
          } else {
            sw = mw; sh = sw / boxRatio; sx = 0; sy = (mh - sh) / 2;
          }
          ctx.drawImage(media, sx, sy, sw, sh,
            slot.x * scale, slot.y * scale, slot.w * scale, slot.h * scale);
        });
        // Bake in the active photobooth.cube LUT, matching the filtered
        // clips already shown live on the Print & QR page (renderLive) —
        // recorded video has no filter baked in at capture time (see the
        // renderLive doc comment), so without this the uploaded/gallery
        // video would be the one unfiltered copy of the session. Applied
        // only to the photo/video content, before the (unfiltered) frame
        // overlay is drawn on top, same as the live preview.
        if (typeof cameraFilterManager !== "undefined") {
          cameraFilterManager.applyLutToCanvasGL(canvas);
        }
        if (overlayImg) {
          // For the landscape video export, rotate the portrait overlay 90° CW
          // and clip to the left-strip region, same as the canvas composite.
          ctx.save();
          ctx.translate(canvasW, 0);
          ctx.rotate(Math.PI / 2);
          ctx.drawImage(overlayImg,
            0, 0, 1200, config.canvasHeight,
            0, 0, Math.round(1200 * scale), Math.round(config.canvasHeight * scale)
          );
          ctx.restore();
        }
      };

      const stream = canvas.captureStream(30);
      const videoMimeCandidates = [
        "video/mp4;codecs=h264", "video/mp4",
        "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"
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
          const finalBlob = await remuxToMp4(rawBlob);
          resolve(finalBlob);
        };
        let rafId;
        const tick = () => { _loopTick(); drawFrame(); rafId = requestAnimationFrame(tick); };

        // Draw a first real frame (the media elements are already playing —
        // see the play()-promise wait above), then give the browser two
        // animation frames to actually paint it before starting the
        // recorder. Starting the recorder against a canvas that technically
        // has drawImage() calls queued but hasn't been composited yet is
        // what produced the ~1s black screen at the start of every export.
        tick();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            recorder.start();
            setTimeout(() => { cancelAnimationFrame(rafId); recorder.stop(); }, durationMs);
          });
        });
      });
    }

    // For 2x6 singleStrip mode, and for the Long Duo / Long Mini gallery
    // video, only the LEFT strip (Frame 1) is rendered onto a half-width
    // canvas — the same crop the still-photo gallery export (exportPNG
    // singleStrip) already uses, so the video strip matches the uploaded
    // photo/video crop exactly instead of the full multi-frame print
    // template. film-duo/wide-mini and non-singleStrip 2x6 still render
    // their full sheet.
    const isLeftStripOnly = singleStrip && (
      frameType === "2x6" || frameType === "long-duo" || frameType === "long-mini"
    );
    const totalCopies = frameType === "2x6" ? 2 : 1;
    const copies = (frameType === "2x6" && singleStrip) ? 1 : totalCopies;
    // Long Duo / Long Mini: Frame 1 (the left strip) is always the first 4 slots.
    const leftSlotCount = frameType === "2x6"
      ? Math.round(config.photoSlots.length / totalCopies)
      : 4;
    // Slots to draw: left strip only when isLeftStripOnly, all slots otherwise.
    const slotsToRender = isLeftStripOnly
      ? config.photoSlots.slice(0, leftSlotCount)
      : config.photoSlots;
    // Canvas is half-width whenever we're rendering just the left strip.
    const canvasW = isLeftStripOnly
      ? Math.round((config.canvasWidth / 2) * scale)
      : Math.round((config.canvasWidth / totalCopies) * copies * scale);
    const canvasH = Math.round(config.canvasHeight * scale);

    const canvas = document.createElement("canvas");
    canvas.width  = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");

    // Preload hidden <video> elements for every slot that has a video.
    // Video-only strip: slots without a recorded clip resolve to null and
    // are simply skipped when drawing (see the `else` branch below).
    // In left-strip-only mode we only load Frame 1's slots.
    const mediaEls = await Promise.all(
      slotsToRender.map((slot, i) => {
        const photoIdx = (slot.photoIndex !== undefined) ? slot.photoIndex : config.slotToPhotoIndex[i];
        const shot = selectedShots[photoIdx];
        return new Promise((resolve) => {
          if (shot && shot.videoUrl) {
            const v = document.createElement("video");
            v.src = shot.videoUrl;
            v.muted = true;
            v.loop = true;
            v.playsInline = true;
            // Wait for play() to actually resolve, not just "canplay" — see
            // the matching comment in the landscape film-duo branch above.
            // Fixes the black screen at the start of the exported clip.
            v.oncanplay = () => {
              const p = v.play();
              if (p && p.then) p.then(() => resolve(v)).catch(() => resolve(v));
              else resolve(v);
            };
            v.onerror = () => resolve(null);
          } else {
            // Video-only strip: no still-photo fallback for slots
            // without a recorded clip — leave the slot empty instead.
            resolve(null);
          }
        });
      })
    );

    // Fix MediaRecorder blobs reporting duration:Infinity, then start a
    // manually-synchronized, seamless loop across every clip instead of
    // relying on native <video>.loop (see _createSyncedLoopTicker above).
    await Promise.all(
      mediaEls.filter((m) => m && m.tagName === "VIDEO").map((v) => this._fixVideoDuration(v))
    );
    const _loopTick = this._createSyncedLoopTicker(mediaEls);

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
      // Bake in the active photobooth.cube LUT, matching the filtered
      // clips already shown live on the Print & QR page (renderLive) —
      // recorded video has no filter baked in at capture time (see the
      // renderLive doc comment), so without this the uploaded/gallery
      // video would be the one unfiltered copy of the session. Applied
      // only to the photo/video content, before the (unfiltered) frame
      // overlay is drawn on top, same as the live preview.
      if (typeof cameraFilterManager !== "undefined") {
        cameraFilterManager.applyLutToCanvasGL(canvas);
      }
      if (overlayImg) {
        if (isLeftStripOnly) {
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
      const tick = () => { _loopTick(); drawFrame(); rafId = requestAnimationFrame(tick); };

      // Same warmup as the landscape film-duo branch above: draw a real
      // frame first, then give the browser two animation frames to paint it
      // before starting the recorder, so the recording doesn't start against
      // an unpainted canvas.
      tick();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          recorder.start();
          setTimeout(() => {
            cancelAnimationFrame(rafId);
            recorder.stop();
          }, durationMs);
        });
      });
    });
  },

  /*
   * STITCHED VIDEO EXPORT — concatenates the 4 selected shots' clips into
   * ONE continuous clip, played back-to-back in order (Video 1 → 2 → 3 →
   * 4), instead of the four clips playing simultaneously side-by-side in
   * the print-layout slots (see exportVideoStrip above). This is what
   * both the Print & QR flow (sessionState.finalStripVideo /
   * finalStripVideoPromise, see qr.js) and the digital gallery use as
   * "the video" now.
   *
   * Each clip's trailing still-photo freeze-hold (baked on by
   * cameraController.stopVideoRecording — see shooting.js) is trimmed so
   * the cut into the next clip lands while motion is still happening: no
   * frozen photo frame, no blank/black frame, no pause between clips. A
   * slot with no recorded video is simply skipped — the result is
   * video-only, same as exportVideoStrip.
   *
   * The camera's photobooth.cube LUT filter is baked in per frame,
   * matching the filtered clips already shown live during shooting —
   * recorded clips have no filter baked in at capture time (see
   * renderLive's doc comment), so without this the stitched export would
   * be the one unfiltered artifact from the whole session.
   *
   * The exported file is exactly one pass through the (trimmed) clips —
   * a guest-facing <video loop> then repeats that pass natively for
   * "continuous" playback, same as any other looping video file.
   */
  async exportStitchedVideo({ selectedShots }) {
    const FREEZE_HOLD_SEC = 0.6; // matches stopVideoRecording's freeze-hold

    const clipUrls = (selectedShots || [])
      .filter((shot) => shot && shot.videoUrl)
      .map((shot) => shot.videoUrl);

    if (!clipUrls.length) return null;

    // Preload every clip as a hidden <video>, fix Infinity-duration blobs
    // (see _fixVideoDuration above), and trim each one's usable window to
    // end just before its freeze-hold.
    const videos = await Promise.all(
      clipUrls.map(
        (url) =>
          new Promise((resolve) => {
            const v = document.createElement("video");
            v.src = url;
            v.muted = true;
            v.playsInline = true;
            v.preload = "auto";
            const onReady = () => {
              v.removeEventListener("canplay", onReady);
              v.removeEventListener("error", onReady);
              resolve(v);
            };
            v.addEventListener("canplay", onReady, { once: true });
            v.addEventListener("error", onReady, { once: true });
          })
      )
    );
    await Promise.all(videos.map((v) => this._fixVideoDuration(v)));
    const trimmedDurations = videos.map((v) => {
      const d = (isFinite(v.duration) && v.duration > 0) ? v.duration : (FREEZE_HOLD_SEC + 0.15);
      return Math.max(0.15, d - FREEZE_HOLD_SEC);
    });

    // Canvas sized to the first clip's native video dimensions — the
    // stitched export is raw clip content, not framed into the print
    // layout's tiny photo slots, so there's no fixed layout size to match.
    const firstVideo = videos.find((v) => v.videoWidth && v.videoHeight) || videos[0];
    const canvasW = firstVideo.videoWidth  || 1080;
    const canvasH = firstVideo.videoHeight || 1920;
    const canvas = document.createElement("canvas");
    canvas.width  = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");

    const drawCropFill = (video) => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;
      const boxRatio = canvasW / canvasH;
      const vidRatio = vw / vh;
      let sx, sy, sw, sh;
      if (vidRatio > boxRatio) {
        sh = vh; sw = sh * boxRatio; sx = (vw - sw) / 2; sy = 0;
      } else {
        sw = vw; sh = sw / boxRatio; sx = 0; sy = (vh - sh) / 2;
      }
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvasW, canvasH);
    };

    let activeIndex = 0;
    videos.forEach((v) => { v.loop = false; v.pause(); v.currentTime = 0; });
    videos[0].play().catch(() => {});

    const drawFrame = () => {
      const active = videos[activeIndex];
      ctx.clearRect(0, 0, canvasW, canvasH);
      if (active && active.readyState >= 2) {
        drawCropFill(active);
        if (typeof cameraFilterManager !== "undefined") {
          cameraFilterManager.applyLutToCanvasGL(canvas);
        }
      }
      // Advance to the next clip once the active one hits its trimmed
      // duration. The next clip is already preloaded (preload="auto"), so
      // starting it here is effectively instant for these local blob
      // clips — a hard cut with no blank frame in between.
      if (active && active.currentTime >= trimmedDurations[activeIndex] && activeIndex < videos.length - 1) {
        active.pause();
        activeIndex += 1;
        videos[activeIndex].currentTime = 0;
        videos[activeIndex].play().catch(() => {});
      }
    };

    const totalDurationMs = Math.round(trimmedDurations.reduce((a, b) => a + b, 0) * 1000) + 200;

    const stream = canvas.captureStream(30);
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
        videos.forEach((v) => v.pause());
        const rawBlob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
        // Re-mux into a properly finalized MP4, same as exportVideoStrip,
        // so the downloaded/shared video works everywhere.
        const finalBlob = await remuxToMp4(rawBlob);
        resolve(finalBlob);
      };

      let rafId;
      const tick = () => { drawFrame(); rafId = requestAnimationFrame(tick); };

      // Warm up: draw real frames before starting the recorder so it
      // doesn't start against an unpainted canvas (same as exportVideoStrip).
      tick();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          recorder.start();
          setTimeout(() => {
            cancelAnimationFrame(rafId);
            recorder.stop();
          }, totalDurationMs);
        });
      });
    });
  },

/*
   * Full-resolution PNG export — 2400×3600 for all frame types except film-duo.
   *
   * film-duo gallery export:
   *   Produces a LANDSCAPE 3600×1200 canvas matching the kiosk preview exactly,
   *   so the gallery strip and kiosk preview are visually identical.
   *   The print path (exportPrintPNG) always uses the full 2400×3600 portrait canvas.
   */
  async exportPNG(opts) {
    const { frameType, selectedShots, designId } = opts;

    // film-duo: export landscape gallery strip using the same preview composite
    if (frameType === "film-duo") {
      return new Promise(async (resolve) => {
        const previewCfg = this._getPreviewConfig("film-duo");
        const config     = LAYOUT_CONFIGS["film-duo"];

        const canvas = document.createElement("canvas");
        canvas.width  = previewCfg.canvasW; // 3600
        canvas.height = previewCfg.canvasH; // 1200
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Thumbnail background
        const thumbSrc = this._getFrameThumbnail("film-duo");
        try {
          const thumbImg = await this.loadImage(thumbSrc);
          if (thumbImg) {
            this.drawCropFill(ctx, thumbImg, 0, 0, canvas.width, canvas.height);
            ctx.save(); ctx.globalAlpha = 0.18; ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.restore();
          }
        } catch (_) {}

        // Photos in landscape slot positions
        const photoImages = await Promise.all(
          (selectedShots || []).map((shot) =>
            shot && shot.imageUrl ? this.loadImage(shot.imageUrl) : Promise.resolve(null)
          )
        );
        previewCfg.slots.forEach((slot) => {
          const img = photoImages[slot.photoIndex];
          if (img) {
            this.drawCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h);
          } else {
            ctx.save(); ctx.strokeStyle = "rgba(180,180,180,0.5)"; ctx.lineWidth = 3;
            ctx.strokeRect(slot.x + 2, slot.y + 2, slot.w - 4, slot.h - 4); ctx.restore();
          }
        });

        // Overlay: rotate portrait overlay 90° CW and clip to left-strip region
        const design = this.getDesign(designId);
        if (design) {
          const previewPath = design.previewOverlays && design.previewOverlays["film-duo"];
          if (previewPath) {
            const previewImg = await this.loadImage(previewPath);
            if (previewImg) {
              ctx.drawImage(previewImg, 0, 0, canvas.width, canvas.height);
            }
          } else {
            const overlayPath = design.overlays && design.overlays["film-duo"];
            if (overlayPath) {
              const overlayImg = await this.loadImage(overlayPath);
              if (overlayImg) {
                ctx.save();
                ctx.translate(canvas.width, 0);
                ctx.rotate(Math.PI / 2);
                ctx.drawImage(overlayImg,
                  0, 0, 1200, config.canvasHeight,
                  0, 0, 1200, config.canvasHeight
                );
                ctx.restore();
              }
            }
          }
        }

        canvas.toBlob(resolve, "image/png");
      });
    }

    const canvas = await this.compositeLayout(opts);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  },

  /*
   * DEBUG ONLY — same output as exportPNG() but with the exact slot
   * boundaries (from LAYOUT_CONFIGS) drawn on top in red, plus QR
   * placements in blue. Use this to verify a design overlay PNG's
   * transparent windows against the real coordinates before/after
   * re-exporting the template artwork.
   *
   * Console usage (DevTools, kiosk or admin window):
   *   stripModule.exportDebugPNG({
   *     frameType: "long-mini",
   *     selectedShots: sessionState.selectedShots,   // or any 4 shots with .imageUrl
   *     designId: sessionState.design
   *   }).then(blob => {
   *     const a = document.createElement("a");
   *     a.href = URL.createObjectURL(blob);
   *     a.download = "long-mini-debug.png";
   *     a.click();
   *   });
   *
   * REMOVE this method (and the debugSlots branch in compositeLayout)
   * once overlay templates have been re-aligned and verified.
   */
  async exportDebugPNG({ frameType, selectedShots, designId }) {
    const canvas = await this.compositeLayout({ frameType, selectedShots, designId, debugSlots: true });
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  },

  /* Exact pixel placements for the printed QR code(s), per your spec.
     2x6 has two identical strips side by side, each gets its own QR.
     New frame types use qrPlacements from LAYOUT_CONFIGS when available,
     falling back to these hardcoded values.
     Units match the 2400x3600 @ 600dpi canvas.
     angle: 90 means the QR is rotated 90° clockwise (film-duo only). */
  QR_PLACEMENTS: {
    "2x6": [
      { x: 881,  y: 33.09, w: 250, h: 250 },
      { x: 2081, y: 33.09, w: 250, h: 250 }
    ],
    "4x6": [
      { x: 2089, y: 34.09, w: 250, h: 250 }
    ],
    // New frame types — exact positions per spec; sourced from LAYOUT_CONFIGS.qrPlacements at runtime.
    // These fallbacks are only used if LAYOUT_CONFIGS is not yet loaded.
    "long-duo":  [{ x: 914.5,   y: 31.59,   w: 250, h: 250 }],
    "long-mini": [{ x: 914.5,   y: 31.59,   w: 250, h: 250 }],
    "film-duo":  [{ x: 903.91,  y: 3309.97, w: 250, h: 250, angle: 90 }],
    "wide-mini": [{ x: 2111.38, y: 47.59,   w: 250, h: 250 }]
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

      // Prefer per-config qrPlacements (most accurate) over the static table fallback.
      const config = LAYOUT_CONFIGS[frameType];
      const placements = (config && config.qrPlacements) || this.QR_PLACEMENTS[frameType] || [];

      if (placements.length) {
        const qrSize = placements[0].w; // all placements use the same W footprint
        const qrSource = generateQrCanvas(qrText, qrSize, {
          correctLevel: QRCode.CorrectLevel.L,
          quietModules: 2
        });

        placements.forEach((p) => {
          ctx.save();

          if (p.angle) {
            // Rotated QR (e.g. film-duo bottom QR at 90°).
            // Rotate around the centre of the QR bounding box.
            const rad = (p.angle * Math.PI) / 180;
            const cx  = p.x + p.w / 2;
            const cy  = p.y + p.h / 2;

            // White backing — draw as a rotated rectangle so it exactly
            // covers the footprint under the rotated QR code.
            ctx.translate(cx, cy);
            ctx.rotate(rad);
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(qrSource, -p.w / 2, -p.h / 2, p.w, p.h);
          } else {
            // Standard axis-aligned QR.
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(p.x, p.y, p.w, p.h);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(qrSource, p.x, p.y, p.w, p.h);
          }

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