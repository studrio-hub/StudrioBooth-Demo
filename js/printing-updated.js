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
 * ADD-ON PRINT LOGIC (driven by sessionState.addonChoice set by addon-page.js)
 * ─────────────────────────────────────────────────────────────────────────────
 * addonChoice === "none" (or falsy)
 *   → Standard: prints sessionState.quantity copies of the main 2-up sheet.
 *     Behaviour is identical to the original code.
 *
 * addonChoice === "replace"  [2×6 only]
 *   → Replaces the second strip with 2 Mini-Strip Keychain frames.
 *   → Sends 1 copy of the keychain export sheet (left strip + 2 mini frames)
 *     via keychainAddon.exportPrintPNG().
 *   → The normal 2-up sheet is NOT printed (the guest chose the keychain
 *     format in its place, at no extra cost).
 *
 * addonChoice === "add"  [2×6 only]
 *   → Full standard print PLUS the keychain sheet as a second job.
 *   → Sends sessionState.quantity copies of the standard 2-up sheet, then
 *     1 additional copy of the keychain sheet.
 *   → Corresponds to the "+₱25 Add a Keychain Print" option.
 *
 * For backward compatibility, sessionState.keychainAddonSelected continues
 * to be set alongside addonChoice:
 *   false         → no add-on (addonChoice: "none")
 *   "replace"     → replace mode (addonChoice: "replace")
 *   "add"         → additive mode (addonChoice: "add")
 * Any code that only checks the boolean truthiness of keychainAddonSelected
 * will activate for "replace" and "add" and skip only "false" / undefined.
 */

const printingModule = {
  els: {
    videoFrame:    document.getElementById("printingVideoFrame"),
    statusBadge:   document.getElementById("printStatusBadge"),
    statusIcon:    document.getElementById("printStatusIcon"),
    statusText:    document.getElementById("printStatusText"),
    qtyNote:       document.getElementById("printQtyNote"),
    qrWrap:        document.getElementById("qrWrap"),
    qrUploading:   document.getElementById("qrUploading"),
    printArea:     document.getElementById("printArea")
  },

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
     uses for its video. */
  _renderVideoLoop() {
    this.els.videoFrame.innerHTML = "";
    const myGen = (this._videoRenderGen = (this._videoRenderGen || 0) + 1);

    stripModule.render(this.els.videoFrame, {
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
      videoEl.autoplay = true;
      videoEl.loop = true;
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.className = "live-strip-media";
      videoEl.addEventListener("canplay", () => { videoEl.play().catch(() => {}); }, { once: true });
      this.els.videoFrame.innerHTML = "";
      this.els.videoFrame.appendChild(videoEl);
    });
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
    const qty    = sessionState.quantity;
    const choice = sessionState.addonChoice || "none";

    if (sessionState.frameType === "2x6") {
      if (choice === "replace") {
        // Replace: 1 strip + 2 keychain frames (no standard 2-up sheet)
        this.els.qtyNote.textContent = `1 strip · 2 keychains`;
      } else if (choice === "add") {
        // Add: standard sheets + 1 extra keychain sheet
        this.els.qtyNote.textContent =
          `${qty} sheet${qty !== 1 ? "s" : ""} · ${qty * 2} strips + keychain`;
      } else {
        // None: standard 2-up sheet(s)
        this.els.qtyNote.textContent =
          `${qty} sheet${qty !== 1 ? "s" : ""} · ${qty * 2} strips`;
      }
    } else {
      this.els.qtyNote.textContent = `${qty} sheet${qty !== 1 ? "s" : ""}`;
    }
  },

  async _autoPrint() {
    const prefs  = printAlignment.loadPrefs();
    const choice = sessionState.addonChoice || "none";

    // Wait for the gallery URL so the QR baked into the print output is
    // always correct, even if the upload is still in flight.
    const galleryUrl = sessionState.galleryUrlPromise
      ? await sessionState.galleryUrlPromise
      : sessionState.galleryUrl;

    // ── REPLACE mode: skip standard sheet, send keychain sheet only ───────────
    if (choice === "replace" && typeof keychainAddon !== "undefined") {
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
        console.error("[printing] Keychain (replace) print failed:", e);
        this._setStatus("⚠", "Print failed — ask staff");
      } finally {
        if (keychainUrl) URL.revokeObjectURL(keychainUrl);
      }
      return; // Done — no standard sheet in "replace" mode.
    }

    // ── STANDARD sheet (used for "none" and first job of "add") ──────────────
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

    // ── ADD mode: second print job — keychain sheet ───────────────────────────
    // Fires only for "add" choice. Runs after the main job (success or failure)
    // so a print error on the main job doesn't silently block the keychain print.
    if (choice === "add" && typeof keychainAddon !== "undefined") {
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
      } catch (e) {
        console.error("[printing] Keychain (add) print failed:", e);
        this._setStatus("⚠", "Keychain print failed — ask staff");
      } finally {
        if (keychainUrl) URL.revokeObjectURL(keychainUrl);
      }
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
