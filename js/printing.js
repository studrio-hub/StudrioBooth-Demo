/*
 * PRINTING LOGIC — Page 6
 *
 * New flow (auto-print):
 *   1. printingModule.init() is called the moment the guest lands on Page 6.
 *   2. Printing starts immediately in the background (fire-and-forget).
 *   3. The looping video strip plays in the center column.
 *   4. The right column shows "Uploading…" until the QR is ready, then
 *      displays the QR code and starts the 60-second kiosk timer.
 *   5. When the 60s timer expires, the kiosk resets for the next guest.
 *
 * The actual popup/print-window plumbing and scale/alignment math live in
 * js/print-alignment.js (loaded before this file) so the kiosk print job
 * and the Admin "Test Print" button share identical logic.
 *
 * RELIABILITY: qr.js guarantees sessionState.galleryUrlPromise resolves
 * (never hangs) via its own try/catch/finally + upload timeout. As a
 * second, independent line of defense — a kiosk should never trust a
 * single point of failure to unstick a guest — _onQrReady() is also
 * force-called by a hard failsafe timer below if it hasn't already fired.
 *
 * FLIPBOOK PRINT LOGIC
 * ─────────────────────────────────────────────────────────────────────
 * Flipbook's two A4 sheets no longer go through a separate print-server
 * module. They print directly from the kiosk through printAlignment's
 * sendRawPrintJob() — the same configured printer/IPC path as every other
 * product uses (printAlignment.getConfiguredPrinter() /
 * studrio_selected_printer), just without the scale/offset compositing
 * step, since the sheets are already pixel-exact A4 canvases. See
 * print-alignment.js for details.
 *
 * KEYCHAIN TEMPLATE PRINT LOGIC (driven by sessionState._isKeychain)
 * ─────────────────────────────────────────────────────────────────────
 * When the guest selects a Keychain template from the Accessories category
 * on Page 2 (Template Selection), templateModule sets sessionState._isKeychain
 * = true and overrides frameType to "2x6" for the shooting session (so the
 * same 8-shot flow is used). On arrival at Page 6:
 *
 *   sessionState._isKeychain === true
 *     → Sends 1 copy of the keychain export sheet via keychainAddon.exportPrintPNG().
 *       Layout: left half = 1× 2×6 strip, right half = 2× Mini-Strip Keychain frames.
 *       The selected keychain template's overlay (keychainOverlayUrl from the design)
 *       is applied to both keychain frames. No standard 2-up sheet is printed.
 *
 *   sessionState._isKeychain === false (or undefined)
 *     → Standard print: quantity copies of the main strip sheet (2-up for 2×6,
 *       single for 4×6). Behaviour is identical to the original code.
 */

const printingModule = {
  els: {
    videoFrame:      document.getElementById("printingVideoFrame"),
    statusBadge:     document.getElementById("printStatusBadge"),
    statusIcon:      document.getElementById("printStatusIcon"),
    statusText:      document.getElementById("printStatusText"),
    qtyNote:         document.getElementById("printQtyNote"),
    qrWrap:          document.getElementById("qrWrap"),
    qrUploading:     document.getElementById("qrUploading"),
    printArea:       document.getElementById("printArea"),
    // Flipbook-only: "Show the Flipbook Preview" alongside the selected
    // video (Batch 2 §2). Hidden/unused for every other product.
    flipPreviewCol:   document.getElementById("printingFlipbookPreviewCol"),
    flipPreviewStage: document.getElementById("flipbookPrintPreviewStage"),
    // Minor Fix: admin-uploaded "Cover Page" template preview — now
    // overlays the flipbook video preview inside this same stage (instead
    // of compositing the selected cover photo in a separate box).
    coverPageImg: document.getElementById("flipbookPrintCoverPageImg")
  },

  _flipAnimator: null,

  async init() {
    // Reset per-session so _onQrReady()'s guard works correctly on repeat visits.
    this._qrReadyCalled = false;

    // Keep Done button disabled until upload is complete
    const doneBtn = document.getElementById("btnPrintingDone");
    if (doneBtn) doneBtn.disabled = true;

    // Show initial print status
    this._setStatus("🖨", "Printing…");
    this._renderQtyNote();

    // Start the looping video strip immediately in the center column
    this._renderVideoLoop();
    this._renderFlipPreview();
    this._renderCoverPage();

    // Hide the QR code, show uploading state until the promise resolves.
    // Uses inline style.display rather than the `hidden` attribute — if
    // style.css has a rule targeting these elements with higher specificity
    // than the browser's default [hidden] { display: none }, the hidden
    // attribute can get silently overridden and the element stays visible
    // even though this code ran correctly. Inline styles always win.
    this.els.qrWrap.style.display = "none";
    this.els.qrUploading.style.display = "";

    // Fire print immediately in the background — guests see the video
    // loop while this happens; they don't need to tap anything.
    this._autoPrint();

    // Wait for the gallery URL / QR upload to finish, then show the QR
    // and start the 60-second countdown.
    const galleryPromise = sessionState.galleryUrlPromise;
    if (galleryPromise) {
      galleryPromise
        .then(() => this._onQrReady())
        .catch(() => this._onQrReady()); // don't trap the guest if upload fails
    } else {
      this._onQrReady();
    }

    // Absolute failsafe. qr.js's generateAndRender() guarantees the promise
    // above settles within ~20s under its own contract — but a kiosk should
    // never depend on exactly one thing going right. If _onQrReady() somehow
    // still hasn't fired by 25s (e.g. galleryUrlPromise itself was replaced
    // or never wired up correctly), force it open anyway rather than leave
    // the guest staring at "Uploading…" until the page times out entirely.
    setTimeout(() => {
      if (!this._qrReadyCalled) {
        console.warn("[printing] Gallery URL promise did not settle in time — forcing QR panel open.");
        this._onQrReady();
      }
    }, 25000);

    // Done-button failsafe: uploadProgress.complete() / .error() in qr.js
    // are the primary gatekeepers that enable Done only after the upload
    // result is known. This safety net fires if neither callback has run
    // within 30s (e.g. cloud storage is disabled or qr.js threw very early
    // before reaching those calls), so the guest is never permanently stuck.
    setTimeout(() => {
      const doneBtn = document.getElementById("btnPrintingDone");
      if (doneBtn && doneBtn.disabled) {
        console.warn("[printing] Done button still disabled after 30s — enabling as last-resort fallback.");
        doneBtn.disabled = false;
      }
    }, 30000);
  },

  /* Render the Print & QR media preview in the center column.
     Minor Fix: previously an animated DOM strip via strip.js renderLive()
     (4 clips playing simultaneously, framed into the print layout's photo
     slots). Now shows the static photo strip immediately — it's a fast
     local composite, matching what's physically being printed on this
     page, unlike a video which has to wait on qr.js's MediaRecorder
     export — then swaps to the stitched video (Video 1 → 2 → 3 → 4, see
     stripModule.exportStitchedVideo / qr.js) once it's ready, looping
     continuously from there. Same artifact/behavior the digital gallery
     uses for its video.

     Minor Fix 2: the photo→video swap used to wipe #printingVideoFrame
     (innerHTML = "") and append the video fresh. Two problems fell out of
     that: (1) animations.js keeps a MutationObserver on #printingVideoFrame
     watching for added children and replays the "printer feed" slide-in
     (element starts at y:-110%) on every one of them — so the video swap
     re-triggered that slide-in from off-screen, and since the old canvas
     was already gone by then, the frame was genuinely blank until the
     video finished sliding back down; (2) the video's first frame isn't
     paintable the instant it's appended, widening that blank gap further.
     That's the "strip disappears suddenly" bug.

     Fix: #printingVideoFrame now only ever gets ONE direct child —
     .printing-media-stage — appended once, so the feed-in animation fires
     exactly once, the way it's supposed to. The photo canvas and (later)
     the video both live *inside* that stage as nested children, which the
     frame-level MutationObserver never sees, so swapping between them
     can't retrigger the slide-in. The video is layered on top via CSS
     (see animations.css) and only cross-fades to visible once it reports
     canplay and is actually playing — the photo stays put underneath the
     whole time, so there's never a frame with nothing showing. */
  _renderVideoLoop() {
    this.els.videoFrame.innerHTML = "";
    const myGen = (this._videoRenderGen = (this._videoRenderGen || 0) + 1);

    if (sessionState._isFlipbook) {
      // Flipbook has no photo strip — show the selected clip looping inside
      // the shared page-shaped preview frame (flipbookLayout.previewFrame),
      // same widget used on the Video Selection page.
      if (typeof flipbookPreviewFrame !== "undefined") {
        flipbookPreviewFrame.render(this.els.videoFrame, sessionState.selectedFlipbookVideo);
      }
      return;
    }

    // Single, permanent direct child of #printingVideoFrame — see comment
    // above. Everything else nests inside this.
    const stage = document.createElement("div");
    stage.className = "printing-media-stage";
    this.els.videoFrame.appendChild(stage);

    stripModule.render(stage, {
      frameType: sessionState.frameType,
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design,
      singleStrip: true
    });

    const videoPromise = sessionState.finalStripVideoPromise;
    if (!videoPromise) return;
    videoPromise.then((blob) => {
      if (!blob || this._videoRenderGen !== myGen) return; // stale/superseded — guest moved on
      const videoEl = document.createElement("video");
      videoEl.src = URL.createObjectURL(blob);
      videoEl.loop = true;
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.setAttribute("playsinline", "");
      videoEl.className = "live-strip-media printing-media-video";
      videoEl.addEventListener("canplay", () => {
        if (this._videoRenderGen !== myGen) return; // stale/superseded — guest moved on
        videoEl.play().catch(() => {});
        // Cross-fade in over the photo canvas (CSS opacity transition —
        // see .printing-media-video / .is-visible in animations.css), then
        // remove the now-hidden-behind-it canvas once the fade finishes.
        videoEl.classList.add("is-visible");
        const photoEl = stage.querySelector(".layout-canvas");
        if (photoEl) {
          photoEl.classList.add("is-fading");
          setTimeout(() => { if (photoEl.isConnected) photoEl.remove(); }, 300);
        }
      }, { once: true });
      videoEl.onerror = () => {
        // Stitched video failed to decode/load — the photo strip already
        // showing just stays, same fallback behavior as the gallery.
        console.warn("[printing] Stitched video failed to load — keeping photo strip.");
        videoEl.remove();
      };
      stage.appendChild(videoEl);
    });
  },

  /* Flipbook-only: runs its own copy of the flip-page animation (the same
     engine as the Flipbook Preview page, via flipbook-flip-animator.js)
     in a dedicated column here, independent of that page's instance. */
  _renderFlipPreview() {
    if (!this.els.flipPreviewCol) return;

    if (!sessionState._isFlipbook || typeof createFlipbookFlipAnimator === "undefined") {
      this.els.flipPreviewCol.hidden = true;
      if (this._flipAnimator) { this._flipAnimator.stop(); this._flipAnimator = null; }
      return;
    }

    this.els.flipPreviewCol.hidden = false;
    if (this._flipAnimator) this._flipAnimator.teardown();
    this._flipAnimator = createFlipbookFlipAnimator({
      stage:       document.getElementById("flipbookPrintPreviewStage"),
      templateImg: document.getElementById("flipbookPrintPreviewTemplateImg"),
      photoImg:    document.getElementById("flipbookPrintPreviewPhotoImg")
    });
    this._flipAnimator.init();
  },

  /* Minor Fix: shows the active template's admin-uploaded "Cover Page"
     asset (flipbookCoverUrl) layered on top of the flipbook video
     preview, inside the same stage — the Cover Page photo taken during
     Cover Page Photo Selection is no longer composited here at all. The
     video stage is only slot-positioned (to sit inside the template's
     photo cutout) when a template is actually present — otherwise it
     keeps filling the full stage, same as before. No-op for non-flipbook
     sessions, matching the flipPreviewCol hide logic in
     _renderFlipPreview() above. */
  _renderCoverPage() {
    const img = this.els.coverPageImg;
    const videoStage = this.els.flipPreviewStage;
    if (!img) return;

    const tmpl = (!sessionState._isFlipbook || typeof STRIP_DESIGNS === "undefined")
      ? null
      : STRIP_DESIGNS.find((t) => String(t.id) === String(sessionState.design));
    const url = tmpl ? tmpl.flipbookCoverUrl : null;

    if (url) {
      img.src = url;
      img.hidden = false;
    } else {
      img.src = "";
      img.hidden = true;
    }

    if (videoStage) {
      videoStage.classList.toggle("flipbook-cover-page-preview-photo", !!url);
    }
  },

  /* Called once the gallery upload resolves (success or failure), or by
     the failsafe timer if it never does. Shows the QR panel and starts
     the 60-second countdown. Guarded so it only ever runs once per session
     (the .then/.catch pair above and the failsafe timer can both fire;
     the second call must be a no-op).
     
     NOTE: the Done button is NOT enabled here. uploadProgress.complete()
     owns that responsibility so Done is only enabled after the upload is
     confirmed successful. uploadProgress.error() enables Done as a fallback
     so the guest is never stuck if the upload fails. The failsafe timer
     below additionally ensures the guest is never stuck if the progress
     callbacks themselves don't fire. */
  _onQrReady() {
    if (this._qrReadyCalled) return;
    this._qrReadyCalled = true;

    this.els.qrUploading.style.display = "none";
    this.els.qrWrap.style.display = "";

    kioskTimer.start(60, () => this.endSessionOnTimeout());
  },

  _setStatus(icon, text) {
    this.els.statusIcon.textContent = icon;
    this.els.statusText.textContent = text;
  },

  _renderQtyNote() {
    const qty = sessionState.quantity;

    if (sessionState._isFlipbook) {
      this.els.qtyNote.textContent = `2 sheets · 20 pages (cut apart)`;
    } else if (sessionState._isKeychain) {
      // Keychain template: 1 strip + 2 keychain frames on a single sheet
      this.els.qtyNote.textContent = `1 strip · 2 keychains`;
    } else if (sessionState.frameType === "2x6") {
      this.els.qtyNote.textContent =
        `${qty} sheet${qty !== 1 ? "s" : ""} · ${qty * 2} strips`;
    } else {
      this.els.qtyNote.textContent = `${qty} sheet${qty !== 1 ? "s" : ""}`;
    }
  },

  async _autoPrint() {
    // ── FLIPBOOK: generate + save the 2 sheets, but do NOT print them ──────────
    // Auto-print is intentionally disabled for flipbook per owner instruction:
    // the kiosk no longer sends these sheets to the printer on its own. It
    // still generates them and uploads them via saveFlipbookPrintSheets()
    // (the guest's extracted frames aren't kept around after this point, so
    // this is the only chance to capture them) — staff then print from
    // Admin > Sessions' Reprint button, which is now the ONLY place a
    // flipbook session's sheets actually reach the printer.
    //
    // flipbookGenerator.exportPrintSheets() composites the cover art + pages
    // 1-9 onto the A4 Page 1 sheet, and pages 10-19 onto the A4 Page 2 sheet
    // (see flipbook-layout-config.js / flipbook-generator.js).
    if (sessionState._isFlipbook && typeof flipbookGenerator !== "undefined") {
      try {
        this._setStatus("🖨", "Preparing flipbook sheets…");
        const { a4Page1, a4Page2 } = await flipbookGenerator.exportPrintSheets();

        const saved = await cloudStorage.saveFlipbookPrintSheets(sessionState.id, a4Page1, a4Page2);

        if (saved) {
          this._setStatus("✅", "Ready — printed from Admin");
        } else {
          // saveFlipbookPrintSheets() already logged the underlying error —
          // this leaves the guest with an honest status instead of a false
          // "done", and leaves staff's Admin Reprint button correctly
          // disabled (no print_ready_url was written) so they know to check.
          this._setStatus("⚠", "Save failed — ask staff");
        }
      } catch (e) {
        console.error("[printing] Flipbook sheet generation failed:", e);
        this._setStatus("⚠", "Save failed — ask staff");
      }
      return; // Done — flipbook sessions never print here anymore.
    }

    const prefs = printAlignment.loadPrefs();

    // Wait for the gallery URL so the QR baked into the print output is
    // always correct, even if the upload is still in flight.
    const galleryUrl = sessionState.galleryUrlPromise
      ? await sessionState.galleryUrlPromise
      : sessionState.galleryUrl;

    // ── KEYCHAIN TEMPLATE: send keychain sheet only ───────────────────────────
    // Fires when the guest selected a Keychain template from the Accessories
    // category on Page 2. The keychain sheet uses the KEYCHAIN_LAYOUT:
    //   Left half  — 1× 2×6 strip (photos + design overlay + QR)
    //   Right half — 2× Mini-Strip Keychain frames (photos + keychain overlay)
    // No standard 2-up strip sheet is printed.
    if (sessionState._isKeychain && typeof keychainAddon !== "undefined") {
      let keychainUrl = null;
      try {
        this._setStatus("🖨", "Printing keychain…");
        const keychainBlob = await keychainAddon.exportPrintPNG({
          selectedShots: sessionState.selectedShots,
          designId:      sessionState.design,
          qrText:        galleryUrl
        });
        keychainUrl = URL.createObjectURL(keychainBlob);
        await printAlignment.sendPrintJob(keychainUrl, 1, prefs);
        this._setStatus("✅", "Keychain printed!");
        cloudStorage.logPrintEvent(sessionState.id, 1);
      } catch (e) {
        console.error("[printing] Keychain print failed:", e);
        this._setStatus("⚠", "Print failed — ask staff");
      } finally {
        if (keychainUrl) URL.revokeObjectURL(keychainUrl);
      }
      return; // Done — keychain template never prints the standard sheet.
    }

    // ── STANDARD sheet ────────────────────────────────────────────────────────
    let pngUrl = null;
    try {
      const pngBlob = await stripModule.exportPrintPNG({
        frameType:     sessionState.frameType,
        selectedShots: sessionState.selectedShots,
        designId:      sessionState.design,
        qrText:        galleryUrl
      });
      pngUrl = URL.createObjectURL(pngBlob);

      this._setStatus("🖨", "Sending to printer…");
      await printAlignment.sendPrintJob(pngUrl, sessionState.quantity, prefs);
      this._setStatus("✅", "Printed!");

      // Fire-and-forget: log this print job for the admin dashboard's
      // "copies printed" stat.
      cloudStorage.logPrintEvent(sessionState.id, sessionState.quantity);
    } catch (e) {
      console.error("[printing] Auto-print failed:", e);
      this._setStatus("⚠", "Print failed — ask staff");
    } finally {
      if (pngUrl) URL.revokeObjectURL(pngUrl);
    }
  },

  /* Guest's 60s ran out — show a brief notice, then reset for the next guest. */
  endSessionOnTimeout() {
    const modal = document.getElementById("endingSessionModal");
    modal.hidden = false;
    modal.classList.add("show");
    setTimeout(() => {
      modal.classList.remove("show");
      modal.hidden = true;
      resetSessionAndRestart();
    }, 3000);
  }
};
