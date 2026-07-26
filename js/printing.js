/*
 * PRINTING LOGIC — Page 6
 * Builds the on-screen final preview AND the hidden #printArea
 * markup that print.css lays out into real 2x6 / 4x6 sheets.
 *
 * IMPORTANT: window.print() only sends the page to whatever
 * printer the OS print dialog resolves to. For a real kiosk,
 * that's usually a dedicated photo printer (DNP, Mitsubishi,
 * Canon Selphy, etc.) set as the OS default/silent-print printer.
 * True "silent print, no dialog" requires either:
 *   - a kiosk browser flag (e.g. Chrome --kiosk-printing), or
 *   - a native print driver / print server the local bridge
 *     talks to directly (bypassing the browser entirely).
 * That printer-side piece is OUTSIDE what a GitHub Pages static
 * site can control — see the README notes below.
 */

const printingModule = {
  els: {
    finalStripContainer: document.getElementById("finalStripContainer"),
    summaryText: document.getElementById("printSummaryText"),
    printBtn: document.getElementById("btnPrint"),
    newSessionBtn: document.getElementById("btnNewSession"),
    printArea: document.getElementById("printArea")
  },

  init() {
    this.renderPreview();
    this.renderSummary();
  },

  renderPreview() {
    stripModule.render(this.els.finalStripContainer, {
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

 async init() {
    await this.renderPreview();
    this.renderSummary();
  },

  async renderPreview() {
    await stripModule.render(this.els.finalStripContainer, {
      frameType: sessionState.frameType,
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design
    });
  },

  async buildPrintArea() {
    this.els.printArea.innerHTML = "";

    for (let s = 0; s < sessionState.quantity; s++) {
      const canvas = await stripModule.compositeLayout({
        frameType: sessionState.frameType,
        selectedShots: sessionState.selectedShots,
        designId: sessionState.design
      });
      canvas.classList.add("print-photo-canvas");

      const sheet = document.createElement("div");
      sheet.className = "print-sheet";
      sheet.appendChild(canvas);
      this.els.printArea.appendChild(sheet);
    }

    // finalPngUrl is still generated separately for QR/download/export —
    // those paths are unrelated to what actually gets printed now.
    if (!sessionState.finalPngUrl) {
      const pngBlob = await stripModule.exportPNG({
        frameType: sessionState.frameType,
        selectedShots: sessionState.selectedShots,
        designId: sessionState.design
      });
      sessionState.finalPngUrl = URL.createObjectURL(pngBlob);
    }
  },

  async print() {
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

    this.els.printBtn.disabled = false;
    this.els.printBtn.textContent = "🖨 PRINT NOW";
  }
};

document.getElementById("btnPrint").addEventListener("click", () => printingModule.print());
document.getElementById("btnNewSession").addEventListener("click", () => {
  if (confirm("Start a new session? Current photos and selections will be cleared.")) {
    resetSessionAndRestart();
  }
});