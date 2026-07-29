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
   * LIVE VIDEO STRIP — used only on the digital gallery page as a
   * DOM-based fallback (real <video> elements positioned over slots).
   * Falls back to the still photo if a slot has no video.
   */
  renderLive(containerEl, { frameType, selectedShots, designId }) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    const design = this.getDesign(designId);
    const overlayPath = design && design.overlays && design.overlays[frameType];
    const copies = frameType === "2x6" ? 2 : 1;
    const slotsPerCopy = config.photoSlots.length / copies;

    containerEl.innerHTML = "";
    containerEl.classList.add("live-strip-row");

    for (let c = 0; c < copies; c++) {
      const wrap = document.createElement("div");
      wrap.className = "live-strip-wrap";
      wrap.style.aspectRatio = `${config.canvasWidth / copies} / ${config.canvasHeight}`;

      for (let i = 0; i < slotsPerCopy; i++) {
        const slotIndex = c * slotsPerCopy + i;
        const slot = config.photoSlots[slotIndex];
        const shot = selectedShots[config.slotToPhotoIndex[slotIndex]];

        // Convert absolute px coords into % relative to this single strip's own width
        const stripWidth = config.canvasWidth / copies;
        const localX = slot.x - c * stripWidth;
        const leftPct = (localX / stripWidth) * 100;
        const topPct = (slot.y / config.canvasHeight) * 100;
        const widthPct = (slot.w / stripWidth) * 100;
        const heightPct = (slot.h / config.canvasHeight) * 100;

        const media = document.createElement(shot && shot.videoUrl ? "video" : "img");
        media.className = "live-strip-media";
        media.style.left = `${leftPct}%`;
        media.style.top = `${topPct}%`;
        media.style.width = `${widthPct}%`;
        media.style.height = `${heightPct}%`;
        media.style.borderRadius = `${config.slotCornerRadiusPct || 0}%`;

        if (shot && shot.videoUrl) {
          media.src = shot.videoUrl;
          media.muted = true;
          media.autoplay = true;
          media.loop = true;
          media.playsInline = true;
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

        if (copies > 1) {
          // The overlay PNG spans the full sheet (both strips side-by-side).
          // Each strip wrap is only 1/copies wide, so we must size the overlay
          // to the full sheet width and offset it so this copy shows only its
          // own slice — otherwise the full overlay gets squished into each half,
          // making it appear duplicated/distorted.
          overlayImg.style.width = `${copies * 100}%`;
          overlayImg.style.left = `${c * -100}%`;
          overlayImg.style.height = "100%";
          overlayImg.style.top = "0";
        }

        wrap.appendChild(overlayImg);
      }

      containerEl.appendChild(wrap);
    }
  },

  /*
   * COMBINED VIDEO STRIP EXPORT — records the full composited layout
   * (all 4 videos playing in their exact slots + frame overlay on top)
   * into ONE downloadable/shareable .webm file, matching the print
   * layout exactly but animated. Recording length matches durationMs.
   */
  async exportVideoStrip({ frameType, selectedShots, designId, durationMs = 3000, scale = 0.3 }) {
    const config = LAYOUT_CONFIGS[frameType];
    if (!config) throw new Error(`Unknown frame type: ${frameType}`);

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(config.canvasWidth * scale);
    canvas.height = Math.round(config.canvasHeight * scale);
    const ctx = canvas.getContext("2d");

    // Preload hidden <video> elements for every slot that has a video,
    // and <img> fallbacks for slots that don't.
    const mediaEls = await Promise.all(
      config.photoSlots.map((slot, i) => {
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