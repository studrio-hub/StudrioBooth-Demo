/*
 * PRINTING LOGIC — Page 6
 * Builds the on-screen final preview and generates the print-only PNG
 * (with the QR code baked in). The actual popup/print-window plumbing and
 * the scale/alignment math now live in js/print-alignment.js (loaded
 * before this file) so the kiosk print job and the Admin "Test Print"
 * button share identical logic.
 */

const printingModule = {
  els: {
    finalStripContainer: document.getElementById("finalStripContainer"),
    summaryText: document.getElementById("printSummaryText"),
    printBtn: document.getElementById("btnPrint"),
    doneBtn: document.getElementById("btnDone"),
    printArea: document.getElementById("printArea")
  },

  async init() {
    this.els.doneBtn.disabled = true;

    await this.renderPreview();
    this.renderSummary();

    // The 60s timer now starts only once the QR code has finished
    // uploading and is on screen — sessionState.galleryUrlPromise is set
    // synchronously the moment qrModule.generateAndRender() starts, and
    // resolves right as the QR is rendered into #qrCodeCanvas.
    const galleryPromise = sessionState.galleryUrlPromise;
    if (galleryPromise) {
      galleryPromise
        .then(() => {
          this.els.doneBtn.disabled = false;
          kioskTimer.start(60, () => this.endSessionOnTimeout());
        })
        .catch(() => {
          // Don't trap the guest if the upload failed — still start the timer.
          this.els.doneBtn.disabled = false;
          kioskTimer.start(60, () => this.endSessionOnTimeout());
        });
    } else {
      this.els.doneBtn.disabled = false;
      kioskTimer.start(60, () => this.endSessionOnTimeout());
    }
  },

  /* Guest never pressed Done — show a brief notice, then reset the
     kiosk for the next guest, same as tapping Done → Proceed. */
  endSessionOnTimeout() {
    const modal = document.getElementById("endingSessionModal");
    modal.hidden = false;
    modal.classList.add("show");
    setTimeout(() => {
      modal.classList.remove("show");
      modal.hidden = true;
      resetSessionAndRestart();
    }, 3000);
  },

  async renderPreview() {
    await stripModule.render(this.els.finalStripContainer, {
      frameType: sessionState.frameType,
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design
    });
  },

  renderSummary() {
    const qty = sessionState.quantity;
    const lines = [`Quantity: ${qty} sheet(s)`, "", "PRINT:"];

    if (sessionState.frameType === "2x6") {
      for (let i = 1; i <= qty; i++) lines.push(`Sheet ${i} → 2 identical strips`);
    } else {
      for (let i = 1; i <= qty; i++) lines.push(`Sheet ${i} → 1 photo`);
    }

    this.els.summaryText.textContent = lines.join("\n");
  },

  async print() {
    kioskTimer.hide();

    // Printer preferences (system dialog is admin-only and never surfaced
    // here; scale/offsetX/offsetY are the Printer Alignment settings) —
    // shared logic lives in js/print-alignment.js so the kiosk and the
    // Admin "Test Print" button always agree on the math.
    const prefs = printAlignment.loadPrefs();

    this.els.printBtn.disabled = true;
    this.els.printBtn.textContent = "Preparing...";

    // Wait for the gallery URL so the QR baked into the print output is
    // always correct, even if the upload is still in flight.
    const galleryUrl = sessionState.galleryUrlPromise
      ? await sessionState.galleryUrlPromise
      : sessionState.galleryUrl;

    const pngBlob = await stripModule.exportPrintPNG({
      frameType: sessionState.frameType,
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design,
      qrText: galleryUrl
    });
    const pngUrl = URL.createObjectURL(pngBlob);

    printAlignment.openPrintWindow(pngUrl, sessionState.quantity, prefs, () => {
      URL.revokeObjectURL(pngUrl);
      this.els.printBtn.disabled = false;
      this.els.printBtn.textContent = "🖨 PRINT NOW";
    });

    // Fire-and-forget: log this print job for the admin dashboard's
    // "copies printed" stat.
    cloudStorage.logPrintEvent(sessionState.id, sessionState.quantity);
  }
};

document.getElementById("btnPrint").addEventListener("click", () => printingModule.print());

document.getElementById("btnDone").addEventListener("click", () => {
  kioskTimer.hide();
  document.getElementById("confirmModal").classList.add("show");
});
document.getElementById("btnConfirmBack").addEventListener("click", () => {
  document.getElementById("confirmModal").classList.remove("show");
  kioskTimer.start(60, () => printingModule.endSessionOnTimeout());
});
document.getElementById("btnConfirmProceed").addEventListener("click", () => {
  document.getElementById("confirmModal").classList.remove("show");
  resetSessionAndRestart();
});