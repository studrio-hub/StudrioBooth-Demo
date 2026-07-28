/*
 * PRINT-ALIGNMENT.JS
 * Shared helpers for printer alignment prefs (scale, offsetX, offsetY) and
 * for talking to the local Studio Booth print-agent (see /print-agent).
 * Loaded by BOTH:
 *   - js/printing.js   (kiosk's real print job, page 6)
 *   - js/admin.js      (Admin dashboard's Printer Setup + Alignment + Test Print)
 * so the exact same math and the exact same network calls drive real jobs
 * and test jobs alike.
 *
 * There is no more browser print dialog anywhere in this flow (kiosk or
 * Admin Test Print) — every print job is a finished bitmap POSTed straight
 * to the local agent, which hands it to CUPS via `lp`. See print-agent/README.md
 * for the full picture and why "localhost" is safe to call from an https
 * GitHub Pages page.
 */
const printAlignment = (function () {
  const PREFS_KEY = "studrio_printer_prefs";

  // The print-agent runs on the same Raspberry Pi as this kiosk's Chromium,
  // so "localhost" is always correct here — see print-agent/README.md if
  // that ever changes (e.g. agent moved to a different machine).
  const AGENT_BASE_URL = "http://localhost:8787";

  // Physical paper size — both the 2x6 and 4x6 canvases export at
  // 2400x3600 @ 600dpi, i.e. 4in x 6in portrait.
  const PAGE_W_IN = 4;
  const PAGE_H_IN = 6;
  const DPI = 600;
  const PAGE_W_PX = PAGE_W_IN * DPI; // 2400
  const PAGE_H_PX = PAGE_H_IN * DPI; // 3600
  const PX_PER_MM = DPI / 25.4;      // ~23.62

  const defaultPrefs = {
    scale: 100,   // 80–100 (%) of the print size
    offsetX: 0,   // -15..15 (mm). Negative = shift left.
    offsetY: 0    // -15..15 (mm). Negative = shift up.
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

  /* Bakes scale/offsetX/offsetY into actual pixels on a fresh 2400x3600
   * canvas. This used to be a CSS @page transform applied at browser-print
   * time — now that printing goes agent -> CUPS with no browser print step
   * at all, there's no CSS left to apply it, so we composite it into the
   * bitmap itself before sending it over. */
  function compositeForPrint(imageUrl, prefs) {
    const p = sanitize(prefs);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = PAGE_W_PX;
        canvas.height = PAGE_H_PX;
        const ctx = canvas.getContext("2d");

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const drawW = PAGE_W_PX * (p.scale / 100);
        const drawH = PAGE_H_PX * (p.scale / 100);
        const x = (PAGE_W_PX - drawW) / 2 + p.offsetX * PX_PER_MM;
        const y = (PAGE_H_PX - drawH) / 2 + p.offsetY * PX_PER_MM;

        ctx.drawImage(img, x, y, drawW, drawH);

        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Canvas export failed"));
        }, "image/png");
      };
      img.onerror = () => reject(new Error("Failed to load image for print compositing"));
      img.src = imageUrl;
    });
  }

  async function agentRequest(pathname, options) {
    let res;
    try {
      res = await fetch(`${AGENT_BASE_URL}${pathname}`, options);
    } catch (e) {
      throw new Error("Can't reach the print agent — is it running on this Pi?");
    }
    if (!res.ok) {
      let message = `Print agent returned ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.error) message = body.error;
      } catch (e) { /* body wasn't JSON — keep the generic message */ }
      throw new Error(message);
    }
    return res.json();
  }

  /* Admin's connection-status indicator and a pre-flight check before real
   * print jobs. Never throws — returns { online: false, error } instead. */
  async function checkAgentHealth() {
    try {
      const data = await agentRequest("/health", { method: "GET" });
      return Object.assign({ online: true }, data);
    } catch (e) {
      return { online: false, error: e.message };
    }
  }

  function listPrinters() {
    return agentRequest("/printers", { method: "GET" });
  }

  function getConfiguredPrinter() {
    return agentRequest("/config", { method: "GET" });
  }

  function setConfiguredPrinter(printerName) {
    return agentRequest("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ printer: printerName })
    });
  }

  /* Composites alignment into pixels, then sends the finished sheet to the
   * local print-agent, which fires it straight at the configured printer
   * via CUPS. Used by both the kiosk's real print job and Admin's Test
   * Print — no browser print dialog exists anywhere in this path. */
  async function sendPrintJob(imageUrl, copies, prefs) {
    const blob = await compositeForPrint(imageUrl, prefs);
    return agentRequest(`/print?copies=${Math.max(1, copies || 1)}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: blob
    });
  }

  /* Draws a lightweight alignment test pattern at the exact print
   * resolution (2400x3600 @ 600dpi = 4in x 6in) so Admin's Test Print can
   * verify scale/offset without needing a real photobooth session. */
  function renderTestPatternPNG() {
    const W = PAGE_W_PX, H = PAGE_H_PX;
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
    AGENT_BASE_URL,
    defaultPrefs,
    loadPrefs,
    savePrefs,
    sanitize,
    compositeForPrint,
    checkAgentHealth,
    listPrinters,
    getConfiguredPrinter,
    setConfiguredPrinter,
    sendPrintJob,
    renderTestPatternPNG
  };
})();
