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
  },

  /* Render the looping video strip in the center column.
     Uses strip.js renderLive() for an animated DOM strip (real <video>
     elements in slots) — no mute/pause controls, plays silently. */
  _renderVideoLoop() {
    this.els.videoFrame.innerHTML = "";
    stripModule.renderLive(this.els.videoFrame, {
      frameType: sessionState.frameType,
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design
    });

    // Ensure all videos in the strip are muted and autoplay with no controls
    this.els.videoFrame.querySelectorAll("video").forEach((v) => {
      v.muted = true;
      v.autoplay = true;
      v.loop = true;
      v.controls = false;
      v.playsInline = true;
      v.play().catch(() => {}); // ignore NotAllowedError on some browsers
    });
  },

  /* Called once the gallery upload resolves (success or failure), or by
     the failsafe timer if it never does. Enables the Done button — the
     guest can now end their session. Guarded so it only ever runs once
     per session (the .then/.catch pair above and the failsafe timer can
     both fire; the second call must be a no-op). */
  _onQrReady() {
    if (this._qrReadyCalled) return;
    this._qrReadyCalled = true;

    this.els.qrUploading.style.display = "none";
    this.els.qrWrap.style.display = "";

    // Enable Done button now that the upload is confirmed (or failed gracefully)
    const doneBtn = document.getElementById("btnPrintingDone");
    if (doneBtn) doneBtn.disabled = false;

    kioskTimer.start(60, () => this.endSessionOnTimeout());
  },

  _setStatus(icon, text) {
    this.els.statusIcon.textContent = icon;
    this.els.statusText.textContent = text;
  },

  _renderQtyNote() {
    const qty = sessionState.quantity;
    if (sessionState.frameType === "2x6") {
      this.els.qtyNote.textContent = `${qty} sheet${qty !== 1 ? "s" : ""} · ${qty * 2} strips`;
    } else {
      this.els.qtyNote.textContent = `${qty} sheet${qty !== 1 ? "s" : ""}`;
    }
  },

  async _autoPrint() {
    const prefs = printAlignment.loadPrefs();

    // Wait for the gallery URL so the QR baked into the print output is
    // always correct, even if the upload is still in flight.
    const galleryUrl = sessionState.galleryUrlPromise
      ? await sessionState.galleryUrlPromise
      : sessionState.galleryUrl;

    let pngUrl = null;
    try {
      const pngBlob = await stripModule.exportPrintPNG({
        frameType: sessionState.frameType,
        selectedShots: sessionState.selectedShots,
        designId: sessionState.design,
        qrText: galleryUrl
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
