/*
 * PRINTING LOGIC — Page 6
 * Builds the on-screen final preview, generates the print-only PNG
 * (with the QR code baked in), and opens an isolated popup window to
 * print it at exact 4x6in size — fully isolated from the kiosk's own
 * style.css so nothing here can be affected by shared page styles.
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
    kioskTimer.start(60, () => this.endSessionOnTimeout());

    this.els.doneBtn.disabled = true;

    await this.renderPreview();
    this.renderSummary();

    // Done stays disabled until the digital copy has finished uploading
    // (or definitively failed) — sessionState.galleryUrlPromise is set
    // synchronously the moment qrModule.generateAndRender() starts.
    const galleryPromise = sessionState.galleryUrlPromise;
    if (galleryPromise) {
      galleryPromise
        .then(() => { this.els.doneBtn.disabled = false; })
        .catch(() => { this.els.doneBtn.disabled = false; }); // don't trap the guest if the upload failed
    } else {
      this.els.doneBtn.disabled = false;
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

    // Open the window FIRST, synchronously, before any await — popup
    // blockers only allow window.open() when it's a direct result of
    // the click. Filling it in can happen after.
    const printWindow = window.open("", "_blank", "width=400,height=600");
    if (!printWindow) {
      alert("Please allow pop-ups for this site to print.");
      return;
    }

    this.els.printBtn.disabled = true;
    this.els.printBtn.textContent = "Preparing...";

    // Wait for the gallery URL (from qr.js) so the QR baked into the
    // print output is always correct, even if the upload is still in
    // flight when the guest taps "PRINT NOW".
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

    const sheetsHtml = Array.from({ length: sessionState.quantity })
      .map(() => `<div class="sheet"><img src="${pngUrl}"></div>`)
      .join("");

    const printDoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Print</title>
<style>
  @page { size: 4in 6in; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 4in; height: 6in; background: #fff; }
  .sheet { width: 4in; height: 6in; page-break-after: always; break-after: page; }
  .sheet:last-child { page-break-after: auto; break-after: auto; }
  .sheet img { display: block; width: 4in; height: 6in; }
</style>
</head>
<body>${sheetsHtml}</body>
</html>`;

    printWindow.document.open();
    printWindow.document.write(printDoc);
    printWindow.document.close();

    const firstImg = printWindow.document.querySelector(".sheet img");
    const triggerPrint = () => {
      printWindow.focus();
      printWindow.print();
    };
    if (firstImg.complete) {
      triggerPrint();
    } else {
      firstImg.onload = triggerPrint;
    }
    printWindow.onafterprint = () => printWindow.close();

    // Fire-and-forget: log this print job for the admin dashboard's
    // "copies printed" stat. Never blocks or fails the actual print.
    cloudStorage.logPrintEvent(sessionState.id, sessionState.quantity);

    this.els.printBtn.disabled = false;
    this.els.printBtn.textContent = "🖨 PRINT NOW";
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