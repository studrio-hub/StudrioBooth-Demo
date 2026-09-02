/*
 * FLIPBOOK-GENERATOR.JS
 *
 * Produces the 2 physical print sheets (a4Page1: cover + pages 1-9,
 * a4Page2: pages 10-19), each a 2×5 grid of 10 photo slots per
 * FLIPBOOK_LAYOUT_CONFIG, cut apart into 20 individual pages after
 * printing. Follows the same draw order as every multi-slot format in
 * layout-config.js: photo/frame images drawn first, per-sheet overlay
 * template art drawn on top last (borders, cut-guides, branding).
 *
 * NOTE ON TEMPLATE SOURCING: where the Cover/A4 Page 1/A4 Page 2 template
 * IMAGE assets themselves come from (Supabase template row, admin-uploaded
 * PNGs, etc.) is a backend/admin-panel concern outside this batch's scope
 * ("Kiosk Flow & Video Processing"). getTemplateUrls() below is the single
 * seam to wire that up later — it currently reads conventional field names
 * off the selected STRIP_DESIGNS entry (flipbookCoverUrl / flipbookA4Page1Url
 * / flipbookA4Page2Url), matching the overlayUrl2x6-style convention strip.js
 * already uses. Update only this function once the real admin/Supabase
 * wiring exists — nothing else in this file needs to change.
 */

const flipbookGenerator = {
  _imageCache: new Map(),

  async _loadImage(url) {
    if (!url) return null;
    if (this._imageCache.has(url)) return this._imageCache.get(url);
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = "anonymous";
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Failed to load flipbook template image: ${url}`));
      el.src = url;
    });
    this._imageCache.set(url, img);
    return img;
  },

  /* Seam for wiring real template assets — see file header.
     previewUrl is the Flipbook Overlay used only for the on-screen preview
     widgets (Video Selection page + Print & QR's video loop column) — see
     flipbookPreviewFrame.render() — never drawn onto the print sheets. */
  getTemplateUrls() {
    const tmpl = (typeof stripModule !== "undefined" && sessionState.design)
      ? stripModule.getDesign(sessionState.design)
      : null;
    return {
      coverUrl:    tmpl?.flipbookCoverUrl    || null,
      a4Page1Url:  tmpl?.flipbookA4Page1Url  || null,
      a4Page2Url:  tmpl?.flipbookA4Page2Url  || null,
      previewUrl:  tmpl?.flipbookPreviewUrl  || null
    };
  },

  /* Draws `source` into `ctx` cropped-to-fill the given slot (object-fit: cover),
     matching the crop behavior used elsewhere in the print pipeline
     (camera-controller.js's _cropToZoom, strip.js's drawCropFill).
     `source` can be an <img> (naturalWidth/naturalHeight) or a <video>
     (videoWidth/videoHeight) — drawImage() accepts either directly. */
  _drawCropFill(ctx, source, slot) {
    const { x, y, w, h } = slot;
    const srcW = source.naturalWidth  ?? source.videoWidth;
    const srcH = source.naturalHeight ?? source.videoHeight;
    const srcAR = srcW / srcH;
    const dstAR = w / h;

    let sx, sy, sw, sh;
    if (srcAR > dstAR) {
      sh = srcH;
      sw = sh * dstAR;
      sy = 0;
      sx = (srcW - sw) / 2;
    } else {
      sw = srcW;
      sh = sw / dstAR;
      sx = 0;
      sy = (srcH - sh) / 2;
    }
    ctx.drawImage(source, sx, sy, sw, sh, x, y, w, h);
  },

  /*
   * _compositeSheet(sheetKey, images, overlayImg)
   *   sheetKey — "a4Page1" | "a4Page2"
   *   images   — array parallel to that sheet's `slots`, each entry an
   *              <img>-loadable frame image (or null to leave the slot
   *              blank) for that slot index
   *   overlayImg — the sheet's full-canvas template art, drawn last
   */
  async _compositeSheet(sheetKey, images, overlayImg) {
    const { canvasWidth, canvasHeight } = FLIPBOOK_LAYOUT_CONFIG;
    const sheet = flipbookLayout.getSheet(sheetKey);
    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    sheet.slots.forEach((slot, i) => {
      const img = images[i];
      if (img) this._drawCropFill(ctx, img, slot);
    });

    if (overlayImg) {
      ctx.drawImage(overlayImg, 0, 0, canvasWidth, canvasHeight);
    }

    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  },

  /*
   * exportPrintSheets() → Promise<{ a4Page1: Blob, a4Page2: Blob }>
   *   Exactly 2 print jobs — each sheet is cut into 10 physical pages
   *   after printing.
   */
  async exportPrintSheets() {
    const frames = sessionState.flipbookFrames || [];
    if (frames.length !== FLIPBOOK_TOTAL_FRAMES) {
      console.warn(`[flipbookGenerator] Expected ${FLIPBOOK_TOTAL_FRAMES} frames, got ${frames.length}`);
    }

    const urls = this.getTemplateUrls();
    const [a4Page1OverlayImg, a4Page2OverlayImg] = await Promise.all([
      this._loadImage(urls.a4Page1Url),
      this._loadImage(urls.a4Page2Url)
    ]);

    // Decode every extracted frame blob into an <img> once, reused across
    // both sheets/slots as needed.
    const frameImgs = await Promise.all(frames.map((blob) => this._loadFrameImage(blob)));

    // Cover slot now uses the guest's own selected cover photo (Cover Page
    // Photo Selection, after flipbook-shooting.js's 3-photo cover round) —
    // cropped-to-fill exactly like any other page slot. The static
    // "Cover Page Template" asset (urls.coverUrl) is no longer drawn INTO
    // the slot now that a real guest photo exists; getTemplateUrls() is
    // untouched in case that asset is still used elsewhere (e.g. template
    // thumbnails on the Choose a Template page).
    const coverPhoto = sessionState.selectedFlipbookCoverPhoto;
    const coverImg = coverPhoto?.image ? await this._loadFrameImage(coverPhoto.image) : null;

    const sheet1 = flipbookLayout.getSheet("a4Page1");
    const sheet1Images = sheet1.slots.map((slot) =>
      slot.label === "cover" ? coverImg : frameImgs[slot.frameIndex] || null
    );

    const sheet2 = flipbookLayout.getSheet("a4Page2");
    const sheet2Images = sheet2.slots.map((slot) => frameImgs[slot.frameIndex] || null);

    const [a4Page1, a4Page2] = await Promise.all([
      this._compositeSheet("a4Page1", sheet1Images, a4Page1OverlayImg),
      this._compositeSheet("a4Page2", sheet2Images, a4Page2OverlayImg)
    ]);

    return { a4Page1, a4Page2 };
  },

  async _loadFrameImage(blob) {
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });
    } finally {
      // The <img> keeps decoded pixel data once loaded; safe to revoke.
      URL.revokeObjectURL(url);
    }
  },

  /* Minor Fix — gallery uploads: bake the active design's Cover Page
     template art onto the guest's selected cover photo, so the "Download
     Photo" button on the gallery page (g/index.html, uses
     sessionData.finalStripPng — see flipbook-qr.js) matches what the
     guest actually saw during Cover Page Photo Selection / Print & QR,
     instead of the bare, un-framed photo.
     Same slot rect as the on-screen preview
     (.flipbook-cover-page-preview-photo in flipbook.css): left 21.3%,
     top 6.5%, width 74.5%, height 87% of the full canvas.
     Falls back to the guest's original, un-composited photo when the
     active design has no Cover Page template uploaded — there's nothing
     to bake in, so compositing would just add a pointless crop. */
  async compositeCoverPhoto() {
    const coverPhoto = sessionState.selectedFlipbookCoverPhoto;
    if (!coverPhoto?.image) return null;

    const urls = this.getTemplateUrls();
    if (!urls.coverUrl) return coverPhoto.image;

    const overlayImg = await this._loadImage(urls.coverUrl);
    const photoImg = await this._loadFrameImage(coverPhoto.image);

    const canvasWidth = overlayImg.naturalWidth;
    const canvasHeight = overlayImg.naturalHeight;

    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const slot = {
      x: canvasWidth * 0.213,
      y: canvasHeight * 0.065,
      w: canvasWidth * 0.745,
      h: canvasHeight * 0.87
    };
    this._drawCropFill(ctx, photoImg, slot);
    ctx.drawImage(overlayImg, 0, 0, canvasWidth, canvasHeight);

    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  },

  /* Minor Fix — gallery uploads: same idea as compositeCoverPhoto() above,
     but for the guest's selected 6s video (sessionData.finalStripVideo —
     see flipbook-qr.js). Since there's no still image to draw once, this
     redraws the video frame-by-frame onto a canvas (video cropped into the
     same slot rect as the photo above, template art on top each frame)
     and records that canvas for the video's duration via
     canvas.captureStream() + MediaRecorder — the standard way to bake a
     static overlay into a video client-side without a server-side
     transcode step.
     Falls back to the guest's original, un-composited clip when the
     active design has no Cover Page template uploaded, same fallback
     philosophy as compositeCoverPhoto(). */
  async compositeCoverVideo() {
    const clip = sessionState.selectedFlipbookVideo;
    if (!clip?.video) return null;

    const urls = this.getTemplateUrls();
    if (!urls.coverUrl) return clip.video;

    const overlayImg = await this._loadImage(urls.coverUrl);
    const canvasWidth = overlayImg.naturalWidth;
    const canvasHeight = overlayImg.naturalHeight;
    const slot = {
      x: canvasWidth * 0.213,
      y: canvasHeight * 0.065,
      w: canvasWidth * 0.745,
      h: canvasHeight * 0.87
    };

    const videoUrl = URL.createObjectURL(clip.video);
    const videoEl = document.createElement("video");
    videoEl.src = videoUrl;
    videoEl.muted = true;
    videoEl.playsInline = true;

    try {
      await new Promise((resolve, reject) => {
        videoEl.onloadedmetadata = resolve;
        videoEl.onerror = () => reject(new Error("[flipbookGenerator] Failed to load selected video for compositing"));
      });

      const canvas = document.createElement("canvas");
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const ctx = canvas.getContext("2d");

      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const recordingDone = new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
      });

      let raf = null;
      const drawFrame = () => {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        this._drawCropFill(ctx, videoEl, slot);
        ctx.drawImage(overlayImg, 0, 0, canvasWidth, canvasHeight);
        if (!videoEl.paused && !videoEl.ended) raf = requestAnimationFrame(drawFrame);
      };

      recorder.start();
      videoEl.currentTime = 0;
      await videoEl.play();
      drawFrame();

      await new Promise((resolve) => { videoEl.onended = resolve; });
      if (raf) cancelAnimationFrame(raf);
      recorder.stop();

      return await recordingDone;
    } finally {
      URL.revokeObjectURL(videoUrl);
    }
  }
};
