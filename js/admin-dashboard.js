/*
 * ADMIN-DASHBOARD.JS
 * ─────────────────────────────────────────────────────────────────────────────
 * Staff Control Room dashboard — wired to dashboard.html.
 *
 * Tabs and their responsibilities:
 *   Overview  — odometer stat counters (strips, copies, storage)
 *   Sessions  — film-strip card grid with date filter, select mode, batch delete,
 *               per-session Print / Download Photo / Download Video / Delete
 *   Templates — template manager (delegated to templateManager from
 *               admin-template-manager.js; this file just inits it)
 *   Printer   — agent status, CUPS printer list, alignment sliders, test print
 *
 * Depends on:
 *   cloud-storage.js     — adminStorage (auth, sessions, stats) + adminTemplates
 *   admin-template-manager.js — templateManager module
 *   print-alignment.js   — printAlignment (bakes scale/offset, sends print job)
 *                          NOTE: print-alignment.js is kiosk-side; the admin
 *                          dashboard calls the print agent directly via fetch
 *                          (same pattern as the kiosk) without needing that
 *                          module. Alignment prefs are stored in localStorage.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const PRINT_AGENT_URL  = "https://localhost:3000";
const ALIGN_LS_KEY     = "studrio_print_alignment"; // { scale, offsetX, offsetY }

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
  // Returns YYYY-MM-DD for grouping into date pills
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

      // Lazy-init the template manager on first visit to the Templates tab
      if (target === "templates" && !templatesInited) {
        templatesInited = true;
        templateManager.init().catch((e) => {
          console.error("[admin] Template manager init failed:", e);
        });
      }
    });
  });
}

// ── Overview: odometer stats ──────────────────────────────────────────────────

function animateOdometer(el, targetValue, isBytes) {
  const formatted = isBytes ? formatBytes(targetValue) : String(targetValue);
  // Simple digit-by-digit "slot machine" effect
  const DURATION = 800;
  const START    = Date.now();

  function tick() {
    const elapsed  = Date.now() - START;
    const progress = Math.min(elapsed / DURATION, 1);
    // Ease out cubic
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
    ["statStrips", "statCopies", "statStorage"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = "—";
    });
  }
}

// ── Sessions: state ───────────────────────────────────────────────────────────

let _allSessions    = [];     // full list from Supabase
let _filteredSessions = [];   // after date-filter
let _activeDateKey  = "all";  // currently selected date pill
let _selectMode     = false;
let _selectedIds    = new Set();
let _pendingDeleteIds = [];   // for the delete modal

// ── Sessions: date filter pills ───────────────────────────────────────────────

function buildDateFilter(sessions) {
  const row = document.getElementById("dateFilterRow");
  if (!row) return;

  // Collect unique date keys, newest first
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
  if (_activeDateKey === "all") {
    _filteredSessions = _allSessions;
  } else {
    _filteredSessions = _allSessions.filter((s) =>
      formatDateKey(s.created_at) === _activeDateKey
    );
  }
  // Reset select mode when filter changes
  if (_selectMode) exitSelectMode();
  renderSessionGrid(_filteredSessions);
}

// ── Sessions: select mode ─────────────────────────────────────────────────────

function enterSelectMode() {
  _selectMode = true;
  _selectedIds.clear();
  document.getElementById("btnSelectSessions").textContent = "Cancel";
  document.getElementById("bulkBar").hidden = false;
  updateBulkBar();
  // Re-render to show checkboxes
  renderSessionGrid(_filteredSessions);
}

function exitSelectMode() {
  _selectMode = false;
  _selectedIds.clear();
  document.getElementById("btnSelectSessions").textContent = "Select";
  document.getElementById("bulkBar").hidden = true;
  renderSessionGrid(_filteredSessions);
}

function updateBulkBar() {
  const n = _selectedIds.size;
  document.getElementById("bulkCount").textContent = `${n} selected`;
  document.getElementById("btnDeleteSelected").disabled = n === 0;
}

// ── Sessions: card renderer ───────────────────────────────────────────────────

function renderSessionGrid(sessions) {
  const grid     = document.getElementById("sessionGrid");
  const statusEl = document.getElementById("sessionStatus");
  const countEl  = document.getElementById("sessionCount");

  if (!grid) return;

  const n = sessions.length;
  if (countEl) countEl.textContent = n === 1 ? "1 session" : `${n} sessions`;

  if (n === 0) {
    grid.innerHTML = "";
    statusEl.hidden = false;
    statusEl.textContent = _allSessions.length === 0
      ? "No sessions yet."
      : "No sessions on this date.";
    return;
  }
  statusEl.hidden = true;
  grid.innerHTML = "";

  sessions.forEach((session) => {
    const card = document.createElement("div");
    card.className = "session-card";
    card.dataset.id = session.id;

    // Sprocket holes (film-strip aesthetic)
    const sprocketHtml = Array.from({ length: 6 })
      .map(() => `<div class="sprocket-hole"></div>`)
      .join("");

    const thumbSrc = session.print_ready_url || session.final_strip_url || "";
    const thumbHtml = thumbSrc
      ? `<img class="session-thumb" src="${escapeHtml(thumbSrc)}" alt="Strip preview" loading="lazy">`
      : `<div class="session-thumb session-thumb--empty"></div>`;

    const checkboxHtml = _selectMode
      ? `<label class="session-checkbox-wrap">
           <input type="checkbox" class="session-checkbox" data-id="${session.id}"
             ${_selectedIds.has(session.id) ? "checked" : ""}>
         </label>`
      : "";

    card.innerHTML = `
      <div class="session-card-sprockets left">${sprocketHtml}</div>
      <div class="session-card-body">
        ${checkboxHtml}
        <div class="session-card-thumb">${thumbHtml}</div>
        <div class="session-card-meta">
          <p class="session-card-id">#${escapeHtml(session.id)}</p>
          <p class="session-card-date">${formatDate(session.created_at)}</p>
          <p class="session-card-type">${escapeHtml(session.frame_type || "")} · ${escapeHtml(session.design || "")}</p>
        </div>
        <div class="session-card-actions">
          <button class="btn-admin btn-admin-outline btn-sm" data-action="print">Print Photo</button>
          <button class="btn-admin btn-admin-outline btn-sm" data-action="download">Download Photo (QR)</button>
          <button class="btn-admin btn-admin-outline btn-sm" data-action="video">Download Video</button>
          <button class="btn-admin btn-admin-ghost btn-sm"  data-action="delete">Delete</button>
        </div>
      </div>
      <div class="session-card-sprockets right">${sprocketHtml}</div>
    `;

    // ── Checkbox toggle (select mode) ──────────────────────────────────────
    if (_selectMode) {
      const cb = card.querySelector(".session-checkbox");
      cb.addEventListener("change", () => {
        if (cb.checked) _selectedIds.add(session.id);
        else            _selectedIds.delete(session.id);
        updateBulkBar();
        card.classList.toggle("session-card--selected", cb.checked);
      });
    }

    // ── Print Photo ────────────────────────────────────────────────────────
    card.querySelector('[data-action="print"]').addEventListener("click", async () => {
      if (!session.print_ready_url) { showToast("No print-ready file for this session."); return; }
      try {
        const align = readAlignment();
        // Fetch the PNG and POST it to the print agent (same flow as kiosk)
        const imgRes = await fetch(session.print_ready_url);
        if (!imgRes.ok) throw new Error(`Could not fetch print file: HTTP ${imgRes.status}`);
        const imgBlob = await imgRes.blob();
        // Apply alignment (scale + offset) via an off-screen canvas
        const alignedBlob = await applyPrintAlignment(imgBlob, align);
        const printRes = await fetch(`${PRINT_AGENT_URL}/print?copies=1`, {
          method: "POST",
          body: alignedBlob,
          headers: { "Content-Type": "image/png" }
        });
        if (!printRes.ok) {
          const { error } = await printRes.json().catch(() => ({ error: `HTTP ${printRes.status}` }));
          throw new Error(error);
        }
        showToast(`Printing session #${session.id}…`);
      } catch (e) {
        showToast(`Print failed: ${e.message}`);
      }
    });

    // ── Download Photo (QR already baked in) ──────────────────────────────
    card.querySelector('[data-action="download"]').addEventListener("click", () => {
      const url = session.print_ready_url || session.final_strip_url;
      if (!url) { showToast("No file available for download."); return; }
      const a = document.createElement("a");
      a.href = url; a.download = `studrio-${session.id}-print.png`;
      a.click();
    });

    // ── Download Video ─────────────────────────────────────────────────────
    card.querySelector('[data-action="video"]').addEventListener("click", () => {
      const url = session.final_strip_video_url;
      if (!url) { showToast("No video available for this session."); return; }
      const ext = url.endsWith(".mp4") ? "mp4" : "webm";
      const a = document.createElement("a");
      a.href = url; a.download = `studrio-${session.id}.${ext}`;
      a.click();
    });

    // ── Delete ─────────────────────────────────────────────────────────────
    card.querySelector('[data-action="delete"]').addEventListener("click", () => {
      showDeleteModal([session.id]);
    });

    grid.appendChild(card);
  });
}

// ── Sessions: delete modal ────────────────────────────────────────────────────

function showDeleteModal(ids) {
  _pendingDeleteIds = ids;
  const modal  = document.getElementById("deleteModal");
  const msgEl  = document.getElementById("deleteModalMessage");
  if (!modal) return;
  msgEl.textContent = ids.length === 1
    ? `Delete session #${ids[0]}? This removes all files from Supabase and cannot be undone.`
    : `Delete ${ids.length} sessions? This removes all files from Supabase and cannot be undone.`;
  modal.hidden = false;
}

function wireDeleteModal() {
  document.getElementById("btnDeleteCancel").addEventListener("click", () => {
    _pendingDeleteIds = [];
    document.getElementById("deleteModal").hidden = true;
  });

  document.getElementById("btnDeleteConfirm").addEventListener("click", async () => {
    const ids = _pendingDeleteIds;
    if (!ids.length) return;

    const confirmBtn = document.getElementById("btnDeleteConfirm");
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Deleting…";

    let succeeded = 0, failed = 0;
    for (const id of ids) {
      try {
        await adminStorage.deleteSession(id);
        succeeded++;
      } catch (e) {
        console.error(`[admin] Delete failed for ${id}:`, e);
        failed++;
      }
    }

    confirmBtn.disabled = false;
    confirmBtn.textContent = "Delete";
    document.getElementById("deleteModal").hidden = true;
    _pendingDeleteIds = [];

    if (failed === 0) {
      showToast(ids.length === 1 ? "Session deleted." : `${succeeded} sessions deleted.`);
    } else {
      showToast(`Deleted ${succeeded} of ${ids.length} — ${failed} failed.`);
    }

    await loadSessions();
  });
}

// ── Sessions: load ────────────────────────────────────────────────────────────

async function loadSessions() {
  const statusEl = document.getElementById("sessionStatus");
  const grid     = document.getElementById("sessionGrid");
  statusEl.hidden = false;
  statusEl.textContent = "Loading sessions…";
  grid.innerHTML = "";
  _selectedIds.clear();
  if (_selectMode) exitSelectMode();

  try {
    _allSessions = await adminStorage.listAllSessions();
    _activeDateKey = "all";
    _filteredSessions = _allSessions;
    buildDateFilter(_allSessions);
    renderSessionGrid(_filteredSessions);
  } catch (e) {
    statusEl.hidden = false;
    statusEl.textContent = `Could not load sessions: ${e.message}`;
  }
}

// ── Sessions: select mode wiring ──────────────────────────────────────────────

function wireSelectMode() {
  document.getElementById("btnSelectSessions").addEventListener("click", () => {
    if (_selectMode) exitSelectMode();
    else enterSelectMode();
  });

  document.getElementById("btnCancelSelect").addEventListener("click", exitSelectMode);

  document.getElementById("btnDeleteSelected").addEventListener("click", () => {
    if (_selectedIds.size === 0) return;
    showDeleteModal([..._selectedIds]);
  });
}

// ── Print alignment: apply scale + offset to a PNG blob ──────────────────────
// Mirrors the kiosk's print-alignment.js logic without importing that module.

async function applyPrintAlignment(blob, align) {
  const scale   = (align.scale   ?? 100) / 100;
  const offsetX = align.offsetX  ?? 0;
  const offsetY = align.offsetY  ?? 0;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas  = document.createElement("canvas");
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx     = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const drawW = img.naturalWidth  * scale;
      const drawH = img.naturalHeight * scale;
      const drawX = (img.naturalWidth  - drawW) / 2 + offsetX;
      const drawY = (img.naturalHeight - drawH) / 2 + offsetY;
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
      canvas.toBlob((b) => resolve(b || blob), "image/png");
    };
    img.onerror = () => resolve(blob);
    img.src = URL.createObjectURL(blob);
  });
}

// ── Printer tab ───────────────────────────────────────────────────────────────

async function initPrinterTab() {
  const dotEl    = document.getElementById("printerAgentDot");
  const labelEl  = document.getElementById("printerAgentLabel");
  const selectorWrap = document.getElementById("printerSelectorWrap");
  const selectEl     = document.getElementById("printerSelect");
  const alignSection = document.getElementById("alignmentSection");

  // ── Agent health check ──────────────────────────────────────────────────────
  let agentOnline = false;
  let configuredPrinter = null;
  try {
    const res = await fetch(`${PRINT_AGENT_URL}/printers`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { printers, cupsDefault, configured } = await res.json();

    agentOnline = true;
    configuredPrinter = configured;
    dotEl.classList.add("dot-online");
    labelEl.textContent = `Agent online · ${printers.length} printer${printers.length !== 1 ? "s" : ""} available`;

    // Populate printer selector
    selectEl.innerHTML = `<option value="">— Select a printer —</option>`;
    printers.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = `${p.name}${p.isCupsDefault ? " (CUPS default)" : ""}`;
      if (p.name === configured) opt.selected = true;
      selectEl.appendChild(opt);
    });
    selectorWrap.hidden = false;
    alignSection.hidden = false;

  } catch (e) {
    dotEl.classList.add("dot-offline");
    labelEl.textContent = "Agent offline — start the server first.";
    console.warn("[admin] Print agent not reachable:", e.message);
  }

  // ── Save printer ────────────────────────────────────────────────────────────
  document.getElementById("btnSavePrinter").addEventListener("click", async () => {
    const printer = selectEl.value;
    if (!printer) { showToast("Select a printer first."); return; }
    try {
      const res = await fetch(`${PRINT_AGENT_URL}/printer/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printer })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast(`Printer set to "${printer}".`);
    } catch (e) {
      showToast(`Could not save printer: ${e.message}`);
    }
  });

  // ── Alignment sliders ────────────────────────────────────────────────────────
  const align = readAlignment();
  const scaleSlider = document.getElementById("alignScale");
  const xSlider     = document.getElementById("alignX");
  const ySlider     = document.getElementById("alignY");
  const scaleVal    = document.getElementById("alignScaleVal");
  const xVal        = document.getElementById("alignXVal");
  const yVal        = document.getElementById("alignYVal");

  scaleSlider.value = align.scale   ?? 100;
  xSlider.value     = align.offsetX ?? 0;
  ySlider.value     = align.offsetY ?? 0;
  scaleVal.textContent = scaleSlider.value;
  xVal.textContent     = xSlider.value;
  yVal.textContent     = ySlider.value;

  scaleSlider.addEventListener("input", () => { scaleVal.textContent = scaleSlider.value; });
  xSlider.addEventListener("input",     () => { xVal.textContent     = xSlider.value; });
  ySlider.addEventListener("input",     () => { yVal.textContent     = ySlider.value; });

  // ── Save alignment ───────────────────────────────────────────────────────────
  document.getElementById("btnSaveAlignment").addEventListener("click", () => {
    saveAlignment({
      scale:   Number(scaleSlider.value),
      offsetX: Number(xSlider.value),
      offsetY: Number(ySlider.value)
    });
    showToast("Alignment saved.");
  });

  // ── Test print ───────────────────────────────────────────────────────────────
  document.getElementById("btnTestPrint").addEventListener("click", async () => {
    const printer = selectEl.value || configuredPrinter;
    if (!printer) { showToast("Select a printer first."); return; }

    showToast("Generating test print…");
    try {
      // Build a simple solid-colour PNG test page at low resolution
      const canvas = document.createElement("canvas");
      canvas.width  = 1200;
      canvas.height = 1800;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#f0c231";
      ctx.fillRect(60, 60, canvas.width - 120, 120);
      ctx.fillStyle = "#1a1a2e";
      ctx.font = "bold 72px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Studrio Booth — Test Print", canvas.width / 2, 140);
      ctx.fillStyle = "#333";
      ctx.font = "48px Inter, sans-serif";
      ctx.fillText(new Date().toLocaleString(), canvas.width / 2, 240);

      const testBlob = await new Promise((res) => canvas.toBlob(res, "image/png"));
      const align = readAlignment();
      const alignedBlob = await applyPrintAlignment(testBlob, align);

      const url = `${PRINT_AGENT_URL}/print?copies=1&printer=${encodeURIComponent(printer)}`;
      const res = await fetch(url, {
        method: "POST", body: alignedBlob, headers: { "Content-Type": "image/png" }
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      showToast(`Test print sent to "${printer}".`);
    } catch (e) {
      showToast(`Test print failed: ${e.message}`);
    }
  });
}

// ── Auth guard ────────────────────────────────────────────────────────────────

async function guardAuth() {
  const user = await adminStorage.getCurrentUser();
  if (!user) {
    window.location.href = "index.html";
    return false;
  }
  return true;
}

// ── Sign out ──────────────────────────────────────────────────────────────────

function wireSignOut() {
  document.getElementById("btnSignOut").addEventListener("click", async () => {
    await adminStorage.signOut();
    window.location.href = "index.html";
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async function init() {
  const authed = await guardAuth();
  if (!authed) return;

  // Tab navigation (inits template manager lazily on first tab visit)
  initTabs();

  // Wire static UI elements
  wireSignOut();
  wireDeleteModal();
  wireSelectMode();

  // Load initial data (Overview tab is shown first)
  await Promise.all([loadStats(), loadSessions()]);

  // Printer tab is populated lazily the first time its tab button is clicked
  const printerTab = document.querySelector('[data-tab="printer"]');
  let printerInited = false;
  printerTab.addEventListener("click", () => {
    if (!printerInited) {
      printerInited = true;
      initPrinterTab().catch((e) => console.error("[admin] Printer tab init failed:", e));
    }
  });

  // Auth state changes (e.g. session expiry)
  adminStorage.onAuthChange((user) => {
    if (!user) window.location.href = "index.html";
  });
})();
