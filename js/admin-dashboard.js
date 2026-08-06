/*
 * ADMIN-DASHBOARD.JS
 * ─────────────────────────────────────────────────────────────────────────────
 * Staff Control Room dashboard — wired to dashboard.html.
 */

// ── Constants ─────────────────────────────────────────────────────────────────
const ALIGN_LS_KEY     = "studrio_print_alignment"; // { scale, offsetX, offsetY }
const PRINTER_LS_KEY   = "studrio_selected_printer";

// ── Helpers ───────────────────────────────────────────────────────────────────

function showToast(message) {
  const toast = document.getElementById("adminToast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, 3500);
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(isoString) {
  if (!isoString) return "";
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric"
    });
  } catch (e) { return isoString; }
}

function formatDateKey(isoString) {
  if (!isoString) return "";
  try { return isoString.substring(0, 10); }
  catch (e) { return ""; }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readAlignment() {
  try { return JSON.parse(localStorage.getItem(ALIGN_LS_KEY) || "{}"); }
  catch (e) { return {}; }
}

function saveAlignment(prefs) {
  try { localStorage.setItem(ALIGN_LS_KEY, JSON.stringify(prefs)); }
  catch (e) { console.warn("[admin] Could not save alignment to localStorage"); }
}

function getSavedPrinter() {
  return localStorage.getItem(PRINTER_LS_KEY);
}

function savePrinter(name) {
  localStorage.setItem(PRINTER_LS_KEY, name);
}

// ── Tab navigation ────────────────────────────────────────────────────────────

function initTabs() {
  const tabs   = document.querySelectorAll(".admin-tab");
  const panels = document.querySelectorAll(".admin-panel");

  let templatesInited = false;

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      panels.forEach((p) => p.classList.toggle("active", p.dataset.panel === target));
      if (target === "templates" && !templatesInited) {
        templatesInited = true;
        templateManager.init().catch((e) => console.error("[admin] Template manager init failed:", e));
      }
    });
  });
}

// ── Overview: odometer stats ──────────────────────────────────────────────────

function animateOdometer(el, targetValue, isBytes) {
  const formatted = isBytes ? formatBytes(targetValue) : String(targetValue);
  const DURATION = 800;
  const START    = Date.now();
  function tick() {
    const elapsed  = Date.now() - START;
    const progress = Math.min(elapsed / DURATION, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = isBytes
      ? formatBytes(Math.round(targetValue * eased))
      : String(Math.round(targetValue * eased));
    el.textContent = current;
    if (progress < 1) requestAnimationFrame(tick);
    else el.textContent = formatted;
  }
  requestAnimationFrame(tick);
}

async function loadStats() {
  try {
    const stats = await adminStorage.getStats();
    animateOdometer(document.getElementById("statStrips"),  stats.photostripCount,     false);
    animateOdometer(document.getElementById("statCopies"),  stats.totalCopiesPrinted,  false);
    animateOdometer(document.getElementById("statStorage"), stats.totalStorageBytes,    true);
  } catch (e) {
    console.error("[admin] Could not load stats:", e);
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────
let _allSessions = [];
let _filteredSessions = [];
let _activeDateKey = "all";
let _selectMode = false;
let _selectedIds = new Set();

async function loadSessions() {
  try {
    _allSessions = await adminStorage.listAllSessions();
    buildDateFilter(_allSessions);
    applyDateFilter();
  } catch (e) {
    console.error("[admin] Could not load sessions:", e);
  }
}

function buildDateFilter(sessions) {
  const row = document.getElementById("dateFilterRow");
  if (!row) return;
  const seen = new Set();
  const dates = [];
  for (const s of sessions) {
    const key = formatDateKey(s.created_at);
    if (key && !seen.has(key)) { seen.add(key); dates.push(key); }
  }
  row.innerHTML = "";
  const makePill = (label, key) => {
    const btn = document.createElement("button");
    btn.className = "date-pill" + (key === _activeDateKey ? " active" : "");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      _activeDateKey = key;
      row.querySelectorAll(".date-pill").forEach((p) => p.classList.toggle("active", p === btn));
      applyDateFilter();
    });
    row.appendChild(btn);
  };
  makePill("All", "all");
  dates.forEach((key) => {
    const label = formatDate(key + "T00:00:00Z");
    makePill(label, key);
  });
}

function applyDateFilter() {
  _filteredSessions = _activeDateKey === "all" ? _allSessions : _allSessions.filter(s => formatDateKey(s.created_at) === _activeDateKey);
  if (_selectMode) exitSelectMode();
  renderSessionGrid(_filteredSessions);
}

function renderSessionGrid(sessions) {
  const grid = document.getElementById("sessionGrid");
  const countEl = document.getElementById("sessionCount");
  if (!grid) return;
  countEl.textContent = `${sessions.length} sessions`;
  grid.innerHTML = "";
  sessions.forEach(session => {
    const card = document.createElement("div");
    card.className = "session-card";
    const thumbSrc = session.print_ready_url || session.final_strip_url || "";
    card.innerHTML = `
      <div class="session-card-body">
        <div class="session-card-thumb"><img src="${escapeHtml(thumbSrc)}" loading="lazy"></div>
        <div class="session-card-meta">
          <p class="session-card-id">#${escapeHtml(session.id)}</p>
          <p class="session-card-date">${formatDate(session.created_at)}</p>
        </div>
        <div class="session-card-actions">
          <button class="btn-admin btn-admin-outline btn-sm" data-action="print">Print</button>
          <button class="btn-admin btn-admin-outline btn-sm" data-action="download">Download</button>
          <button class="btn-admin btn-admin-ghost btn-sm" data-action="delete">Delete</button>
        </div>
      </div>
    `;
    card.querySelector('[data-action="print"]').addEventListener("click", () => handlePrint(session));
    card.querySelector('[data-action="download"]').addEventListener("click", () => handleDownload(session));
    card.querySelector('[data-action="delete"]').addEventListener("click", () => showDeleteModal([session.id]));
    grid.appendChild(card);
  });
}

async function handlePrint(session) {
  if (!session.print_ready_url) { showToast("No print-ready file."); return; }
  try {
    const align = readAlignment();
    const printer = getSavedPrinter();
    if (!printer) { showToast("Select a printer in the Printer tab first."); return; }
    
    showToast("Preparing print...");
    const imgRes = await fetch(session.print_ready_url);
    const imgBlob = await imgRes.blob();
    const alignedBlob = await applyPrintAlignment(imgBlob, align);
    
    // In Electron, we need a local path or a data URL
    const reader = new FileReader();
    reader.onloadend = async () => {
      const result = await window.electronAPI.printSilent({
        filePath: reader.result,
        printerName: printer,
        settings: {}
      });
      if (result.success) showToast("Print sent!");
      else showToast(`Print failed: ${result.error}`);
    };
    reader.readAsDataURL(alignedBlob);
  } catch (e) {
    showToast(`Print error: ${e.message}`);
  }
}

async function handleDownload(session) {
  const url = session.print_ready_url || session.final_strip_url;
  if (!url) { showToast("No file to download."); return; }
  
  try {
    showToast("Starting download...");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = `${session.id}-photo-with-qr.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
  } catch (e) {
    console.error("[admin] Download failed:", e);
    showToast("Download failed.");
  }
}

async function applyPrintAlignment(blob, align) {
  const scale = (align.scale ?? 100) / 100;
  const offsetX = align.offsetX ?? 0;
  const offsetY = align.offsetY ?? 0;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      const drawW = img.naturalWidth * scale;
      const drawH = img.naturalHeight * scale;
      const drawX = (img.naturalWidth - drawW) / 2 + offsetX;
      const drawY = (img.naturalHeight - drawH) / 2 + offsetY;
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
      canvas.toBlob(b => resolve(b || blob), "image/png");
    };
    img.src = URL.createObjectURL(blob);
  });
}

// ── Printer Tab ───────────────────────────────────────────────────────────────

async function initPrinterTab() {
  const dotEl = document.getElementById("printerAgentDot");
  const labelEl = document.getElementById("printerAgentLabel");
  const selectorWrap = document.getElementById("printerSelectorWrap");
  const selectEl = document.getElementById("printerSelect");
  const alignSection = document.getElementById("alignmentSection");

  if (window.electronAPI) {
    dotEl.classList.add("dot-online");
    labelEl.textContent = "Electron IPC active";
    labelEl.classList.add("is-online");
    document.getElementById("printerOfflineNotice").hidden = true;

    const printers = await window.electronAPI.getPrinters();
    const savedPrinter = getSavedPrinter();
    
    selectEl.innerHTML = `<option value="">— Select a printer —</option>`;
    printers.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.name;
      if (p.name === savedPrinter) opt.selected = true;
      selectEl.appendChild(opt);
    });
    selectorWrap.hidden = false;
    alignSection.hidden = false;
  }

  document.getElementById("btnSavePrinter").addEventListener("click", () => {
    savePrinter(selectEl.value);
    showToast("Printer saved.");
  });

  document.getElementById("btnOpenPrinterPrefs").addEventListener("click", async () => {
    const printer = selectEl.value;
    if (!printer) { showToast("Select a printer first."); return; }
    const res = await window.electronAPI.openPrinterPreferences(printer);
    if (!res.success) showToast(`Error: ${res.error}`);
  });

  // Alignment Sliders
  const align = readAlignment();
  const scaleSlider = document.getElementById("alignScale");
  const xSlider = document.getElementById("alignX");
  const ySlider = document.getElementById("alignY");
  
  scaleSlider.value = align.scale ?? 100;
  xSlider.value = align.offsetX ?? 0;
  ySlider.value = align.offsetY ?? 0;
  
  document.getElementById("btnSaveAlignment").addEventListener("click", () => {
    saveAlignment({
      scale: Number(scaleSlider.value),
      offsetX: Number(xSlider.value),
      offsetY: Number(ySlider.value)
    });
    showToast("Alignment saved.");
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async function init() {
  const user = await adminStorage.getCurrentUser();
  if (!user) { window.location.href = "index.html"; return; }

  initTabs();
  await Promise.all([loadStats(), loadSessions()]);

  const printerTab = document.querySelector('[data-tab="printer"]');
  let printerInited = false;
  printerTab.addEventListener("click", () => {
    if (!printerInited) {
      printerInited = true;
      initPrinterTab().catch(e => console.error(e));
    }
  });

  document.getElementById("btnSignOut").addEventListener("click", async () => {
    await adminStorage.signOut();
    window.location.href = "index.html";
  });
})();
