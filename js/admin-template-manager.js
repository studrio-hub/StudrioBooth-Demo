/*
 * ADMIN-TEMPLATE-MANAGER.JS
 * ─────────────────────────────────────────────────────────────────────────────
 * Template Manager tab on the admin dashboard.
 * Depends on: cloud-storage.js (adminStorage + adminTemplates), admin.css
 *
 * What it does:
 *   • Lists all templates from the Supabase `templates` table
 *   • Upload new frame template + thumbnail (both for 2x6 and/or 4x6)
 *   • Enable / disable templates (kiosk skips disabled ones during sync)
 *   • Rename templates (updates `name` column)
 *   • Reorder templates by drag-handle or up/down buttons (updates `sort_order`)
 *   • Delete templates (removes Supabase Storage files + table row)
 *
 * This module is self-contained — it owns its DOM section and wires
 * everything up internally. admin-dashboard.js calls templateManager.init()
 * once after auth is confirmed.
 *
 * IMPORTANT — Storage RLS requirement:
 *   Uploading needs INSERT (and UPDATE, since uploads use upsert:true)
 *   policies on storage.objects scoped to the `templates/` path for the
 *   authenticated role. If your bucket only has a session-scoped INSERT
 *   policy, uploads will fail with an RLS violation — see
 *   supabase-storage-templates-policy-patch.sql.
 */

const templateManager = (() => {

  // ── DOM refs ────────────────────────────────────────────────────────────────
  // These are all inside #templateSection, injected into dashboard.html.
  const sel = (id) => document.getElementById(id);

  let _containerEl   = null; // #templateGrid — card grid
  let _statusEl      = null; // #templateStatus — loading/empty message
  let _toast         = null; // shared with admin-dashboard.js

  let _templates     = [];
  let _dragSrcIndex  = null; // for drag-and-drop reordering

  // ── Toast (reuse admin-dashboard's toast element) ───────────────────────────

  function showToast(message) {
    if (!_toast) _toast = document.getElementById("adminToast");
    if (!_toast) {
      // No toast element found — fall back to an alert so the message is
      // never silently lost (this should not normally happen).
      console.warn("[templateManager] No toast element found — falling back to alert()");
      alert(message);
      return;
    }
    _toast.textContent = message;
    _toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { _toast.hidden = true; }, 3500);
  }

  // ── Template card renderer ──────────────────────────────────────────────────

  function renderTemplateList(templates) {
    _containerEl.innerHTML = "";

    if (!templates.length) {
      _statusEl.hidden = false;
      _statusEl.textContent = "No templates yet. Click \"Upload Template\" to add one.";
      return;
    }
    _statusEl.hidden = true;

    templates.forEach((t, index) => {
      const card = document.createElement("div");
      card.className = "template-card" + (t.enabled ? "" : " template-card--disabled");
      card.dataset.id = t.id;
      card.draggable = true;

      const thumbHtml = t.thumbnail_url
        ? `<img class="template-thumb" src="${t.thumbnail_url}" alt="${t.name}">`
        : `<div class="template-thumb template-thumb--empty"><span>No thumbnail</span></div>`;

      const frameTypes = [];
      if (t.overlay_path_2x6) frameTypes.push("2×6");
      if (t.overlay_path_4x6) frameTypes.push("4×6");
      const frameLabel = frameTypes.length ? frameTypes.join(" · ") : "—";

      card.innerHTML = `
        <div class="template-card-drag-handle" title="Drag to reorder">⠿</div>
        <div class="template-card-thumb">${thumbHtml}</div>
        <div class="template-card-body">
          <p class="template-card-name" data-field="name">${escapeHtml(t.name)}</p>
          <p class="template-card-meta">${escapeHtml(frameLabel)} · v${t.version || 1}</p>
          <p class="template-card-type">${escapeHtml(t.asset_type || "frame_template")}</p>
        </div>
        <div class="template-card-actions">
          <button class="btn-admin btn-admin-outline btn-sm" data-action="rename">Rename</button>
          <button class="btn-admin btn-admin-outline btn-sm" data-action="toggle">
            ${t.enabled ? "Disable" : "Enable"}
          </button>
          <button class="btn-admin btn-admin-ghost btn-sm" data-action="delete">Delete</button>
        </div>
        <div class="template-card-order">
          <button class="btn-order" data-action="move-up" ${index === 0 ? "disabled" : ""}>▲</button>
          <button class="btn-order" data-action="move-down" ${index === templates.length - 1 ? "disabled" : ""}>▼</button>
        </div>
      `;

      // ── Rename ──────────────────────────────────────────────────────────────
      card.querySelector('[data-action="rename"]').addEventListener("click", () => {
        const nameEl = card.querySelector('[data-field="name"]');
        const current = nameEl.textContent;
        const input = document.createElement("input");
        input.type = "text";
        input.value = current;
        input.className = "template-name-input";
        nameEl.replaceWith(input);
        input.focus();
        input.select();

        const commit = async () => {
          const newName = input.value.trim();
          input.replaceWith(nameEl);
          if (!newName || newName === current) return;
          nameEl.textContent = newName;
          try {
            await adminTemplates.updateTemplate(t.id, { name: newName });
            t.name = newName;
            showToast(`Renamed to "${newName}".`);
          } catch (e) {
            nameEl.textContent = current;
            showToast(`Rename failed: ${e.message}`);
          }
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { input.blur(); }
          if (ev.key === "Escape") { input.value = current; input.blur(); }
        });
      });

      // ── Enable / Disable ────────────────────────────────────────────────────
      card.querySelector('[data-action="toggle"]').addEventListener("click", async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        try {
          const newEnabled = !t.enabled;
          await adminTemplates.updateTemplate(t.id, { enabled: newEnabled });
          t.enabled = newEnabled;
          card.classList.toggle("template-card--disabled", !newEnabled);
          btn.textContent = newEnabled ? "Disable" : "Enable";
          showToast(`Template "${t.name}" ${newEnabled ? "enabled" : "disabled"}.`);
        } catch (e) {
          showToast(`Toggle failed: ${e.message}`);
        } finally {
          btn.disabled = false;
        }
      });

      // ── Delete ──────────────────────────────────────────────────────────────
      card.querySelector('[data-action="delete"]').addEventListener("click", () => {
        showDeleteModal(t);
      });

      // ── Move Up / Down ──────────────────────────────────────────────────────
      card.querySelector('[data-action="move-up"]').addEventListener("click", async () => {
        if (index === 0) return;
        await swapOrder(index, index - 1);
      });
      card.querySelector('[data-action="move-down"]').addEventListener("click", async () => {
        if (index === templates.length - 1) return;
        await swapOrder(index, index + 1);
      });

      // ── Drag-and-drop reordering ────────────────────────────────────────────
      card.addEventListener("dragstart", (ev) => {
        _dragSrcIndex = index;
        ev.dataTransfer.effectAllowed = "move";
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", () => { card.classList.remove("dragging"); });
      card.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        card.classList.add("drag-over");
      });
      card.addEventListener("dragleave", () => { card.classList.remove("drag-over"); });
      card.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        card.classList.remove("drag-over");
        const targetIndex = index;
        if (_dragSrcIndex === null || _dragSrcIndex === targetIndex) return;
        await moveToIndex(_dragSrcIndex, targetIndex);
        _dragSrcIndex = null;
      });

      _containerEl.appendChild(card);
    });
  }

  // ── Reorder helpers ─────────────────────────────────────────────────────────

  async function swapOrder(indexA, indexB) {
    const copy = [..._templates];
    [copy[indexA], copy[indexB]] = [copy[indexB], copy[indexA]];
    await saveOrder(copy);
  }

  async function moveToIndex(fromIndex, toIndex) {
    const copy = [..._templates];
    const [item] = copy.splice(fromIndex, 1);
    copy.splice(toIndex, 0, item);
    await saveOrder(copy);
  }

  async function saveOrder(newOrder) {
    // Optimistic UI update
    _templates = newOrder;
    renderTemplateList(_templates);

    // Persist: update each template's sort_order to its new array index
    try {
      await adminTemplates.reorderTemplates(newOrder.map((t) => t.id));
      showToast("Order saved.");
    } catch (e) {
      showToast(`Reorder failed: ${e.message}`);
      // Reload from server to recover consistent state
      await loadTemplates();
    }
  }

  // ── Delete modal ────────────────────────────────────────────────────────────

  let _pendingDeleteId = null;

  function showDeleteModal(template) {
    _pendingDeleteId = template.id;
    const modal = sel("templateDeleteModal");
    const msg   = sel("templateDeleteMessage");
    if (msg) msg.textContent = `Delete template "${template.name}"? This removes the frame file(s) and thumbnail from Supabase and cannot be undone.`;
    if (modal) modal.hidden = false;
  }

  function wireDeleteModal() {
    const modal      = sel("templateDeleteModal");
    const cancelBtn  = sel("btnTemplateDeleteCancel");
    const confirmBtn = sel("btnTemplateDeleteConfirm");

    if (!modal || !cancelBtn || !confirmBtn) {
      console.error("[templateManager] wireDeleteModal: missing element(s)", {
        modal: !!modal, cancelBtn: !!cancelBtn, confirmBtn: !!confirmBtn
      });
      return;
    }

    cancelBtn.addEventListener("click", () => {
      _pendingDeleteId = null;
      modal.hidden = true;
    });
    confirmBtn.addEventListener("click", async () => {
      if (!_pendingDeleteId) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Deleting…";
      try {
        await adminTemplates.deleteTemplate(_pendingDeleteId);
        showToast("Template deleted.");
        modal.hidden = true;
        _pendingDeleteId = null;
        await loadTemplates();
      } catch (e) {
        showToast(`Delete failed: ${e.message}`);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Delete";
      }
    });
  }

  // ── Upload modal ────────────────────────────────────────────────────────────

  function wireUploadModal() {
    const openBtn    = sel("btnUploadTemplate");
    const modal      = sel("templateUploadModal");
    const cancelBtn  = sel("btnTemplateUploadCancel");
    const submitBtn  = sel("btnTemplateUploadSubmit");
    const progressEl = sel("templateUploadProgress");

    // Defensive check — if dashboard.html and this file ever drift out of
    // sync (e.g. a stale cached copy of one but not the other), fail LOUDLY
    // in the console instead of the button just doing nothing.
    if (!openBtn || !modal || !cancelBtn || !submitBtn) {
      console.error("[templateManager] wireUploadModal: missing required element(s) — the upload button will not work.", {
        openBtn: !!openBtn, modal: !!modal, cancelBtn: !!cancelBtn, submitBtn: !!submitBtn
      });
      return;
    }

    openBtn.addEventListener("click", () => {
      console.log("[templateManager] Upload Template button clicked — opening modal.");
      const nameEl = sel("templateName");
      const typeEl = sel("templateAssetType");
      const f2El   = sel("templateFile2x6");
      const f4El   = sel("templateFile4x6");
      const thEl   = sel("templateThumb");
      if (nameEl) nameEl.value = "";
      if (typeEl) typeEl.value = "frame_template";
      if (f2El)   f2El.value = "";
      if (f4El)   f4El.value = "";
      if (thEl)   thEl.value = "";
      if (progressEl) { progressEl.textContent = ""; progressEl.hidden = true; }
      modal.hidden = false;
    });

    cancelBtn.addEventListener("click", () => { modal.hidden = true; });

    submitBtn.addEventListener("click", async () => {
      console.log("[templateManager] Upload submit clicked.");

      let name, assetType, file2x6, file4x6, thumbFile;
      try {
        const nameEl = sel("templateName");
        const typeEl = sel("templateAssetType");
        const f2El   = sel("templateFile2x6");
        const f4El   = sel("templateFile4x6");
        const thEl   = sel("templateThumb");

        if (!nameEl || !typeEl || !f2El || !f4El) {
          throw new Error("Upload form fields not found in the page — try a hard refresh (Ctrl+Shift+R).");
        }

        name      = nameEl.value.trim();
        assetType = typeEl.value;
        file2x6   = f2El.files[0] || null;
        file4x6   = f4El.files[0] || null;
        thumbFile = thEl ? (thEl.files[0] || null) : null;
      } catch (e) {
        // Reading form values failed — surface it instead of dying silently.
        console.error("[templateManager] Could not read upload form:", e);
        showToast(`Could not read upload form: ${e.message}`);
        return;
      }

      if (!name) { showToast("Please enter a template name."); return; }
      if (!file2x6 && !file4x6) { showToast("Upload at least one frame file (2×6 or 4×6)."); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = "Uploading…";
      if (progressEl) { progressEl.hidden = false; progressEl.textContent = "Uploading files…"; }

      try {
        await adminTemplates.uploadTemplate({ name, assetType, file2x6, file4x6, thumbFile });
        modal.hidden = true;
        showToast(`Template "${name}" uploaded.`);
        await loadTemplates();
      } catch (e) {
        console.error("[templateManager] Upload failed:", e);
        // Row Level Security violations land here — if you see
        // "new row violates row-level security policy" or similar, run
        // supabase-storage-templates-policy-patch.sql in the Supabase SQL
        // editor to add the missing templates/ path INSERT/UPDATE policies.
        showToast(`Upload failed: ${e.message}`);
        if (progressEl) progressEl.textContent = `Error: ${e.message}`;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Upload";
      }
    });
  }

  // ── Load ────────────────────────────────────────────────────────────────────

  async function loadTemplates() {
    _statusEl.hidden = false;
    _statusEl.textContent = "Loading templates…";
    _containerEl.innerHTML = "";
    try {
      _templates = await adminTemplates.listTemplates();
      renderTemplateList(_templates);
    } catch (e) {
      console.error("[templateManager] loadTemplates failed:", e);
      _statusEl.hidden = false;
      _statusEl.textContent = `Could not load templates: ${e.message}`;
    }
  }

  // ── HTML injection (injects the tab HTML into dashboard.html) ───────────────

  function injectHTML() {
    const target = document.getElementById("templateSection");
    if (!target) {
      console.error("[templateManager] #templateSection not found in the page — dashboard.html may be out of date.");
      return;
    }

    target.innerHTML = `
      <!-- ── Template Manager ─────────────────────────────────────────── -->
      <div class="gallery-section-head">
        <div class="gallery-section-head-left">
          <h2>Template Manager</h2>
          <p class="gallery-count" id="templateCount"></p>
        </div>
        <button class="btn-admin btn-admin-primary" id="btnUploadTemplate" type="button">+ Upload Template</button>
      </div>

      <p class="admin-status" id="templateStatus">Loading templates…</p>
      <div class="template-grid" id="templateGrid"></div>

      <!-- Delete confirmation modal -->
      <div class="admin-modal-overlay" id="templateDeleteModal" hidden>
        <div class="admin-modal-box">
          <p class="admin-modal-message" id="templateDeleteMessage">
            Delete this template? This cannot be undone.
          </p>
          <div class="admin-modal-actions">
            <button class="btn-admin btn-admin-outline" id="btnTemplateDeleteCancel" type="button">Cancel</button>
            <button class="btn-admin btn-admin-danger" id="btnTemplateDeleteConfirm" type="button">Delete</button>
          </div>
        </div>
      </div>

      <!-- Upload modal -->
      <div class="admin-modal-overlay" id="templateUploadModal" hidden>
        <div class="admin-modal-box admin-modal-box--wide">
          <h3 class="admin-modal-title">Upload Template</h3>

          <div id="templateUploadForm" class="template-upload-form">

            <div class="form-field">
              <label for="templateName">Template name</label>
              <input type="text" id="templateName" placeholder="e.g. Coastal Cool" maxlength="80">
            </div>

            <div class="form-field">
              <label for="templateAssetType">Asset type</label>
              <select id="templateAssetType">
                <option value="frame_template">Frame Template</option>
                <option value="sticker">Sticker</option>
                <option value="background">Background</option>
                <option value="gif_video">GIF / Video</option>
                <option value="logo">Logo</option>
              </select>
            </div>

            <div class="form-field">
              <label for="templateFile2x6">Frame PNG — 2×6 (Long Frame)</label>
              <input type="file" id="templateFile2x6" accept=".png,image/png">
              <p class="form-hint">Full-size overlay PNG at 2400×3600px, 600dpi. Leave blank if this design is 4×6 only.</p>
            </div>

            <div class="form-field">
              <label for="templateFile4x6">Frame PNG — 4×6 (Wide Frame)</label>
              <input type="file" id="templateFile4x6" accept=".png,image/png">
              <p class="form-hint">Leave blank if this design is 2×6 only.</p>
            </div>

            <div class="form-field">
              <label for="templateThumb">Thumbnail (optional)</label>
              <input type="file" id="templateThumb" accept=".png,.jpg,.jpeg,image/png,image/jpeg">
              <p class="form-hint">Small preview shown in the design picker. If omitted, the kiosk composites a thumbnail from the frame file.</p>
            </div>

            <p class="template-upload-progress" id="templateUploadProgress" hidden></p>
          </div>

          <div class="admin-modal-actions">
            <button class="btn-admin btn-admin-outline" id="btnTemplateUploadCancel" type="button">Cancel</button>
            <button class="btn-admin btn-admin-primary" id="btnTemplateUploadSubmit" type="button">Upload</button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Utility ─────────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  return {
    async init() {
      injectHTML();
      _containerEl = document.getElementById("templateGrid");
      _statusEl    = document.getElementById("templateStatus");
      if (!_containerEl || !_statusEl) {
        console.error("[templateManager] init: #templateGrid or #templateStatus missing after injectHTML — aborting init.");
        return;
      }
      wireUploadModal();
      wireDeleteModal();
      await loadTemplates();
    },

    async refresh() {
      await loadTemplates();
    }
  };
})();
