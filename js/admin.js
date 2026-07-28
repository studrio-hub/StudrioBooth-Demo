/*
 * ADMIN.JS — Control room dashboard logic.
 * Gates everything behind Supabase Auth (see supabase-admin-setup.sql
 * for the RLS policies that make listing/deleting only work once
 * signed in). Refresh-on-demand, not live-subscribed — matches what
 * was actually asked for, keeps this simple.
 */

(function () {
  const els = {
    loginScreen: document.getElementById("adminLogin"),
    loginForm: document.getElementById("loginForm"),
    loginEmail: document.getElementById("loginEmail"),
    loginPassword: document.getElementById("loginPassword"),
    loginSubmitBtn: document.getElementById("loginSubmitBtn"),
    loginError: document.getElementById("loginError"),

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

    deleteModal: document.getElementById("deleteModal"),
    cancelDeleteBtn: document.getElementById("btnCancelDelete"),
    confirmDeleteBtn: document.getElementById("btnConfirmDelete"),

    toast: document.getElementById("adminToast")
  };

  /* ---- Printer preferences: system dialog toggle (admin-only — never
     exposed in the kiosk UI) + Printer Alignment (scale/offsetX/offsetY).
     Storage, defaults, and clamping all live in print-alignment.js so the
     kiosk print job and this page's Test Print stay perfectly in sync. ---- */
  const alignEls = {
    systemDialog: document.getElementById("prefSystemDialog"),
    scale: document.getElementById("alignScale"),
    scaleValue: document.getElementById("alignScaleValue"),
    offsetX: document.getElementById("alignOffsetX"),
    offsetXValue: document.getElementById("alignOffsetXValue"),
    offsetY: document.getElementById("alignOffsetY"),
    offsetYValue: document.getElementById("alignOffsetYValue")
  };

  function applyPrefsToUI(prefs) {
    alignEls.systemDialog.checked = !!prefs.systemDialog;
    alignEls.scale.value = prefs.scale;
    alignEls.scaleValue.textContent = `${prefs.scale}%`;
    alignEls.offsetX.value = prefs.offsetX;
    alignEls.offsetXValue.textContent = prefs.offsetX;
    alignEls.offsetY.value = prefs.offsetY;
    alignEls.offsetYValue.textContent = prefs.offsetY;
  }

  function readPrefsFromUI() {
    return printAlignment.sanitize({
      systemDialog: alignEls.systemDialog.checked,
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

  /* ---- Test Print: fires a real print job using the CURRENT slider
     values (not necessarily saved) against a generated alignment test
     pattern, so the operator can dial in a printer without needing a
     guest session or touching the camera. ---- */
  const testPrintBtn = document.getElementById("btnTestPrint");
  const testPrintMsg = document.getElementById("testPrintMsg");

  testPrintBtn.addEventListener("click", async () => {
    const prefs = readPrefsFromUI();
    testPrintBtn.disabled = true;
    testPrintMsg.hidden = false;

    let testUrl;
    try {
      testUrl = await printAlignment.renderTestPatternPNG();
      printAlignment.openPrintWindow(testUrl, 1, prefs, () => {
        URL.revokeObjectURL(testUrl);
        testPrintBtn.disabled = false;
        testPrintMsg.hidden = true;
      });
    } catch (e) {
      console.error("[admin] Test print failed:", e);
      if (testUrl) URL.revokeObjectURL(testUrl);
      testPrintBtn.disabled = false;
      testPrintMsg.hidden = true;
      showToast("Test print failed — try again.");
    }
  });

  // Populate the UI on load
  applyPrefsToUI(printAlignment.loadPrefs());

  let pendingDeleteId = null;

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

      const mediaHtml = session.final_strip_url
        ? `<img src="${session.final_strip_url}" alt="Strip ${session.id}">`
        : `<div class="filmstrip-media-empty">Still processing…</div>`;

      card.innerHTML = `
        <div class="filmstrip-sprockets"></div>
        <div class="filmstrip-media">${mediaHtml}</div>
        <div class="filmstrip-sprockets"></div>
        <div class="filmstrip-info">
          <p class="filmstrip-id">#${session.id}</p>
          <p class="filmstrip-meta">${session.frame_type || "—"} · ${session.design || "—"}</p>
          <p class="filmstrip-meta">${formatDate(session.created_at)}</p>
        </div>
        <div class="filmstrip-actions">
          <button class="btn-admin btn-admin-primary" data-action="reprint" ${session.print_ready_url ? "" : "disabled"}>🖨 Reprint Copy</button>
          <div class="filmstrip-actions-row">
            <button class="btn-admin btn-admin-outline" data-action="download">⬇ Save</button>
            <button class="btn-admin btn-admin-ghost" data-action="delete">Delete</button>
          </div>
        </div>
      `;

      card.querySelector('[data-action="download"]').addEventListener("click", (e) => {
        downloadFile(session.final_strip_url, `${session.id}-strip.png`, e.currentTarget);
      });
      const reprintBtn = card.querySelector('[data-action="reprint"]');
      if (session.print_ready_url) {
        reprintBtn.addEventListener("click", () => {
          downloadFile(session.print_ready_url, `${session.id}-strip-print-ready.png`, reprintBtn);
        });
      }
      card.querySelector('[data-action="delete"]').addEventListener("click", () => {
        pendingDeleteId = session.id;
        els.deleteModal.hidden = false;
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
      renderSessions(sessions);
      els.galleryStatus.hidden = true;
    } catch (e) {
      console.error("[admin] Failed to load dashboard:", e);
      els.galleryStatus.textContent = "Couldn't load sessions. Check your connection and try Refresh.";
    }
  }

  async function showDashboard() {
    els.loginScreen.hidden = true;
    els.dashboard.hidden = false;
    await loadDashboard();
  }

  function showLogin() {
    els.dashboard.hidden = true;
    els.loginScreen.hidden = false;
  }

  /* ---- Auth wiring ---- */
  els.loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.loginError.hidden = true;
    els.loginSubmitBtn.disabled = true;
    els.loginSubmitBtn.textContent = "Signing in…";

    try {
      await adminStorage.signIn(els.loginEmail.value.trim(), els.loginPassword.value);
      await showDashboard();
    } catch (err) {
      els.loginError.textContent = "Sign-in failed — check your email and password.";
      els.loginError.hidden = false;
    } finally {
      els.loginSubmitBtn.disabled = false;
      els.loginSubmitBtn.textContent = "Sign in";
    }
  });

  els.logoutBtn.addEventListener("click", async () => {
    await adminStorage.signOut();
    showLogin();
  });

  els.refreshBtn.addEventListener("click", () => loadDashboard());

  /* ---- Delete modal wiring ---- */
  els.cancelDeleteBtn.addEventListener("click", () => {
    pendingDeleteId = null;
    els.deleteModal.hidden = true;
  });

  els.confirmDeleteBtn.addEventListener("click", async () => {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    els.confirmDeleteBtn.disabled = true;
    els.confirmDeleteBtn.textContent = "Deleting…";

    try {
      await adminStorage.deleteSession(id);
      showToast(`Session #${id} deleted.`);
      els.deleteModal.hidden = true;
      await loadDashboard();
    } catch (e) {
      console.error("[admin] Delete failed:", e);
      showToast("Couldn't delete that session — try again.");
    } finally {
      pendingDeleteId = null;
      els.confirmDeleteBtn.disabled = false;
      els.confirmDeleteBtn.textContent = "Delete";
    }
  });

  /* ---- Boot: check for an existing signed-in session ---- */
  (async function init() {
    try {
      const user = await adminStorage.getCurrentUser();
      if (user) {
        await showDashboard();
      } else {
        showLogin();
      }
    } catch (e) {
      showLogin();
    }
  })();
})();
