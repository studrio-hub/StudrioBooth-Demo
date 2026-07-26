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
    const pngBlob = await stripModule.exportPNG({
      frameType: sessionState.frameType,
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design
    });
    const pngUrl = URL.createObjectURL(pngBlob);
    sessionState.finalPngUrl = pngUrl; // reusable by qr.js / download button

    for (let s = 0; s < sessionState.quantity; s++) {
      const sheet = document.createElement("div");
      sheet.className = "print-sheet";
      const img = document.createElement("img");
      img.className = "print-photo-canvas";
      img.src = pngUrl;
      sheet.appendChild(img);
      this.els.printArea.appendChild(sheet);
    }
  },

  async print() {
    this.els.printBtn.disabled = true;
    this.els.printBtn.textContent = "Preparing...";
    await this.buildPrintArea();
    this.els.printBtn.disabled = false;
    this.els.printBtn.textContent = "🖨 PRINT NOW";
    setTimeout(() => window.print(), 50);
  },

  async exportPngDownload() {
    const pngBlob = await stripModule.exportPNG({
      frameType: sessionState.frameType,
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design
    });
    const url = URL.createObjectURL(pngBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sessionState.id}-${sessionState.frameType}.png`;
    a.click();
  }
};

document.getElementById("btnPrint").addEventListener("click", () => printingModule.print());
document.getElementById("btnExportPng").addEventListener("click", () => printingModule.exportPngDownload());
document.getElementById("btnNewSession").addEventListener("click", () => {
  if (confirm("Start a new session? Current photos and selections will be cleared.")) {
    resetSessionAndRestart();
  }
});
