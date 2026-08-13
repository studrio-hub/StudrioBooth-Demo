/*
 * PRINT-ALIGNMENT.JS
 * Updated to use Electron IPC for silent printing.
 *
 * localStorage keys:
 *   studrio_printer_prefs    — canonical alignment key written by savePrefs()
 *                              and read by loadPrefs() for every print job.
 *   studrio_selected_printer — selected printer name (shared with admin).
 *
 * The admin panel previously used "studrio_print_alignment" as a separate key.
 * loadPrefs() merges both sources so any previously-saved admin values are
 * honoured until overwritten. savePrefs() always writes to the canonical key.
 */
const printAlignment = (function () {
  const PREFS_KEY = "studrio_printer_prefs";
  const LEGACY_PREFS_KEY = "studrio_print_alignment"; // admin panel used this key previously
  const SELECTED_PRINTER_KEY = "studrio_selected_printer";

  const PAGE_W_PX = 2400; // 4in @ 600dpi
  const PAGE_H_PX = 3600; // 6in @ 600dpi
  const PX_PER_MM = 600 / 25.4;

  const defaultPrefs = {
    scale: 100,
    offsetX: 0,
    offsetY: 0
  };

  function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function sanitize(prefs) {
    prefs = prefs || {};
    return {
      scale: clamp(prefs.scale, 80, 100, defaultPrefs.scale),
      offsetX: clamp(prefs.offsetX, -15, 15, defaultPrefs.offsetX),
      offsetY: clamp(prefs.offsetY, -15, 15, defaultPrefs.offsetY)
    };
  }

  function loadPrefs() {
    try {
      // Merge canonical key on top of the legacy admin key so that values saved
      // by either the kiosk or the admin panel are always respected.
      // Canonical key wins on conflict (more recent write path).
      const legacy    = JSON.parse(localStorage.getItem(LEGACY_PREFS_KEY) || "{}");
      const canonical = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      return sanitize(Object.assign({}, defaultPrefs, legacy, canonical));
    } catch (e) {
      return Object.assign({}, defaultPrefs);
    }
  }

  function savePrefs(prefs) {
    const clean = sanitize(prefs);
    localStorage.setItem(PREFS_KEY, JSON.stringify(clean));
    return clean;
  }

  /*
   * compositeForPrint — draws the print-ready PNG onto a fresh 2400×3600 canvas
   * with scale + offset applied.
   *
   * Layout model (changed from previous center-anchor):
   *   - At scale=100, offsetX=0, offsetY=0: image is drawn exactly at (0,0),
   *     filling the canvas edge-to-edge with no border anywhere.
   *   - scale<100: image shrinks; it is first centered, then offset is applied.
   *     This gives the operator a predictable "pull away from edges" control.
   *   - offsetX/offsetY (in mm): shift the already-scaled image. Positive X moves
   *     the image to the right (left border grows); negative X moves it left
   *     (right border grows). The canvas clips any overflow so there is never
   *     a double border on the leading edge.
   *
   * At scale=100 with no offset the function is a straight pixel copy — no border
   * is introduced by the compositing step itself. Any remaining white border at
   * that setting comes from the printer driver's minimum non-printable area and
   * must be corrected in the driver's own preferences dialog.
   */
  async function compositeForPrint(imageUrl, prefs) {
    const p = sanitize(prefs);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous"; // needed for blob: URLs in some Electron contexts
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width  = PAGE_W_PX;
        canvas.height = PAGE_H_PX;
        const ctx = canvas.getContext("2d");

        // White base — only visible if scale < 100 or offsets push image outside canvas
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const drawW = PAGE_W_PX * (p.scale / 100);
        const drawH = PAGE_H_PX * (p.scale / 100);

        // Center the scaled image, then apply mm offset on top.
        // At scale=100: centerX=0, centerY=0, so offset alone drives position.
        const centerX = (PAGE_W_PX - drawW) / 2;
        const centerY = (PAGE_H_PX - drawH) / 2;
        const x = centerX + p.offsetX * PX_PER_MM;
        const y = centerY + p.offsetY * PX_PER_MM;

        // Clip to canvas bounds so overflow doesn't wrap or paint outside the page
        ctx.save();
        ctx.rect(0, 0, PAGE_W_PX, PAGE_H_PX);
        ctx.clip();
        ctx.drawImage(img, x, y, drawW, drawH);
        ctx.restore();

        canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new Error("Canvas export failed"));
        }, "image/png");
      };
      img.onerror = () => reject(new Error("Failed to load image for print composite"));
      img.src = imageUrl;
    });
  }

  async function checkAgentHealth() {
    if (window.electronAPI) return { online: true };
    return { online: false, error: "Not running in Electron" };
  }

  async function listPrinters() {
    if (window.electronAPI) return await window.electronAPI.getPrinters();
    return [];
  }

  async function getConfiguredPrinter() {
    return localStorage.getItem(SELECTED_PRINTER_KEY);
  }

  async function setConfiguredPrinter(printerName) {
    localStorage.setItem(SELECTED_PRINTER_KEY, printerName);
  }

  async function sendPrintJob(imageUrl, copies, prefs) {
    if (!window.electronAPI) throw new Error("Electron API not available");
    
    const printer = await getConfiguredPrinter();
    if (!printer) throw new Error("No printer selected in Admin");

    // Apply scale + offset composite first — this is where alignment is baked in.
    const blob = await compositeForPrint(imageUrl, prefs);
    
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const result = await window.electronAPI.printSilent({
          filePath: reader.result, // data URL — already composited with alignment
          printerName: printer,
          settings: {
            copies: copies || 1,
            // Borderless 4×6 — these mirror the Canon/Windows driver paper-size
            // identifiers. Electron's webContents.print() surfaces them under
            // pageSize; a custom name + width/height covers drivers that accept
            // custom media, while scaleFactor:100 prevents the driver from
            // applying any additional scaling on top of our canvas composite.
            pageSize: { name: "4x6", width: 101600, height: 152400 }, // µm (4in × 6in)
            scaleFactor: 100,
            printBackground: true,
            margins: { marginType: "none" }
          }
        });
        if (result.success) resolve({ success: true });
        else reject(new Error(result.error));
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /*
   * resetPrefs — clears both the canonical and legacy alignment keys from
   * localStorage and returns the factory defaults. Call this from the admin
   * panel when previously-saved values from the old px-unit sliders are causing
   * unexpected offsets (old slider went ±200px, new one is ±15mm — any stale
   * large value would have been clamped to ±15 by sanitize(), but a stale
   * value of e.g. 5 stored as "5px" is now silently interpreted as "5mm = 118px",
   * causing a visible left/right border even at what looks like a small offset).
   */
  function resetPrefs() {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(LEGACY_PREFS_KEY);
    return Object.assign({}, defaultPrefs);
  }

  return {
    loadPrefs,
    savePrefs,
    resetPrefs,
    checkAgentHealth,
    listPrinters,
    getConfiguredPrinter,
    setConfiguredPrinter,
    sendPrintJob
  };
})();
