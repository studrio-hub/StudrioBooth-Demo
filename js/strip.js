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
   * Renders into a container div as a single canvas, CSS-scaled for kiosk display.
   *
   * For the selection (Page 4) and design (Page 5) preview containers, wraps
   * the canvas in a .single-strip-clip div that clips the 2×6 two-up canvas
   * down to one strip width. This is purely visual — the canvas itself is the
   * full-resolution composite and is never modified.
   */
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

  async render(containerEl, opts) {
    // For the selection preview (Page 4), always apply the Original overlay
    // even when sessionState.design is not yet set.
    let renderOpts = opts;
    if (containerEl.id === "stripPreviewContainer" && !opts.designId) {
      const orig = this._getOriginalDesign();
      if (orig) renderOpts = { ...opts, designId: orig.id };
    }

    const canvas = await this.compositeLayout(renderOpts);
    containerEl.innerHTML = "";
    canvas.classList.add("layout-canvas");

    // Determine if this container is a preview column (selection or design page)
    const isPreviewCol =
      containerEl.id === "stripPreviewContainer" ||
      containerEl.id === "designPreviewContainer";

    if (isPreviewCol && opts.frameType === "2x6") {
      // Clip to single strip: wrap canvas in a container that is 50% of canvas width
      const clip = document.createElement("div");
      clip.className = "single-strip-clip";
      clip.dataset.frame = "2x6";
      clip.appendChild(canvas);
      containerEl.appendChild(clip);
    } else if (isPreviewCol) {
      // 4x6 — use clip wrapper too so CSS rules apply uniformly
      const clip = document.createElement("div");
      clip.className = "single-strip-clip";
      clip.dataset.frame = opts.frameType || "4x6";
      clip.appendChild(canvas);
      containerEl.appendChild(clip);
    } else {
      containerEl.appendChild(canvas);
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
   * Renders the selectable design swatches into a container (Page 5).
   * Builds every swatch button immediately (so the picker is tappable
   * right away, even before any thumbnail has rendered), then composites
   * each thumbnail in parallel at a small scale and drops it in as soon
   * as it's ready — nothing blocks on anything else.
   */
  async renderSwatchPicker(containerEl, currentDesignId, onSelect) {
    containerEl.innerHTML = "";

    const opts = {
      frameType: sessionState.frameType || "2x6",
      selectedShots: sessionState.selectedShots
    };

    const entries = STRIP_DESIGNS.map((design) => {
      const swatch = document.createElement("button");
      swatch.className = "design-swatch" + (design.id === currentDesignId ? " selected" : "");
      swatch.dataset.designId = design.id;

      const previewWrap = document.createElement("div");
      previewWrap.className = "design-swatch-preview-wrap";
      previewWrap.innerHTML = `<div class="design-swatch-skeleton"></div>`;

      const name = document.createElement("span");
      name.className = "design-swatch-name";
      name.textContent = design.label;

      swatch.appendChild(previewWrap);
      swatch.appendChild(name);

      swatch.addEventListener("click", () => {
        containerEl.querySelectorAll(".design-swatch").forEach((el) => el.classList.remove("selected"));
        swatch.classList.add("selected");
        onSelect(design.id);
      });

      containerEl.appendChild(swatch);
      return { design, previewWrap };
    });

    // Fire off all thumbnail composites concurrently; each fills in its
    // own swatch the moment it's done, independent of the others.
    entries.forEach(({ design, previewWrap }) => {
      this.compositeLayoutScaled({ ...opts, designId: design.id }, 0.18)
        .then((canvas) => {
          canvas.classList.add("design-swatch-canvas");
          previewWrap.innerHTML = "";
          previewWrap.appendChild(canvas);
        })
        .catch((e) => console.warn(`[stripModule] Swatch render failed for "${design.id}":`, e));
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

  async init() {
    if (!sessionState.design) {
      sessionState.design = STRIP_DESIGNS[0].id;
    }

    await stripModule.renderSwatchPicker(this.els.options, sessionState.design, (designId) => {
      sessionState.design = designId;
      this.renderPreview();
    });

    this.renderPreview();
    this.els.nextBtn.disabled = false;

    // A design is always auto-assigned above, so on timeout we can just
    // proceed with whatever's currently selected — no fallback needed.
    kioskTimer.start(60, () => {
      if (this.els.nextBtn && !this.els.nextBtn.disabled) this.els.nextBtn.click();
    });
  },

  renderPreview() {
    stripModule.render(this.els.previewContainer, {
      frameType: sessionState.frameType || "2x6",
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design
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