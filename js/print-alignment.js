/*
 * PRINT-ALIGNMENT.JS
 * Updated to use Electron IPC for silent printing.
 *
 * localStorage keys:
 *   studrio_printer_prefs       — canonical alignment key written by savePrefs()
 *                                 and read by loadPrefs() for every 4×6 print job.
 *                                 Alignment (scale/offset) only ever applies to
 *                                 the 4×6 pipeline — flipbook/A4 sheets never use it.
 *   studrio_selected_printer    — 4×6 printer name (photo strips, keychain sheets).
 *   studrio_selected_printer_a4 — A4 printer name (flipbook sheets).
 *
 * DUAL PRINTER SETUP (4×6 vs A4)
 * ─────────────────────────────────────────────────────────────────────────
 * The kiosk can have two physically separate, simultaneously-connected
 * printers: one loaded with 4×6 photo paper, one loaded with A4 paper for
 * flipbook sheets. Every function below that talks to a printer takes an
 * optional `printerType` argument ('4x6' | 'a4') so callers pick the right
 * one; it defaults to whichever type that function is normally used for
 * (sendPrintJob → '4x6', sendRawPrintJob → 'a4'), so existing call sites
 * that don't pass it keep working unchanged.
 *
 * The admin panel previously used "studrio_print_alignment" as a separate key.
 * loadPrefs() merges both sources so any previously-saved admin values are
 * honoured until overwritten. savePrefs() always writes to the canonical key.
 *
 * FLIPBOOK SHEETS (no separate print server)
 * ─────────────────────────────────────────────────────────────────────────
 * Flipbook's two A4 print sheets used to go out through a standalone
 * flipbook-print.js module with its own printer selection
 * (studrio_selected_printer_flipbook) and its own IPC call — effectively a
 * second, parallel print path. That module has been removed: flipbook
 * sheets now print through this same module, using this module's own
 * A4 printer slot (studrio_selected_printer_a4 / getConfiguredPrinter('a4')).
 *
 * They do NOT go through sendPrintJob()/compositeForPrint(), though — those
 * always re-apply the operator's scale/offset alignment prefs and hardcode
 * a 4×6 page size, both of which flipbook sheets must never have (they're
 * already composited pixel-exact onto a 2480×3508 A4 canvas by
 * flipbookGenerator). Instead they use sendRawPrintJob() below, which reuses
 * the same Electron IPC plumbing but skips the compositing step entirely
 * and prints at the given page size (A4) as-is, to the A4 printer slot.
 */
const printAlignment = (function () {
  const PREFS_KEY = "studrio_printer_prefs";
  const LEGACY_PREFS_KEY = "studrio_print_alignment"; // admin panel used this key previously

  // Two independent printer selections, one per physical printer/paper type.
  // '4x6' keeps the original key name so existing saved selections keep working.
  const PRINTER_KEYS = {
    "4x6": "studrio_selected_printer",
    "a4":  "studrio_selected_printer_a4"
  };

  function _printerKeyFor(type) {
    return PRINTER_KEYS[type] || PRINTER_KEYS["4x6"];
  }

  const PAGE_W_PX = 2400; // 4in @ 600dpi
  const PAGE_H_PX = 3600; // 6in @ 600dpi
  const PX_PER_MM = 600 / 25.4;

  // Physical page size for flipbook's A4 sheets, used by sendRawPrintJob()
  // (values match what flipbook-print.js used previously — 210mm × 297mm).
  const A4_PAGE_SIZE = { name: "A4", width: 210000, height: 297000 }; // µm

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

  /*
   * getConfiguredPrinter/setConfiguredPrinter — `type` is '4x6' (default) or
   * 'a4'. Each type has its own independent localStorage slot, so both a
   * 4×6 printer and an A4 printer can be configured and connected at the
   * same time without one overwriting the other.
   */
  async function getConfiguredPrinter(type = "4x6") {
    return localStorage.getItem(_printerKeyFor(type));
  }

  async function setConfiguredPrinter(printerName, type = "4x6") {
    localStorage.setItem(_printerKeyFor(type), printerName);
  }

  async function sendPrintJob(imageUrl, copies, prefs, printerType = "4x6") {
    if (!window.electronAPI) throw new Error("Electron API not available");
    
    const printer = await getConfiguredPrinter(printerType);
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
   * sendRawPrintJob — sends an already pixel-exact image (e.g. a flipbook
   * A4 sheet from flipbookGenerator) straight to the configured printer
   * with NO compositing step: no scale/offset prefs, no centering, no
   * reapplied alignment.
   *
   * Takes the sheet as a Blob (not a blob: URL) and reads it directly via
   * FileReader — it does NOT fetch() the blob. fetch() on a blob: URL falls
   * under the app's CSP connect-src, which only allows 'self' and the
   * Supabase origin, so fetching a blob: URL is blocked and throws
   * "Failed to fetch". Loading blob: URLs into <img>/<video> elements (as
   * compositeForPrint() does) is a separate img-src/media-src check that
   * already permits blob:, which is why that path isn't affected — but
   * fetch() here is not, so this must consume the Blob itself directly.
   *
   * printerType defaults to 'a4' (flipbook's own printer slot), independent
   * of whatever the 4×6 printer is set to — see PRINTER_KEYS above.
   *
   * pageSize defaults to A4_PAGE_SIZE, but callers can pass any Electron
   * pageSize object.
   */
  async function sendRawPrintJob(blob, copies, pageSize, printerType = "a4") {
    if (!window.electronAPI) throw new Error("Electron API not available");

    const printer = await getConfiguredPrinter(printerType);
    if (!printer) throw new Error("No printer selected in Admin");

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const result = await window.electronAPI.printSilent({
          filePath: reader.result, // data URL — untouched, no composite step
          printerName: printer,
          settings: {
            copies: copies || 1,
            pageSize: pageSize || A4_PAGE_SIZE,
            scaleFactor: 100, // no additional scaling on top of the given pixels
            printBackground: true,
            margins: { marginType: "none" }
          }
        });
        // Wait for print confirmation before resolving — same contract as
        // sendPrintJob(), so callers can await it before marking a job done.
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
    A4_PAGE_SIZE,
    loadPrefs,
    savePrefs,
    resetPrefs,
    checkAgentHealth,
    listPrinters,
    getConfiguredPrinter,
    setConfiguredPrinter,
    sendPrintJob,
    sendRawPrintJob
  };
})();
