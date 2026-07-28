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

    // Printer Alignment settings (scale/offsetX/offsetY) — shared logic
    // lives in js/print-alignment.js so the kiosk and the Admin "Test
    // Print" button always agree on the math and the agent call.
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

    this.els.printBtn.textContent = "Sending to printer...";

    // Goes straight to the local print-agent -> CUPS -> printer. No browser
    // print dialog appears at any point — see js/print-alignment.js.
    try {
      await printAlignment.sendPrintJob(pngUrl, sessionState.quantity, prefs);
      this.els.printBtn.textContent = "🖨 PRINT NOW";
      // Fire-and-forget: log this print job for the admin dashboard's
      // "copies printed" stat. Only logged on a confirmed successful send.
      cloudStorage.logPrintEvent(sessionState.id, sessionState.quantity);
    } catch (e) {
      console.error("[printing] Print job failed:", e);
      this.els.printBtn.textContent = "⚠ Print failed — ask staff for help";
      setTimeout(() => {
        this.els.printBtn.textContent = "🖨 PRINT NOW";
      }, 4000);
    } finally {
      URL.revokeObjectURL(pngUrl);
      this.els.printBtn.disabled = false;
    }
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