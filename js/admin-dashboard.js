/*
 * ADMIN-DASHBOARD.JS — Control room dashboard logic.
 * Lives on its own page (admin/dashboard.html) now. The very first
 * thing this file does is check for a signed-in session and bounce to
 * index.html (the login page) if there isn't one — see guardAndInit()
 * at the bottom. Everything else below only runs once that's passed.
 */

(function () {
  const els = {
    dashboard: document.getElementById("adminDashboard"),
    refreshBtn: document.getElementById("btnRefresh"),
    logoutBtn: document.getElementById("btnLogout"),

    statStrips: document.getElementById("statStrips"),
    statPrints: document.getElementById("statPrints"),
    statStorage: document.getElementById("statStorage"),

    galleryStatus: document.getElementById("galleryStatus"),
    galleryEmpty: document.getElementById("galleryEmpty"),
    sessionCount: document.getElementById("sessionCount"),
    grid: document.getElementById("filmstripGrid"),
    dateFilterRow: document.getElementById("dateFilterRow"),

    selectModeBtn: document.getElementById("btnSelectMode"),
    selectBulkBar: document.getElementById("selectBulkBar"),
    selectBulkCount: document.getElementById("selectBulkCount"),
    selectCancelBtn: document.getElementById("btnSelectCancel"),
    bulkDeleteBtn: document.getElementById("btnBulkDelete"),

    deleteModal: document.getElementById("deleteModal"),
    deleteModalMessage: document.getElementById("deleteModalMessage"),
    cancelDeleteBtn: document.getElementById("btnCancelDelete"),
    confirmDeleteBtn: document.getElementById("btnConfirmDelete"),

    toast: document.getElementById("adminToast")
  };

  const DEFAULT_DELETE_MSG = "Delete this session and all its photos/videos? This can't be undone.";

  /* ---- Printer Setup: talks to the local print-agent (print-agent/) to
     list real CUPS printers, show whether the agent is reachable, and save
     which printer the kiosk should target. ---- */
  const printerEls = {
    status: document.getElementById("agentStatus"),
    statusDot: document.getElementById("agentStatusDot"),
    statusText: document.getElementById("agentStatusText"),
    select: document.getElementById("printerSelect"),
    saveBtn: document.getElementById("btnSavePrinter"),
    savedMsg: document.getElementById("printerSavedMsg"),
    openCupsBtn: document.getElementById("btnOpenCups")
  };

  function setAgentOnlineUI(isOnline) {
    printerEls.status.classList.toggle("is-online", isOnline);
    printerEls.status.classList.toggle("is-offline", !isOnline);
    printerEls.select.disabled = !isOnline;
    printerEls.saveBtn.disabled = !isOnline;
    testPrintBtn.disabled = !isOnline;
  }

  async function refreshPrinterSetup() {
    const health = await printAlignment.checkAgentHealth();
    if (!health.online) {
      printerEls.statusText.textContent = "Agent offline";
      setAgentOnlineUI(false);
      printerEls.select.innerHTML = '<option value="">— Agent offline —</option>';
      return;
    }
    printerEls.statusText.textContent = "Agent connected";
    setAgentOnlineUI(true);

    try {
      const { printers, configured, cupsDefault } = await printAlignment.listPrinters();
      if (!printers.length) {
        printerEls.select.innerHTML = '<option value="">— No printers found in CUPS —</option>';
        printerEls.select.disabled = true;
        printerEls.saveBtn.disabled = true;
        return;
      }
      const current = configured || cupsDefault || printers[0].name;
      printerEls.select.innerHTML = printers
        .map((p) => `<option value="${p.name}" ${p.name === current ? "selected" : ""}>${p.name}${p.isCupsDefault ? " (CUPS default)" : ""}</option>`)
        .join("");
    } catch (e) {
      console.error("[admin] Failed to list printers:", e);
      printerEls.select.innerHTML = '<option value="">— Couldn\'t load printers —</option>';
    }
  }

  printerEls.saveBtn.addEventListener("click", async () => {
    const name = printerEls.select.value;
    if (!name) return;
    printerEls.saveBtn.disabled = true;
    try {
      await printAlignment.setConfiguredPrinter(name);
      printerEls.savedMsg.hidden = false;
      clearTimeout(printerEls.saveBtn._t);
      printerEls.saveBtn._t = setTimeout(() => { printerEls.savedMsg.hidden = true; }, 2500);
    } catch (e) {
      console.error("[admin] Failed to save printer:", e);
      showToast("Couldn't save printer — check the agent and try again.");
    } finally {
      printerEls.saveBtn.disabled = false;
    }
  });

  printerEls.openCupsBtn.addEventListener("click", () => {
    window.open("http://localhost:631/printers", "_blank", "noopener");
  });

  /* ---- Printer Alignment (scale/offsetX/offsetY). Storage, defaults, and
     clamping all live in print-alignment.js so the kiosk print job and
     this page's Test Print (and now per-session Print Photo) stay in sync. ---- */
  const alignEls = {
    scale: document.getElementById("alignScale"),
    scaleValue: document.getElementById("alignScaleValue"),
    offsetX: document.getElementById("alignOffsetX"),
    offsetXValue: document.getElementById("alignOffsetXValue"),
    offsetY: document.getElementById("alignOffsetY"),
    offsetYValue: document.getElementById("alignOffsetYValue")
  };

  function applyPrefsToUI(prefs) {
    alignEls.scale.value = prefs.scale;
    alignEls.scaleValue.textContent = `${prefs.scale}%`;
    alignEls.offsetX.value = prefs.offsetX;
    alignEls.offsetXValue.textContent = prefs.offsetX;
    alignEls.offsetY.value = prefs.offsetY;
    alignEls.offsetYValue.textContent = prefs.offsetY;
  }

  function readPrefsFromUI() {
    return printAlignment.sanitize({
      scale: alignEls.scale.value,
      offsetX: alignEls.offsetX.value,
      offsetY: alignEls.offsetY.value
    });
  }

  // Live-update the numeric readouts as the sliders move.
  alignEls.scale.addEventListener("input", () => {
    alignEls.scaleValue.textContent = `${alignEls.scale.value}%`;
  });
  alignEls.offsetX.addEventListener("input", () => {
    alignEls.offsetXValue.textContent = alignEls.offsetX.value;
  });
  alignEls.offsetY.addEventListener("input", () => {
    alignEls.offsetYValue.textContent = alignEls.offsetY.value;
  });

  const savePrefsBtn = document.getElementById("btnSavePrefs");
  const prefSavedMsg = document.getElementById("prefSavedMsg");

  savePrefsBtn.addEventListener("click", () => {
    printAlignment.savePrefs(readPrefsFromUI());
    prefSavedMsg.hidden = false;
    clearTimeout(savePrefsBtn._t);
    savePrefsBtn._t = setTimeout(() => { prefSavedMsg.hidden = true; }, 2500);
  });

  /* ---- Test Print: fires a real print job through the agent using the
     CURRENT slider values (not necessarily saved) against a generated
     alignment test pattern, so the operator can dial in a printer without
     needing a guest session or touching the camera. ---- */
  const testPrintBtn = document.getElementById("btnTestPrint");
  const testPrintMsg = document.getElementById("testPrintMsg");

  testPrintBtn.addEventListener("click", async () => {
    const prefs = readPrefsFromUI();
    testPrintBtn.disabled = true;
    testPrintMsg.hidden = false;

    let testUrl;
    try {
      testUrl = await printAlignment.renderTestPatternPNG();
      await printAlignment.sendPrintJob(testUrl, 1, prefs);
    } catch (e) {
      console.error("[admin] Test print failed:", e);
      showToast(`Test print failed: ${e.message}`);
    } finally {
      if (testUrl) URL.revokeObjectURL(testUrl);
      testPrintBtn.disabled = false;
      testPrintMsg.hidden = true;
    }
  });

  // Populate the UI on load
  applyPrefsToUI(printAlignment.loadPrefs());
  refreshPrinterSetup();

  /* =========================================================
   * SESSIONS: data, date filter, select mode, batch delete
   * ========================================================= */
  let allSessions = [];
  let activeDateKey = "all";
  let selectMode = false;
  let selectedIds = new Set();
  let pendingDeleteIds = [];

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { els.toast.hidden = true; }, 3500);
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 MB";
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
  }

  function formatDigits(value) {
    return String(value).padStart(3, "0").split("").join(" ");
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
      });
    } catch (e) {
      return iso;
    }
  }

  function dateKeyFor(iso) {
    try { return new Date(iso).toDateString(); } catch (e) { return "unknown"; }
  }

  function dateLabelFor(key) {
    if (key === "unknown") return "Unknown";
    const d = new Date(key);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  /* ---- Date filter tabs — built from the dates actually present in the
     loaded sessions, newest first, plus an "All" pill. Purely client-side:
     listAllSessions() already returns everything, so filtering is just
     narrowing the in-memory array, no extra query. ---- */
  function buildDateFilterTabs() {
    const keys = new Set();
    allSessions.forEach((s) => keys.add(dateKeyFor(s.created_at)));
    const sortedKeys = Array.from(keys).sort((a, b) => new Date(b) - new Date(a));

    if (!sortedKeys.length) {
      els.dateFilterRow.innerHTML = "";
      return;
    }
    if (!sortedKeys.includes(activeDateKey) && activeDateKey !== "all") {
      activeDateKey = "all";
    }

    const pills = [`<button class="date-filter-pill${activeDateKey === "all" ? " active" : ""}" data-date="all">All</button>`]
      .concat(sortedKeys.map((k) =>
        `<button class="date-filter-pill${activeDateKey === k ? " active" : ""}" data-date="${k}">${dateLabelFor(k)}</button>`
      ));
    els.dateFilterRow.innerHTML = pills.join("");

    els.dateFilterRow.querySelectorAll(".date-filter-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        activeDateKey = pill.dataset.date;
        buildDateFilterTabs();
        applyFilterAndRender();
      });
    });
  }

  function applyFilterAndRender() {
    const filtered = activeDateKey === "all"
      ? allSessions
      : allSessions.filter((s) => dateKeyFor(s.created_at) === activeDateKey);
    renderSessions(filtered);
  }

  /* ---- Select mode / batch delete ---- */
  function setSelectMode(on) {
    selectMode = on;
    els.grid.classList.toggle("select-mode", on);
    els.selectModeBtn.textContent = on ? "Cancel" : "Select";
    if (!on) {
      selectedIds.clear();
      els.grid.querySelectorAll(".filmstrip-card.is-selected").forEach((c) => c.classList.remove("is-selected"));
      els.grid.querySelectorAll("input[data-select-id]").forEach((cb) => { cb.checked = false; });
    }
    updateBulkBar();
  }

  function updateBulkBar() {
    const n = selectedIds.size;
    els.selectBulkBar.hidden = !(selectMode && n > 0);
    els.selectBulkCount.textContent = `${n} selected`;
  }

  els.selectModeBtn.addEventListener("click", () => setSelectMode(!selectMode));
  els.selectCancelBtn.addEventListener("click", () => setSelectMode(false));

  els.bulkDeleteBtn.addEventListener("click", () => {
    if (!selectedIds.size) return;
    pendingDeleteIds = Array.from(selectedIds);
    els.deleteModalMessage.textContent =
      `Delete ${pendingDeleteIds.length} selected session${pendingDeleteIds.length === 1 ? "" : "s"} and all their photos/videos? This can't be undone.`;
    els.deleteModal.hidden = false;
  });

  /* ---- Download (fetch-then-blob, same approach as gallery.js —
     forces an actual save instead of Chromium sometimes just
     navigating to the cross-origin Supabase URL) ---- */
  function downloadFile(url, filename, btn) {
    if (!url) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "…";
    fetch(url)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.blob(); })
      .then((blob) => {
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
        btn.disabled = false;
        btn.textContent = original;
      })
      .catch((e) => {
        console.error("[admin] Download failed:", e);
        btn.disabled = false;
        btn.textContent = original;
        showToast("Download failed — try again.");
      });
  }

  function videoFilename(session) {
    try {
      const u = new URL(session.final_strip_video_url);
      const ext = (u.pathname.split(".").pop() || "mp4").split("?")[0];
      return `${session.id}-strip-video.${ext}`;
    } catch (e) {
      return `${session.id}-strip-video.mp4`;
    }
  }

  /* ---- Print Photo: actually sends the print-ready PNG to the local
     print agent (same path as the kiosk's own auto-print and Test Print)
     using the currently SAVED alignment prefs — never a browser download,
     never a print dialog, matching the kiosk's no-browser-UI rule. ---- */
  async function printPhoto(session, btn) {
    if (!session.print_ready_url) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Printing…";
    try {
      await printAlignment.sendPrintJob(session.print_ready_url, 1, printAlignment.loadPrefs());
      showToast(`Sent #${session.id} to the printer.`);
    } catch (e) {
      console.error("[admin] Print failed:", e);
      showToast(`Print failed: ${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function renderStats(stats) {
    els.statStrips.textContent = formatDigits(stats.photostripCount);
    els.statPrints.textContent = formatDigits(stats.totalCopiesPrinted);
    els.statStorage.textContent = formatBytes(stats.totalStorageBytes);
  }

  function renderSessions(sessions) {
    els.sessionCount.textContent = sessions.length
      ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}`
      : "";

    if (!sessions.length) {
      els.galleryEmpty.hidden = false;
      els.grid.innerHTML = "";
      return;
    }
    els.galleryEmpty.hidden = true;

    els.grid.innerHTML = "";
    sessions.forEach((session) => {
      const card = document.createElement("div");
      card.className = "filmstrip-card";
      if (selectedIds.has(session.id)) card.classList.add("is-selected");

      const mediaHtml = session.final_strip_url
        ? `<img src="${session.final_strip_url}" alt="Strip ${session.id}">`
        : `<div class="filmstrip-media-empty">Still processing…</div>`;

      card.innerHTML = `
        <div class="filmstrip-select-box">
          <input type="checkbox" data-select-id="${session.id}" ${selectedIds.has(session.id) ? "checked" : ""}>
        </div>
        <div class="filmstrip-sprockets"></div>
        <div class="filmstrip-media">${mediaHtml}</div>
        <div class="filmstrip-sprockets"></div>
        <div class="filmstrip-info">
          <p class="filmstrip-id">#${session.id}</p>
          <p class="filmstrip-meta">${session.frame_type || "—"} · ${session.design || "—"}</p>
          <p class="filmstrip-meta">${formatDate(session.created_at)}</p>
        </div>
        <div class="filmstrip-actions">
          <button class="btn-admin btn-admin-primary" data-action="print" ${session.print_ready_url ? "" : "disabled"}>🖨 Print Photo</button>
          <div class="filmstrip-actions-row">
            <button class="btn-admin btn-admin-outline" data-action="download-photo" ${session.print_ready_url ? "" : "disabled"}>⬇ Photo (QR)</button>
            <button class="btn-admin btn-admin-outline" data-action="download-video" ${session.final_strip_video_url ? "" : "disabled"}>⬇ Video</button>
          </div>
          <button class="btn-admin btn-admin-ghost" data-action="delete">Delete</button>
        </div>
      `;

      const printBtn = card.querySelector('[data-action="print"]');
      if (session.print_ready_url) {
        printBtn.addEventListener("click", (e) => printPhoto(session, e.currentTarget));
      }

      // Downloads the print-ready PNG as-is — the kiosk's own export
      // pipeline already bakes a scannable QR into its top-right corner
      // (same file the print agent receives), so no compositing needed
      // here; this is just a plain download of that existing asset.
      const photoBtn = card.querySelector('[data-action="download-photo"]');
      if (session.print_ready_url) {
        photoBtn.addEventListener("click", (e) => downloadFile(session.print_ready_url, `${session.id}-strip-print-ready.png`, e.currentTarget));
      }

      const videoBtn = card.querySelector('[data-action="download-video"]');
      if (session.final_strip_video_url) {
        videoBtn.addEventListener("click", (e) => downloadFile(session.final_strip_video_url, videoFilename(session), e.currentTarget));
      }

      card.querySelector('[data-action="delete"]').addEventListener("click", () => {
        pendingDeleteIds = [session.id];
        els.deleteModalMessage.textContent = DEFAULT_DELETE_MSG;
        els.deleteModal.hidden = false;
      });

      const checkbox = card.querySelector("input[data-select-id]");
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedIds.add(session.id); else selectedIds.delete(session.id);
        card.classList.toggle("is-selected", checkbox.checked);
        updateBulkBar();
      });

      els.grid.appendChild(card);
    });
  }

  async function loadDashboard() {
    els.galleryStatus.hidden = false;
    els.galleryStatus.textContent = "Loading sessions…";
    els.galleryEmpty.hidden = true;
    els.grid.innerHTML = "";

    try {
      const [stats, sessions] = await Promise.all([
        adminStorage.getStats(),
        adminStorage.listAllSessions()
      ]);
      renderStats(stats);
      allSessions = sessions;
      buildDateFilterTabs();
      applyFilterAndRender();
      els.galleryStatus.hidden = true;
    } catch (e) {
      console.error("[admin] Failed to load dashboard:", e);
      els.galleryStatus.textContent = "Couldn't load sessions. Check your connection and try Refresh.";
    }
  }

  els.refreshBtn.addEventListener("click", () => loadDashboard());

  els.logoutBtn.addEventListener("click", async () => {
    await adminStorage.signOut();
    window.location.href = "index.html";
  });

  /* ---- Delete modal wiring — shared by single-card delete and the
     batch delete bar; pendingDeleteIds holds one id or many. ---- */
  els.cancelDeleteBtn.addEventListener("click", () => {
    pendingDeleteIds = [];
    els.deleteModal.hidden = true;
  });

  els.confirmDeleteBtn.addEventListener("click", async () => {
    if (!pendingDeleteIds.length) return;
    const ids = pendingDeleteIds;
    els.confirmDeleteBtn.disabled = true;
    els.confirmDeleteBtn.textContent = "Deleting…";

    let failed = 0;
    for (const id of ids) {
      try {
        await adminStorage.deleteSession(id);
      } catch (e) {
        console.error("[admin] Delete failed:", id, e);
        failed++;
      }
    }

    els.deleteModal.hidden = true;
    pendingDeleteIds = [];
    els.confirmDeleteBtn.disabled = false;
    els.confirmDeleteBtn.textContent = "Delete";

    if (failed) {
      showToast(`Deleted ${ids.length - failed} of ${ids.length} — ${failed} failed.`);
    } else {
      showToast(ids.length === 1 ? `Session #${ids[0]} deleted.` : `${ids.length} sessions deleted.`);
    }

    setSelectMode(false);
    await loadDashboard();
  });

  /* ---- Route guard: this page assumes a signed-in session. If there
     isn't one (direct nav, expired session, logged out in another tab),
     bounce to the login page instead of rendering an empty dashboard. ---- */
  (async function guardAndInit() {
    try {
      const user = await adminStorage.getCurrentUser();
      if (!user) {
        window.location.href = "index.html";
        return;
      }
      await loadDashboard();
    } catch (e) {
      window.location.href = "index.html";
    }
  })();
})();
