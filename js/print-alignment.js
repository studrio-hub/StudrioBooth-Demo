/*
 * PRINT-ALIGNMENT.JS
 * Updated to use Electron IPC for silent printing.
 */
const printAlignment = (function () {
  const PREFS_KEY = "studrio_printer_prefs";
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

  async function compositeForPrint(imageUrl, prefs) {
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
        canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new Error("Canvas export failed"));
        }, "image/png");
      };
      img.onerror = () => reject(new Error("Failed to load image"));
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

    const blob = await compositeForPrint(imageUrl, prefs);
    
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const result = await window.electronAPI.printSilent({
          filePath: reader.result, // data URL
          printerName: printer,
          settings: { copies: copies || 1 }
        });
        if (result.success) resolve({ success: true });
        else reject(new Error(result.error));
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  return {
    loadPrefs,
    savePrefs,
    checkAgentHealth,
    listPrinters,
    getConfiguredPrinter,
    setConfiguredPrinter,
    sendPrintJob
  };
})();
