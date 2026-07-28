/*
 * PRINT-ALIGNMENT.JS
 * Shared, dependency-free helpers for printer preferences (system dialog,
 * scale, alignment offsets) and the physical @page/img CSS that implements
 * them. Loaded by BOTH:
 *   - js/printing.js   (kiosk's real print job, page 6)
 *   - js/admin.js      (Admin dashboard's Printer Alignment settings + Test Print)
 * so the exact same math drives real jobs and test jobs alike, and the
 * admin-only "system dialog" toggle has a single source of truth.
 */
const printAlignment = (function () {
  const PREFS_KEY = "studrio_printer_prefs";

  // Physical paper size — both the 2x6 and 4x6 canvases export at
  // 2400x3600 @ 600dpi, i.e. 4in x 6in portrait.
  const PAGE_W_IN = 4;
  const PAGE_H_IN = 6;

  const defaultPrefs = {
    systemDialog: false, // Admin-only. false = silent (--kiosk-printing mode).
    scale: 100,           // 80–100 (%) of the print size
    offsetX: 0,            // -15..15 (mm). Negative = shift left.
    offsetY: 0             // -15..15 (mm). Negative = shift up.
  };

  function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function sanitize(prefs) {
    prefs = prefs || {};
    return {
      systemDialog: !!prefs.systemDialog,
      scale: clamp(prefs.scale, 80, 100, defaultPrefs.scale),
      offsetX: clamp(prefs.offsetX, -15, 15, defaultPrefs.offsetX),
      offsetY: clamp(prefs.offsetY, -15, 15, defaultPrefs.offsetY)
    };
  }

  function loadPrefs() {
    try {
      const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      return sanitize(Object.assign({}, defaultPrefs, stored));
    } catch (e) {
      return Object.assign({}, defaultPrefs);
    }
  }

  function savePrefs(prefs) {
    const clean = sanitize(prefs);
    localStorage.setItem(PREFS_KEY, JSON.stringify(clean));
    return clean;
  }

  /* Builds the @page + img CSS that scales/nudges the strip on the sheet.
   * scale=100 + offsets=0 means the strip fills the full page, centered —
   * use scale < 100 to leave headroom, then offsetX/offsetY to nudge the
   * image within that headroom if the printer's own margins are off-center. */
  function buildPageStyle(prefs) {
    const p = sanitize(prefs);
    const pageW = `${PAGE_W_IN}in`;
    const pageH = `${PAGE_H_IN}in`;
    return `
      @page { size: ${pageW} ${pageH}; margin: 0; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 100%; height: 100%; background: #fff; }
      .sheet {
        width: 100vw; height: 100vh;
        page-break-after: always; break-after: page;
        display: flex; align-items: center; justify-content: center;
        overflow: hidden;
      }
      .sheet:last-child { page-break-after: auto; break-after: auto; }
      .sheet img {
        display: block;
        width: ${p.scale}%;
        height: ${p.scale}%;
        object-fit: contain;
        transform: translate(${p.offsetX}mm, ${p.offsetY}mm);
      }
    `;
  }

  /* Opens an isolated popup, writes `count` copies of `imageUrl`, and fires
   * the print job. Shared by the kiosk's real print job and Admin's Test
   * Print so both go through identical print plumbing.
   * `prefs.systemDialog` only matters at the OS/Chrome-launch level
   * (--kiosk-printing); window.print() itself is called the same way
   * either way — the flag is documented here, not branched on. */
  function openPrintWindow(imageUrl, count, prefs, onDone) {
    const p = sanitize(prefs);
    const printWindow = window.open("", "_blank", "width=816,height=1056");
    if (!printWindow) {
      alert("Please allow pop-ups for this site to print.");
      if (onDone) onDone(false);
      return null;
    }

    const pageStyle = buildPageStyle(p);
    const sheetsHtml = Array.from({ length: Math.max(1, count) })
      .map(() => `<div class="sheet"><img src="${imageUrl}" alt=""></div>`)
      .join("");

    const printDoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Print</title>
<style>${pageStyle}</style>
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

    if (firstImg && firstImg.complete) {
      triggerPrint();
    } else if (firstImg) {
      firstImg.onload = triggerPrint;
    } else {
      setTimeout(triggerPrint, 150);
    }

    printWindow.onafterprint = () => {
      printWindow.close();
      if (onDone) onDone(true);
    };

    return printWindow;
  }

  /* Draws a lightweight alignment test pattern at the exact print
   * resolution (2400x3600 @ 600dpi = 4in x 6in) so Admin's Test Print can
   * verify scale/offset without needing a real photobooth session. */
  function renderTestPatternPNG() {
    const W = 2400, H = 3600;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);

    // Border drawn 1/8in inside the true edge — any crop shows immediately.
    const margin = 75;
    ctx.strokeStyle = "#e2452c";
    ctx.lineWidth = 6;
    ctx.strokeRect(margin, margin, W - margin * 2, H - margin * 2);

    // Center crosshair.
    ctx.strokeStyle = "#1f6feb";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
    ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
    ctx.stroke();

    // Corner marks.
    ctx.fillStyle = "#1f6feb";
    const cs = 60;
    [[0, 0], [W - cs, 0], [0, H - cs], [W - cs, H - cs]].forEach(([x, y]) => {
      ctx.fillRect(x, y, cs, cs);
    });

    ctx.fillStyle = "#111";
    ctx.textAlign = "center";
    ctx.font = "bold 60px sans-serif";
    ctx.fillText("PRINTER ALIGNMENT TEST", W / 2, H / 2 - 80);
    ctx.font = "40px sans-serif";
    ctx.fillText("Edges & crosshair should sit centered on the 4×6 paper", W / 2, H / 2 + 60);

    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(URL.createObjectURL(blob)), "image/png");
    });
  }

  return {
    PREFS_KEY,
    defaultPrefs,
    loadPrefs,
    savePrefs,
    sanitize,
    buildPageStyle,
    openPrintWindow,
    renderTestPatternPNG
  };
})();
