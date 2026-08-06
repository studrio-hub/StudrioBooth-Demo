/*
 * ADMIN-DASHBOARD.JS — Studrio Booth Control Room
 */

(function() {

  const state = {
    user: null,
    stats: { strips: 0, copies: 0, storage: 0 },
    sessions: [],
    filteredSessions: [],
    activeDateKey: 'all',
    selectMode: false,
    selectedIds: new Set(),
    idsToDelete: [],
    printers: [],
    selectedPrinter: localStorage.getItem('studrio_selected_printer') || ''
  };

  // ── Initialization ────────────────────────────────────────────────────────

  async function init() {
    console.log("[Admin] Initializing dashboard...");
    
    // 1. Check Auth
    const client = adminStorage.getClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user) {
      console.warn("[Admin] No user found, redirecting to login...");
      window.location.href = 'index.html';
      return;
    }
    state.user = user;

    // 2. Wire UI
    initTabs();
    wireSessions();
    wireHardware();
    wireSignOut();

    // 3. Load Data
    loadStats();
    loadSessions();
    
    // 4. Initial Hardware Check
    checkHardware();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function showToast(message, type = 'success') {
    const toast = document.getElementById("adminToast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `admin-toast ${type}`;
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
    return new Date(isoString).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric"
    });
  }

  function formatDateKey(isoString) {
    if (!isoString) return "";
    return isoString.substring(0, 10);
  }

  // ── Tab navigation ────────────────────────────────────────────────────────────

  function initTabs() {
    const tabs   = document.querySelectorAll(".admin-tab");
    const panels = document.querySelectorAll(".admin-panel");

    if (tabs.length === 0) {
      console.error("[Admin] No tabs found in DOM!");
      return;
    }

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.dataset.tab;
        console.log("[Admin] Switching to tab:", target);
        
        // Update tab buttons
        tabs.forEach((t) => t.classList.toggle("active", t === tab));
        
        // Update panels
        panels.forEach((p) => {
          const isActive = p.dataset.panel === target;
          p.classList.toggle("active", isActive);
        });
        
        // Tab-specific logic
        if (target === "templates") {
          if (typeof templateManager !== 'undefined') templateManager.init();
        }
        if (target === "hardware") {
          checkHardware();
        }
      });
    });
  }

  // ── Hardware (Camera + Printer) ──────────────────────────────────────────

  function wireHardware() {
    // Printer Save
    document.getElementById('btnSavePrinter')?.addEventListener('click', () => {
      const printer = document.getElementById('printerSelect').value;
      state.selectedPrinter = printer;
      localStorage.setItem('studrio_selected_printer', printer);
      showToast('Printer settings saved');
    });

    // Printer Prefs
    document.getElementById('btnOpenPrinterPrefs')?.addEventListener('click', async () => {
      if (!window.electronAPI) return;
      const printer = document.getElementById('printerSelect').value;
      if (!printer) return showToast('Select a printer first', 'error');
      
      showToast('Opening printer preferences...');
      await window.electronAPI.openPrinterPreferences(printer);
    });

    // Alignment Save
    document.getElementById('btnSaveAlignment')?.addEventListener('click', () => {
      const config = {
        scale: parseInt(document.getElementById('alignScale').value),
        offsetX: parseInt(document.getElementById('alignX').value),
        offsetY: parseInt(document.getElementById('alignY').value)
      };
      localStorage.setItem('studrio_print_alignment', JSON.stringify(config));
      showToast('Alignment saved');
    });

    // Refresh Camera
    document.getElementById('btnRefreshCamera')?.addEventListener('click', () => {
      checkHardware();
      showToast('Refreshing hardware connection...');
    });

    // Alignment Sliders
    ['alignScale', 'alignX', 'alignY'].forEach(id => {
      const el = document.getElementById(id);
      const out = document.getElementById(id + 'Val');
      if (el && out) {
        el.addEventListener('input', () => { out.textContent = el.value; });
      }
    });

    // Load saved alignment
    const savedAlign = localStorage.getItem('studrio_print_alignment');
    if (savedAlign) {
      try {
        const config = JSON.parse(savedAlign);
        if (config.scale) {
          document.getElementById('alignScale').value = config.scale;
          document.getElementById('alignScaleVal').textContent = config.scale;
        }
        if (config.offsetX !== undefined) {
          document.getElementById('alignX').value = config.offsetX;
          document.getElementById('alignXVal').textContent = config.offsetX;
        }
        if (config.offsetY !== undefined) {
          document.getElementById('alignY').value = config.offsetY;
          document.getElementById('alignYVal').textContent = config.offsetY;
        }
      } catch(e) {}
    }
  }

  async function checkHardware() {
    console.log("[Admin] Checking hardware status...");
    
    // 1. Check Printer Agent (Electron)
    const dot = document.getElementById('printerAgentDot');
    const label = document.getElementById('printerAgentLabel');
    const selectorWrap = document.getElementById('printerSelectorWrap');
    const offlineNotice = document.getElementById('printerOfflineNotice');
    const alignmentSection = document.getElementById('alignmentSection');

    if (window.electronAPI) {
      if (dot) dot.className = 'printer-agent-dot online';
      if (label) label.textContent = 'Electron Agent Online';
      if (selectorWrap) selectorWrap.hidden = false;
      if (offlineNotice) offlineNotice.hidden = true;
      if (alignmentSection) alignmentSection.hidden = false;

      // Load Printers
      try {
        const printers = await window.electronAPI.getPrinters();
        const select = document.getElementById('printerSelect');
        if (select) {
          const currentVal = select.value || state.selectedPrinter;
          select.innerHTML = '<option value="">— Select a printer —</option>';
          printers.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.name + (p.isDefault ? ' (Default)' : '');
            select.appendChild(opt);
          });
          select.value = currentVal;
        }
      } catch (e) { console.error("[Admin] Failed to get printers:", e); }
    } else {
      if (dot) dot.className = 'printer-agent-dot offline';
      if (label) label.textContent = 'Agent Offline';
      if (selectorWrap) selectorWrap.hidden = true;
      if (offlineNotice) offlineNotice.hidden = false;
      if (alignmentSection) alignmentSection.hidden = true;
    }

    // 2. Check Camera
    const cameraDot = document.getElementById('cameraStatusDot');
    const cameraLabel = document.getElementById('cameraStatusLabel');
    const cameraBox = document.getElementById('cameraModelBox');

    if (window.electronAPI) {
      try {
        const result = await window.electronAPI.detectCamera();
        if (result && result.success) {
          const isSimulated = result.model.includes('Simulated');
          if (cameraDot) cameraDot.className = `printer-agent-dot ${isSimulated ? 'offline' : 'online'}`;
          if (cameraLabel) cameraLabel.textContent = isSimulated ? 'Simulated Mode' : 'Camera Connected';
          if (cameraBox) cameraBox.textContent = result.model;
        } else {
          if (cameraDot) cameraDot.className = 'printer-agent-dot offline';
          if (cameraLabel) cameraLabel.textContent = 'Not Found';
          if (cameraBox) cameraBox.textContent = 'No camera detected';
        }
      } catch (e) {
        console.error('[Admin] Camera detection failed:', e);
      }
    } else {
      if (cameraDot) cameraDot.className = 'printer-agent-dot offline';
      if (cameraLabel) cameraLabel.textContent = 'Agent Offline';
      if (cameraBox) cameraBox.textContent = 'Browser-only mode (No DSLR access)';
    }
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  function wireSessions() {
    document.getElementById('btnSelectSessions')?.addEventListener('click', enterSelectMode);
    document.getElementById('btnCancelSelect')?.addEventListener('click', exitSelectMode);
    document.getElementById('btnDeleteSelected')?.addEventListener('click', () => {
      showDeleteModal(Array.from(state.selectedIds));
    });
    document.getElementById('btnDeleteConfirm')?.addEventListener('click', handleConfirmDelete);
    document.getElementById('btnDeleteCancel')?.addEventListener('click', hideDeleteModal);
  }

  async function loadSessions() {
    try {
      state.allSessions = await adminStorage.listAllSessions();
      buildDateFilter(state.allSessions);
      applyDateFilter();
    } catch (e) {
      console.error("[Admin] Could not load sessions:", e);
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
      btn.className = "date-pill" + (key === state.activeDateKey ? " active" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => {
        state.activeDateKey = key;
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
    state.filteredSessions = state.activeDateKey === "all" 
      ? state.allSessions 
      : state.allSessions.filter(s => formatDateKey(s.created_at) === state.activeDateKey);
    
    if (state.selectMode) exitSelectMode();
    renderSessionGrid(state.filteredSessions);
  }

  function renderSessionGrid(sessions) {
    const grid = document.getElementById("sessionGrid");
    const countEl = document.getElementById("sessionCount");
    const statusEl = document.getElementById("sessionStatus");
    if (!grid) return;

    if (statusEl) statusEl.hidden = sessions.length > 0;
    if (sessions.length === 0 && statusEl) statusEl.textContent = "No sessions found.";

    if (countEl) countEl.textContent = `${sessions.length} sessions`;
    grid.innerHTML = "";
    sessions.forEach(session => {
      const card = document.createElement("div");
      card.className = "session-card";
      if (state.selectedIds.has(session.id)) card.classList.add("session-card--selected");
      
      const thumbSrc = session.print_ready_url || session.final_strip_url || "";
      card.innerHTML = `
        <div class="session-card-sprockets"></div>
        <div class="session-card-body">
          ${state.selectMode ? `
            <div class="session-checkbox-wrap">
              <input type="checkbox" class="session-checkbox" ${state.selectedIds.has(session.id) ? 'checked' : ''}>
            </div>
          ` : ''}
          <div class="session-card-thumb"><img src="${thumbSrc}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\"session-thumb--empty\">No image</div>'"></div>
          <div class="session-card-meta">
            <p class="session-card-date">${formatDate(session.created_at)}</p>
            <p class="session-card-id">#${session.id}</p>
          </div>
          <div class="session-card-actions">
            <button class="btn-admin btn-admin-outline btn-sm" data-action="print">Print</button>
            <button class="btn-admin btn-admin-outline btn-sm" data-action="download">Save</button>
            <button class="btn-admin btn-admin-ghost btn-sm" data-action="delete">Delete</button>
          </div>
        </div>
        <div class="session-card-sprockets"></div>
      `;

      card.addEventListener("click", (e) => {
        if (state.selectMode) {
          toggleSelectSession(session.id, card);
        }
      });

      card.querySelector('[data-action="print"]').addEventListener("click", (e) => {
        e.stopPropagation();
        handlePrint(session);
      });
      card.querySelector('[data-action="download"]').addEventListener("click", (e) => {
        e.stopPropagation();
        handleDownload(session);
      });
      card.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
        e.stopPropagation();
        showDeleteModal([session.id]);
      });
      grid.appendChild(card);
    });
  }

  function enterSelectMode() {
    state.selectMode = true;
    state.selectedIds.clear();
    document.getElementById("btnSelectSessions").hidden = true;
    document.getElementById("bulkBar").hidden = false;
    renderSessionGrid(state.filteredSessions);
    updateBulkCount();
  }

  function exitSelectMode() {
    state.selectMode = false;
    state.selectedIds.clear();
    document.getElementById("btnSelectSessions").hidden = false;
    document.getElementById("bulkBar").hidden = true;
    renderSessionGrid(state.filteredSessions);
  }

  function toggleSelectSession(id, cardEl) {
    const checkbox = cardEl.querySelector('.session-checkbox');
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
      cardEl.classList.remove("session-card--selected");
      if (checkbox) checkbox.checked = false;
    } else {
      state.selectedIds.add(id);
      cardEl.classList.add("session-card--selected");
      if (checkbox) checkbox.checked = true;
    }
    updateBulkCount();
  }

  function updateBulkCount() {
    const count = state.selectedIds.size;
    const countEl = document.getElementById("bulkCount");
    const deleteBtn = document.getElementById("btnDeleteSelected");
    if (countEl) countEl.textContent = `${count} selected`;
    if (deleteBtn) deleteBtn.disabled = count === 0;
  }

  function showDeleteModal(ids) {
    state.idsToDelete = ids;
    const modal = document.getElementById("deleteModal");
    const msg = document.getElementById("deleteModalMessage");
    if (!modal) return;
    if (ids.length > 1) {
      msg.textContent = `Delete ${ids.length} selected sessions? This cannot be undone.`;
    } else {
      msg.textContent = "Delete this session? This cannot be undone.";
    }
    modal.hidden = false;
  }

  function hideDeleteModal() {
    const modal = document.getElementById("deleteModal");
    if (modal) modal.hidden = true;
    state.idsToDelete = [];
  }

  async function handleConfirmDelete() {
    if (!state.idsToDelete.length) return;
    
    const btn = document.getElementById("btnDeleteConfirm");
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Deleting...";

    try {
      for (const id of state.idsToDelete) {
        await adminStorage.deleteSession(id);
      }
      showToast(`Deleted ${state.idsToDelete.length} session(s).`);
      hideDeleteModal();
      if (state.selectMode) exitSelectMode();
      await loadSessions();
      await loadStats();
    } catch (e) {
      console.error("[Admin] Delete failed:", e);
      showToast("Delete failed.", 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  // ── Print Handlers ────────────────────────────────────────────────────────────

  async function handlePrint(session) {
    if (!session.print_ready_url) { showToast("No print-ready file.", 'error'); return; }
    try {
      const printer = state.selectedPrinter;
      if (!printer) { showToast("Select a printer in the Hardware tab first.", 'error'); return; }
      
      showToast("Sending to printer...");
      
      const align = JSON.parse(localStorage.getItem('studrio_print_alignment') || '{}');
      
      const result = await window.electronAPI.printSilent({
        filePath: session.print_ready_url,
        printerName: printer,
        settings: {
          scale: align.scale || 100,
          offsetX: align.offsetX || 0,
          offsetY: align.offsetY || 0
        }
      });
      
      if (result.success) showToast("Print successful!");
      else showToast(`Print failed: ${result.error}`, 'error');
    } catch (e) {
      showToast(`Print error: ${e.message}`, 'error');
    }
  }

  async function handleDownload(session) {
    const url = session.print_ready_url || session.final_strip_url;
    if (!url) { showToast("No file to save.", 'error'); return; }
    window.open(url, '_blank');
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  async function loadStats() {
    try {
      const stats = await adminStorage.getStats();
      const stripsEl = document.getElementById("statStrips");
      const copiesEl = document.getElementById("statCopies");
      const storageEl = document.getElementById("statStorage");
      
      if (stripsEl) stripsEl.textContent = stats.photostripCount;
      if (copiesEl) copiesEl.textContent = stats.totalCopiesPrinted;
      if (storageEl) storageEl.textContent = formatBytes(stats.totalStorageBytes);
    } catch (e) {
      console.error("[Admin] Could not load stats:", e);
    }
  }

  function wireSignOut() {
    document.getElementById('btnSignOut')?.addEventListener('click', async () => {
      await adminStorage.getClient().auth.signOut();
      window.location.href = 'index.html';
    });
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
