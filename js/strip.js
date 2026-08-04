/*
 * STRIP.JS — shared strip rendering + design catalog.
 * Used by Page 4 (selection preview) and Page 5 (design preview).
 * Also imported later by printing.js / qr.js for the final render.
 *
 * TEMPLATE LOADING CHANGE:
 *   Previously, STRIP_DESIGNS was a hardcoded array in this file.
 *   Now it is populated from assetSync.getTemplates() after the kiosk
 *   boots and syncs with Supabase. The overlay URLs are blob: URLs
 *   pointing to locally-cached files rather than static asset paths.
 *
 *   The API is backward compatible — all callers use stripModule.getDesign(id)
 *   and the overlays object — but the object shape changes slightly:
 *     overlays: { "2x6": blob:url, "4x6": blob:url }
 *   instead of:
 *     overlays: { "2x6": "assets/designs/2x6/Name.png", "4x6": null }
 *
 *   If assetSync hasn't synced yet (or returns empty), an empty array
 *   is used and the kiosk shows no design options until sync completes.
 */

// STRIP_DESIGNS is populated by initDesigns() once assetSync is ready.
// All other code should call stripModule.getDesign() / stripModule.getAllDesigns()
// rather than referencing STRIP_DESIGNS directly.
let STRIP_DESIGNS = [];

/*
 * initDesigns() — called by boot.js after assetSync.init() resolves.
 * Converts the assetSync template records into the shape strip.js expects.
 */
function initDesigns() {
  const templates = (typeof assetSync !== "undefined") ? assetSync.getTemplates() : [];

  STRIP_DESIGNS = templates.map((t) => ({
    id:       t.id,
    label:    t.name,
    cssClass: `theme-${t.id}`,  // dynamic CSS class (no longer needs to exist in style.css)
    overlays: {
      "2x6": t.overlayUrl2x6 || null,
      "4x6": t.overlayUrl4x6 || null
    },
    // Pass through extra fields for display/admin use
    type:         t.asset_type || "frame_template",
    sortOrder:    t.sort_order || 0,
    thumbnailUrl: t.thumbnailUrl || null
  }));

  console.log(`[stripModule] Loaded ${STRIP_DESIGNS.length} designs from asset sync.`);

  // Warm the image cache immediately with the synced overlays
  stripModule.preloadDesignOverlays();
}

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
    correctLevel = QRCode.CorrectLevel.L,
    quietModules = 2
  } = options;

  const holder = document.createElement("div");
  const widget = new QRCode(holder, { text, width: 1, height: 1, correctLevel });
  const model  = widget._oQRCode;

  if (!model || typeof model.isDark !== "function") {
    console.warn("[stripModule] QR internal module grid unavailable, falling back to library render.");
    const fallbackHolder = document.createElement("div");
    new QRCode(fallbackHolder, { text, width: size, height: size, correctLevel });
    return fallbackHolder.querySelector("canvas") || document.createElement("canvas");
  }

  const moduleCount   = model.moduleCount;
  const totalModules  = moduleCount + quietModules * 2;
  const pixelsPerModule = Math.max(1, Math.round(size / totalModules));
  const canvasSize    = pixelsPerModule * totalModules;

  const canvas  = document.createElement("canvas");
  canvas.width  = canvasSize;
  canvas.height = canvasSize;
  const ctx     = canvas.getContext("2d");

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
    return STRIP_DESIGNS.find((d) => d.id === id) || null;
  },

  getAllDesigns() {
    return STRIP_DESIGNS;
  },

  loadImage(src) {
    if (this._imageCache.has(src)) return this._imageCache.get(src);
    const promise = new Promise((resolve) => {
      const img = new Image();
      img.onload  = () => resolve(img);
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
      sh = img.height; sw = sh * boxRatio; sx = (img.width - sw) / 2; sy = 0;
    } else {
      sw = img.width; sh = sw / boxRatio; sx = 0; sy = (img.height - sh) / 2;
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

    const canvas  = document.createElement("canvas");
    canvas.width  = config.canvasWidth;
    canvas.height = config.canvasHeight;
    const ctx     = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

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

    // Layer: frame design overlay ON TOP of the photos
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

  /*
   * Kick off background loading of every design's overlay PNG as soon as
   * designs are loaded (called by initDesigns() above).
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
   * resolution.
   */
  async compositeLayoutScaled({ frameType, selectedShots, designId }, scale = 0.18) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    const canvas  = document.createElement("canvas");
    canvas.width  = Math.round(config.canvasWidth * scale);
    canvas.height = Math.round(config.canvasHeight * scale);
    const ctx     = canvas.getContext("2d");
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
        if (overlayImg) ctx.drawImage(overlayImg, 0, 0, canvas.width, canvas.height);
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

  /*
   * LIVE VIDEO STRIP — used on the printing page as a DOM-based live strip.
   * Falls back to the still photo if a slot has no video.
   */
  renderLive(containerEl, { frameType, selectedShots, designId }) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    const design      = this.getDesign(designId);
    const overlayPath = design && design.overlays && design.overlays[frameType];
    const copies      = frameType === "2x6" ? 2 : 1;
    const slotsPerCopy = config.photoSlots.length / copies;

    containerEl.innerHTML = "";
    containerEl.classList.add("live-strip-row");

    for (let c = 0; c < copies; c++) {
      const wrap = document.createElement("div");
      wrap.className = "live-strip-wrap";
      wrap.style.aspectRatio = `${config.canvasWidth / copies} / ${config.canvasHeight}`;

      for (let i = 0; i < slotsPerCopy; i++) {
        const slotIndex = c * slotsPerCopy + i;
        const slot  = config.photoSlots[slotIndex];
        const shot  = selectedShots[config.slotToPhotoIndex[slotIndex]];
        const stripWidth = config.canvasWidth / copies;
        const localX = slot.x - c * stripWidth;
        const leftPct   = (localX / stripWidth) * 100;
        const topPct    = (slot.y / config.canvasHeight) * 100;
        const widthPct  = (slot.w / stripWidth) * 100;
        const heightPct = (slot.h / config.canvasHeight) * 100;

        const media = document.createElement(shot && shot.videoUrl ? "video" : "img");
        media.className = "live-strip-media";
        media.style.left   = `${leftPct}%`;
        media.style.top    = `${topPct}%`;
        media.style.width  = `${widthPct}%`;
        media.style.height = `${heightPct}%`;
        media.style.borderRadius = `${config.slotCornerRadiusPct || 0}%`;

        if (shot && shot.videoUrl) {
          media.src = shot.videoUrl; media.muted = true;
          media.autoplay = true; media.loop = true; media.playsInline = true;
        } else if (shot && shot.imageUrl) {
          media.src = shot.imageUrl; media.alt = "Selected photo";
        }
        wrap.appendChild(media);
      }

      if (overlayPath) {
        const overlayImg = document.createElement("img");
        overlayImg.className = "live-strip-overlay";
        overlayImg.src = overlayPath;
        overlayImg.alt = "Frame design";
        if (copies > 1) {
          overlayImg.style.width  = `${copies * 100}%`;
          overlayImg.style.left   = `${c * -100}%`;
          overlayImg.style.height = "100%";
          overlayImg.style.top    = "0";
        }
        wrap.appendChild(overlayImg);
      }

      containerEl.appendChild(wrap);
    }
  },

  /*
   * COMBINED VIDEO STRIP EXPORT — records the full composited layout
   * into one downloadable MP4 file, matching the print layout exactly.
   */
  async exportVideoStrip({ frameType, selectedShots, designId, durationMs = 3000, scale = 0.3 }) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    const canvas  = document.createElement("canvas");
    canvas.width  = Math.round(config.canvasWidth * scale);
    canvas.height = Math.round(config.canvasHeight * scale);
    const ctx     = canvas.getContext("2d");

    const mediaEls = await Promise.all(
      config.photoSlots.map((slot, i) => {
        const shot = selectedShots[config.slotToPhotoIndex[i]];
        return new Promise((resolve) => {
          if (shot && shot.videoUrl) {
            const v = document.createElement("video");
            v.src = shot.videoUrl; v.muted = true; v.loop = true; v.playsInline = true;
            v.oncanplay = () => { v.play(); resolve(v); };
            v.onerror   = () => resolve(null);
          } else if (shot && shot.imageUrl) {
            const img = new Image();
            img.onload  = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = shot.imageUrl;
          } else {
            resolve(null);
          }
        });
      })
    );

    const design      = this.getDesign(designId);
    const overlayPath = design && design.overlays && design.overlays[frameType];
    const overlayImg  = overlayPath ? await this.loadImage(overlayPath) : null;

    const drawMediaCropFill = (media, x, y, w, h) => {
      const mw = media.videoWidth || media.width;
      const mh = media.videoHeight || media.height;
      const mediaRatio = mw / mh;
      const boxRatio   = w / h;
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
      config.photoSlots.forEach((slot, i) => {
        const media = mediaEls[i];
        if (media) {
          drawMediaCropFill(media, slot.x * scale, slot.y * scale, slot.w * scale, slot.h * scale);
        }
      });
      if (overlayImg) {
        ctx.drawImage(overlayImg, 0, 0, canvas.width, canvas.height);
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
        const rawBlob  = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
        const finalBlob = await remuxToMp4(rawBlob);
        resolve(finalBlob);
      };
      let rafId;
      const tick = () => { drawFrame(); rafId = requestAnimationFrame(tick); };
      tick();
      recorder.start();
      setTimeout(() => { cancelAnimationFrame(rafId); recorder.stop(); }, durationMs);
    });
  },

  /* Full-resolution PNG export — exact 2400x3600, all layers composited. */
  async exportPNG(opts) {
    const canvas = await this.compositeLayout(opts);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  },

  /* Exact pixel placements for the printed QR code(s), per spec.
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
   */
  async exportPrintPNG({ frameType, selectedShots, designId, qrText }) {
    const canvas = await this.compositeLayout({ frameType, selectedShots, designId });

    if (qrText) {
      const ctx        = canvas.getContext("2d");
      const placements = this.QR_PLACEMENTS[frameType] || [];

      if (placements.length) {
        const qrSize = placements[0].w;
        const qrSource = generateQrCanvas(qrText, qrSize, {
          correctLevel: QRCode.CorrectLevel.L,
          quietModules: 2
        });
        placements.forEach((p) => {
          ctx.save();
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(p.x, p.y, p.w, p.h);
          ctx.restore();
          ctx.save();
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(qrSource, p.x, p.y, p.w, p.h);
          ctx.restore();
        });
      }
    } else {
      console.warn("[stripModule] exportPrintPNG called with no qrText — printing without QR code.");
    }

    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  },

  /*
   * Renders the selectable design swatches into a container (Page 5).
   * Builds every swatch button immediately (tappable right away), then
   * composites each thumbnail in parallel and drops it in as soon as ready.
   */
  async renderSwatchPicker(containerEl, currentDesignId, onSelect) {
    containerEl.innerHTML = "";

    const opts = {
      frameType: sessionState.frameType || "2x6",
      selectedShots: sessionState.selectedShots
    };

    // Only show designs that have an overlay for the currently-selected frame type.
    const availableDesigns = STRIP_DESIGNS.filter(
      (d) => d.overlays && d.overlays[opts.frameType]
    );

    // Auto-select first available design if current one isn't available for this frame type.
    if (currentDesignId && !availableDesigns.find((d) => d.id === currentDesignId)) {
      const fallback = availableDesigns[0];
      if (fallback) {
        sessionState.design = fallback.id;
        currentDesignId     = fallback.id;
      }
    }

    const entries = availableDesigns.map((design) => {
      const swatch = document.createElement("button");
      swatch.className = "design-swatch" + (design.id === currentDesignId ? " selected" : "");
      swatch.dataset.designId = design.id;

      const previewWrap = document.createElement("div");
      previewWrap.className = "design-swatch-preview-wrap";

      // If the template has a dedicated thumbnail blob URL, show it immediately
      // (no compositing needed) — much faster than the full canvas composite path.
      if (design.thumbnailUrl) {
        const thumb = document.createElement("img");
        thumb.className = "design-swatch-canvas";
        thumb.src = design.thumbnailUrl;
        thumb.alt = design.label;
        previewWrap.appendChild(thumb);
      } else {
        previewWrap.innerHTML = `<div class="design-swatch-skeleton"></div>`;
      }

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

    // For designs without a dedicated thumbnail, fall back to compositing.
    entries.forEach(({ design, previewWrap }) => {
      if (design.thumbnailUrl) return; // already shown above
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
    options:          document.getElementById("designOptions"),
    previewContainer: document.getElementById("designPreviewContainer"),
    backBtn:          document.getElementById("btnBackFromDesign"),
    nextBtn:          document.getElementById("btnNextFromDesign")
  },

  async init() {
    // If no templates loaded (e.g. first run, no sync yet), show a message
    if (STRIP_DESIGNS.length === 0) {
      this.els.options.innerHTML = `
        <p style="padding:1rem;opacity:0.6;text-align:center;">
          No templates available.<br>Sync templates from the Admin panel.
        </p>`;
      this.els.nextBtn.disabled = true;
      return;
    }

    if (!sessionState.design) {
      sessionState.design = STRIP_DESIGNS[0].id;
    }

    await stripModule.renderSwatchPicker(this.els.options, sessionState.design, (designId) => {
      sessionState.design = designId;
      this.renderPreview();
    });

    this.renderPreview();
    this.els.nextBtn.disabled = false;

    kioskTimer.start(60, () => {
      if (this.els.nextBtn && !this.els.nextBtn.disabled) this.els.nextBtn.click();
    });
  },

  renderPreview() {
    stripModule.render(this.els.previewContainer, {
      frameType:     sessionState.frameType || "2x6",
      selectedShots: sessionState.selectedShots,
      designId:      sessionState.design
    });
  }
};

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
    goToPage("printing");
  });
}
