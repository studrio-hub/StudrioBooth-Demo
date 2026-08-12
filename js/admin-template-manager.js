/*
 * ADMIN-TEMPLATE-MANAGER.JS
 * ─────────────────────────────────────────────────────────────────────────────
 * Template Manager tab on the admin dashboard.
 * Depends on: cloud-storage.js (adminStorage + adminTemplates), admin.css
 *
 * What it does:
 *   • Lists all templates from the Supabase `templates` table
 *   • Upload new frame template + thumbnail (both for 2x6 and/or 4x6)
 *   • Edit existing templates — replace 2×6 / 4×6 overlays or thumbnail,
 *     update name and asset type (bumps version so kiosks re-download)
 *   • Enable / disable templates (kiosk skips disabled ones during sync)
 *   • Rename templates (updates `name` column)
 *   • Reorder templates by drag-handle or up/down buttons (updates `sort_order`)
 *   • Delete templates (removes Supabase Storage files + table row)
 *   • Sync Templates button — triggers the kiosk's local server to re-pull
 *     the latest templates immediately, without waiting for the 3-min poll
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
 *
 * SYNC BUTTON BEHAVIOR:
 *   The kiosk's local server (localhost:3000) exposes a POST endpoint at
 *   /sync/trigger that calls assetSync.forceRefresh() on the running kiosk.
 *   Because Admin runs on studrio.cc and the kiosk is on localhost, the
 *   button POSTs to that endpoint and reports success/failure. If the kiosk
 *   is offline (or the local server isn't running), the button still refreshes
 *   the admin's own template list and shows a clear offline notice.
 *   Templates always auto-sync on the kiosk every 3 minutes regardless.
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
  let _activeFormat  = "2x6"; // "2x6" | "4x6" — active template tab

  // ── Toast (reuse admin-dashboard's toast element) ───────────────────────────

  function showToast(message, duration = 3500) {
    if (!_toast) _toast = document.getElementById("adminToast");
    if (!_toast) {
      console.warn("[templateManager] No toast element found — falling back to alert()");
      alert(message);
      return;
    }
    _toast.textContent = message;
    _toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { _toast.hidden = true; }, duration);
  }

  // ── Template card renderer ──────────────────────────────────────────────────

  function renderTemplateList(templates) {
    _containerEl.innerHTML = "";

    // Filter to only show templates that have an overlay for the active format.
    // A template with both 2×6 and 4×6 overlays will appear in both tabs.
    const filtered = templates.filter((t) => {
      if (_activeFormat === "2x6") return !!t.overlay_path_2x6;
      if (_activeFormat === "4x6") return !!t.overlay_path_4x6;
      return true;
    });

    if (!filtered.length) {
      _statusEl.hidden = false;
      _statusEl.textContent = templates.length
        ? `No ${_activeFormat === "2x6" ? "2×6" : "4×6"} templates yet. Click "Upload Template" to add one.`
        : "No templates yet. Click \"Upload Template\" to add one.";
      return;
    }
    _statusEl.hidden = true;

    filtered.forEach((t, index) => {
      const card = document.createElement("div");
      card.className = "template-card" + (t.enabled ? "" : " template-card--disabled");
      card.dataset.id = t.id;
      card.draggable = true;

      // No thumbnail shown in cards (thumbnail upload removed)
      const frameTypes = [];
      if (t.overlay_path_2x6) frameTypes.push("2×6");
      if (t.overlay_path_4x6) frameTypes.push("4×6");
      const frameLabel = frameTypes.length ? frameTypes.join(" · ") : "—";

      card.innerHTML = `
        <div class="template-card-drag-handle" title="Drag to reorder">⠿</div>
        <div class="template-card-body">
          <p class="template-card-name" data-field="name">${escapeHtml(t.name)}</p>
          <p class="template-card-meta">${escapeHtml(frameLabel)} · v${t.version || 1}</p>
          <p class="template-card-type">${escapeHtml(t.asset_type || "frame_template")}</p>
        </div>
        <div class="template-card-actions">
          <button class="btn-admin btn-admin-outline btn-sm" data-action="edit">Edit</button>
          <button class="btn-admin btn-admin-outline btn-sm" data-action="rename">Rename</button>
          <button class="btn-admin btn-admin-outline btn-sm" data-action="toggle">
            ${t.enabled ? "Disable" : "Enable"}
          </button>
          <button class="btn-admin btn-admin-ghost btn-sm" data-action="delete">Delete</button>
        </div>
        <div class="template-card-order">
          <button class="btn-order" data-action="move-up" ${index === 0 ? "disabled" : ""}>▲</button>
          <button class="btn-order" data-action="move-down" ${index === filtered.length - 1 ? "disabled" : ""}>▼</button>
        </div>
      `;

      // ── Edit ────────────────────────────────────────────────────────────────
      card.querySelector('[data-action="edit"]').addEventListener("click", () => {
        showEditModal(t);
      });

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
      // Reorder within the filtered (tab-specific) list, then persist all IDs
      card.querySelector('[data-action="move-up"]').addEventListener("click", async () => {
        if (index === 0) return;
        await swapOrderFiltered(filtered, index, index - 1);
      });
      card.querySelector('[data-action="move-down"]').addEventListener("click", async () => {
        if (index === filtered.length - 1) return;
        await swapOrderFiltered(filtered, index, index + 1);
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
        await moveToIndexFiltered(filtered, _dragSrcIndex, targetIndex);
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

  /*
   * swapOrderFiltered — swaps two items within a filtered subset of _templates
   * and persists the full _templates array with updated sort_order values.
   */
  async function swapOrderFiltered(filtered, indexA, indexB) {
    // Swap within the filtered copy
    const filteredCopy = [...filtered];
    [filteredCopy[indexA], filteredCopy[indexB]] = [filteredCopy[indexB], filteredCopy[indexA]];

    // Rebuild full _templates list, replacing the filtered items in their
    // original slots while preserving items that are NOT in the filtered set.
    const filteredIds   = new Set(filtered.map((t) => t.id));
    const remaining     = _templates.filter((t) => !filteredIds.has(t.id));
    const reordered     = [...filteredCopy, ...remaining];
    await saveOrder(reordered);
  }

  async function moveToIndex(fromIndex, toIndex) {
    const copy = [..._templates];
    const [item] = copy.splice(fromIndex, 1);
    copy.splice(toIndex, 0, item);
    await saveOrder(copy);
  }

  async function moveToIndexFiltered(filtered, fromIndex, toIndex) {
    const filteredCopy = [...filtered];
    const [item] = filteredCopy.splice(fromIndex, 1);
    filteredCopy.splice(toIndex, 0, item);

    const filteredIds = new Set(filtered.map((t) => t.id));
    const remaining   = _templates.filter((t) => !filteredIds.has(t.id));
    const reordered   = [...filteredCopy, ...remaining];
    await saveOrder(reordered);
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

  // ── Edit modal ──────────────────────────────────────────────────────────────
  /*
   * Shows a modal pre-filled with the template's current values.
   * Each file input is optional — leaving it blank keeps the existing asset.
   * Saving any file field bumps the template's version so kiosks re-download.
   */

  let _editingTemplateId = null;

  function showEditModal(template) {
    _editingTemplateId = template.id;

    const modal = sel("templateEditModal");

    // Pre-fill name and type
    const nameEl = sel("editTemplateName");
    const typeEl = sel("editTemplateAssetType");
    if (nameEl) nameEl.value = template.name || "";
    if (typeEl) typeEl.value = template.asset_type || "frame_template";

    // Clear file inputs (they can't be pre-filled for security reasons)
    const f2El = sel("editTemplateFile2x6");
    const f4El = sel("editTemplateFile4x6");
    if (f2El) f2El.value = "";
    if (f4El) f4El.value = "";

    // Show what's currently set for each format
    const cur2x6El = sel("editCurrent2x6");
    const cur4x6El = sel("editCurrent4x6");
    if (cur2x6El) cur2x6El.textContent = template.overlay_path_2x6 ? "✓ Existing file" : "None";
    if (cur4x6El) cur4x6El.textContent = template.overlay_path_4x6 ? "✓ Existing file" : "None";

    // Show only the active format's file field
    const field2x6 = sel("editField2x6");
    const field4x6 = sel("editField4x6");
    if (field2x6) field2x6.style.display = _activeFormat === "2x6" ? "" : "none";
    if (field4x6) field4x6.style.display = _activeFormat === "4x6" ? "" : "none";

    // Reset progress/error state
    const progressEl = sel("editTemplateProgress");
    if (progressEl) { progressEl.textContent = ""; progressEl.hidden = true; }

    if (modal) modal.hidden = false;
  }

  function wireEditModal() {
    const modal      = sel("templateEditModal");
    const cancelBtn  = sel("btnTemplateEditCancel");
    const submitBtn  = sel("btnTemplateEditSubmit");
    const progressEl = sel("editTemplateProgress");

    if (!modal || !cancelBtn || !submitBtn) {
      console.error("[templateManager] wireEditModal: missing required element(s)", {
        modal: !!modal, cancelBtn: !!cancelBtn, submitBtn: !!submitBtn
      });
      return;
    }

    cancelBtn.addEventListener("click", () => {
      _editingTemplateId = null;
      modal.hidden = true;
    });

    submitBtn.addEventListener("click", async () => {
      if (!_editingTemplateId) return;

      const nameEl = sel("editTemplateName");
      const typeEl = sel("editTemplateAssetType");
      const f2El   = sel("editTemplateFile2x6");
      const f4El   = sel("editTemplateFile4x6");

      const newName     = nameEl ? nameEl.value.trim() : "";
      const newType     = typeEl ? typeEl.value : "";
      // Only update the file for the active format tab
      const newFile2x6  = (_activeFormat === "2x6" && f2El) ? (f2El.files[0] || null) : null;
      const newFile4x6  = (_activeFormat === "4x6" && f4El) ? (f4El.files[0] || null) : null;

      if (!newName) { showToast("Template name cannot be empty."); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
      if (progressEl) { progressEl.hidden = false; progressEl.textContent = "Saving…"; }

      try {
        // Fetch current template record so we know the slug/prefix for storage paths
        const current = _templates.find((t) => t.id === _editingTemplateId);
        if (!current) throw new Error("Template not found — try refreshing.");

        // Derive the storage prefix from the existing overlay path (keeps files together)
        let storagePrefix = null;
        if (current.overlay_path_2x6) {
          storagePrefix = current.overlay_path_2x6.replace(/\/overlay_2x6\.png$/, "");
        } else if (current.overlay_path_4x6) {
          storagePrefix = current.overlay_path_4x6.replace(/\/overlay_4x6\.png$/, "");
        } else if (current.thumbnail_path) {
          storagePrefix = current.thumbnail_path.replace(/\/thumbnail\.png$/, "");
        }

        // If no storage prefix can be derived (e.g. very old template), create one
        if (!storagePrefix) {
          const slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").substring(0, 48);
          storagePrefix = `templates/${slug}-${Date.now()}`;
        }

        const updates = { name: newName, asset_type: newType };

        // Upload any replacement files; upsert:true (authenticated) overwrites the existing path
        if (newFile2x6) {
          if (progressEl) progressEl.textContent = "Uploading 2×6 overlay…";
          updates.overlay_path_2x6 = await adminTemplates._uploadFile(
            newFile2x6, `${storagePrefix}/overlay_2x6.png`, "image/png"
          );
        }
        if (newFile4x6) {
          if (progressEl) progressEl.textContent = "Uploading 4×6 overlay…";
          updates.overlay_path_4x6 = await adminTemplates._uploadFile(
            newFile4x6, `${storagePrefix}/overlay_4x6.png`, "image/png"
          );
        }
        if (progressEl) progressEl.textContent = "Updating database…";
        await adminTemplates.updateTemplate(_editingTemplateId, updates);

        showToast(`Template "${newName}" updated.`);
        modal.hidden = true;
        _editingTemplateId = null;
        await loadTemplates();
      } catch (e) {
        console.error("[templateManager] Edit failed:", e);
        showToast(`Save failed: ${e.message}`);
        if (progressEl) progressEl.textContent = `Error: ${e.message}`;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Save";
      }
    });
  }

  // ── Format tabs (2×6 / 4×6) ────────────────────────────────────────────────

  function wireFormatTabs() {
    const tabsEl = document.getElementById("templateFormatTabs");
    if (!tabsEl) return;

    tabsEl.addEventListener("click", (ev) => {
      const tab = ev.target.closest(".template-format-tab");
      if (!tab) return;

      const format = tab.dataset.format;
      if (!format || format === _activeFormat) return;

      _activeFormat = format;

      // Update tab styles
      tabsEl.querySelectorAll(".template-format-tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.format === format);
      });

      // Re-render the template grid with the active format filter
      renderTemplateList(_templates);

      // Update count label
      const countEl = document.getElementById("templateCount");
      if (countEl) {
        const visible = _templates.filter((t) =>
          format === "2x6" ? !!t.overlay_path_2x6 : !!t.overlay_path_4x6
        );
        countEl.textContent = visible.length
          ? `${visible.length} template${visible.length !== 1 ? "s" : ""}`
          : "";
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
      const nameEl     = sel("templateName");
      const typeEl     = sel("templateAssetType");
      const f2El       = sel("templateFile2x6");
      const f4El       = sel("templateFile4x6");
      const titleEl    = sel("templateUploadModalTitle");
      const field2x6   = sel("uploadField2x6");
      const field4x6   = sel("uploadField4x6");

      if (nameEl) nameEl.value = "";
      if (typeEl) typeEl.value = "frame_template";
      if (f2El)   f2El.value = "";
      if (f4El)   f4El.value = "";
      if (progressEl) { progressEl.textContent = ""; progressEl.hidden = true; }

      // Show only the active format field
      if (field2x6) field2x6.style.display = _activeFormat === "2x6" ? "" : "none";
      if (field4x6) field4x6.style.display = _activeFormat === "4x6" ? "" : "none";
      if (titleEl)  titleEl.textContent = `Upload ${_activeFormat === "2x6" ? "2×6" : "4×6"} Template`;

      modal.hidden = false;
    });

    cancelBtn.addEventListener("click", () => { modal.hidden = true; });

    submitBtn.addEventListener("click", async () => {
      console.log("[templateManager] Upload submit clicked.");

      let name, assetType, file2x6, file4x6;
      try {
        const nameEl = sel("templateName");
        const typeEl = sel("templateAssetType");
        const f2El   = sel("templateFile2x6");
        const f4El   = sel("templateFile4x6");

        if (!nameEl || !typeEl) {
          throw new Error("Upload form fields not found in the page — try a hard refresh (Ctrl+Shift+R).");
        }

        name      = nameEl.value.trim();
        assetType = typeEl.value;
        // Only read the file field for the active format tab
        file2x6   = (_activeFormat === "2x6" && f2El) ? (f2El.files[0] || null) : null;
        file4x6   = (_activeFormat === "4x6" && f4El) ? (f4El.files[0] || null) : null;
      } catch (e) {
        console.error("[templateManager] Could not read upload form:", e);
        showToast(`Could not read upload form: ${e.message}`);
        return;
      }

      if (!name) { showToast("Please enter a template name."); return; }
      if (!file2x6 && !file4x6) {
        showToast(`Please select a ${_activeFormat === "2x6" ? "2×6" : "4×6"} frame PNG file.`);
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Uploading…";
      if (progressEl) { progressEl.hidden = false; progressEl.textContent = "Uploading files…"; }

      try {
        // thumbFile intentionally omitted — thumbnail upload removed
        await adminTemplates.uploadTemplate({ name, assetType, file2x6, file4x6, thumbFile: null });
        modal.hidden = true;
        showToast(`Template "${name}" uploaded.`);
        await loadTemplates();
      } catch (e) {
        console.error("[templateManager] Upload failed:", e);
        showToast(`Upload failed: ${e.message}`);
        if (progressEl) progressEl.textContent = `Error: ${e.message}`;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Upload";
      }
    });
  }

  // ── Sync Templates button ───────────────────────────────────────────────────
  /*
   * POSTs to the kiosk's local server sync trigger endpoint so the running
   * kiosk re-pulls templates from Supabase immediately, without waiting for
   * the 3-minute background poll.
   *
   * Because the Admin runs on studrio.cc and the kiosk is on localhost, this
   * can only work when the browser window running the admin panel is on the
   * same machine as the kiosk (i.e. the operator opens the admin page on the
   * booth PC itself). In all other cases, the button still refreshes the
   * admin's own template list and shows a clear "kiosk offline" notice.
   *
   * The kiosk will also pick up new templates within 3 minutes automatically
   * via the background poll in asset-sync.js — no sync button press needed.
   */
  const KIOSK_SYNC_ENDPOINT = "https://localhost:3000/sync/trigger";

  async function triggerKioskSync(btn) {
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Syncing…";

    // Refresh the admin's own template list
    await loadTemplates();

    // If we're in the Electron app, we can trigger a refresh on the kiosk side
    // via a global event or direct call if they share the same memory space.
    if (typeof assetSync !== "undefined" && assetSync.forceRefresh) {
      await assetSync.forceRefresh();
      showToast("✓ Templates synced and refreshed.", 4000);
    } else {
      showToast("Templates list refreshed. (Kiosk will auto-sync within 3 min).", 4000);
    }

    btn.disabled = false;
    btn.textContent = originalText;
  }

  function wireSyncButton() {
    const btn = sel("btnSyncTemplates");
    if (!btn) {
      console.warn("[templateManager] wireSyncButton: #btnSyncTemplates not found — sync button will not work.");
      return;
    }
    btn.addEventListener("click", () => triggerKioskSync(btn));
  }

  // ── Load ────────────────────────────────────────────────────────────────────

  async function loadTemplates() {
    _statusEl.hidden = false;
    _statusEl.textContent = "Loading templates…";
    _containerEl.innerHTML = "";
    try {
      _templates = await adminTemplates.listTemplates();
      renderTemplateList(_templates);

      // Update the count label
      const countEl = sel("templateCount");
      if (countEl) {
        countEl.textContent = _templates.length
          ? `${_templates.length} template${_templates.length !== 1 ? "s" : ""}`
          : "";
      }
    } catch (e) {
      console.error("[templateManager] loadTemplates failed:", e);
      _statusEl.hidden = false;
      _statusEl.textContent = `Could not load templates: ${e.message}`;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // FILTER MANAGER
  // Handles .lut and .cube filter uploads, preview, opacity, and persistence.
  // Filters are stored in localStorage (client-side only, no Supabase table).
  // ════════════════════════════════════════════════════════════════════════════

  const FILTERS_LS_KEY     = "studrio_filters";
  const FILTERS_CLOUD_PATH = "filters/filters.json"; // path in Supabase Storage bucket

  let _filters = []; // Array of { id, name, fileData (base64), format, opacity }

  // ── localStorage (fast local cache) ─────────────────────────────────────────

  function _saveFiltersLocal() {
    try {
      localStorage.setItem(FILTERS_LS_KEY, JSON.stringify(_filters));
    } catch (e) {
      console.warn("[templateManager] Could not save filters to localStorage:", e);
    }
  }

  function _loadFiltersLocal() {
    try {
      return JSON.parse(localStorage.getItem(FILTERS_LS_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  // ── Supabase Storage persistence ─────────────────────────────────────────────

  async function saveFiltersToCloud(filters) {
    const client = adminStorage.getClient();
    if (!client) throw new Error("Supabase client not available.");
    const json = JSON.stringify(filters);
    const blob = new Blob([json], { type: "application/json" });
    const { error } = await client.storage
      .from(CLOUD_CONFIG.bucketName)
      .upload(FILTERS_CLOUD_PATH, blob, { upsert: true, contentType: "application/json" });
    if (error) throw error;
    console.log(`[templateManager] ${filters.length} filter(s) saved to Supabase Storage.`);
  }

  async function loadFiltersFromCloud() {
    try {
      const client = adminStorage.getClient();
      if (!client) throw new Error("Supabase client not available.");
      const { data } = client.storage
        .from(CLOUD_CONFIG.bucketName)
        .getPublicUrl(FILTERS_CLOUD_PATH);
      const res = await fetch(`${data.publicUrl}?t=${Date.now()}`);
      if (!res.ok) {
        if (res.status === 404) return []; // no filters uploaded yet
        throw new Error(`HTTP ${res.status}`);
      }
      const parsed = await res.json();
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn("[templateManager] Could not load filters from Supabase:", e.message || e);
      return null; // null = cloud unavailable
    }
  }

  /*
   * _mergeFilters — merges two filter arrays by id, preferring newer entries.
   * The local array takes precedence over cloud for items with the same id
   * (local is always the most recently edited copy).
   * Items that exist only in cloud are kept.
   * Items that exist only in local are kept.
   */
  function _mergeFilters(cloudFilters, localFilters) {
    const merged = new Map();
    // Cloud first (older / authoritative for items not modified locally)
    (cloudFilters || []).forEach((f) => { if (f && f.id) merged.set(String(f.id), f); });
    // Local overwrites cloud (local is the freshest copy)
    (localFilters || []).forEach((f) => { if (f && f.id) merged.set(String(f.id), f); });
    return Array.from(merged.values());
  }

  // ── Unified load/save (cloud-first with merge, local fallback) ────────────────

  async function loadFilters() {
    const cloudFilters  = await loadFiltersFromCloud();
    const localFilters  = _loadFiltersLocal();

    if (cloudFilters !== null) {
      // Merge: keep everything from both cloud and local (local wins on conflict)
      _filters = _mergeFilters(cloudFilters, localFilters);
      _saveFiltersLocal();
    } else {
      // Cloud unavailable — use local cache
      _filters = localFilters;
    }
  }

  /*
   * saveFilters — persists _filters to localStorage immediately, then awaits
   * the Supabase upload before returning so callers can confirm it landed.
   * Fire-and-forget callers can still .catch(() => {}) if they don't need to
   * wait.
   */
  async function saveFilters() {
    _saveFiltersLocal();
    try {
      await saveFiltersToCloud(_filters);
    } catch (e) {
      console.warn("[templateManager] Cloud filter save failed (will retry on next sync):", e.message || e);
    }
  }

  function renderFilterList() {
    const grid = document.getElementById("filterGrid");
    const status = document.getElementById("filterStatus");
    if (!grid) return;

    grid.innerHTML = "";
    if (!_filters.length) {
      if (status) { status.hidden = false; status.textContent = 'No filters yet. Click "Upload Filter" to add one.'; }
      return;
    }
    if (status) status.hidden = true;

    _filters.forEach((filter, index) => {
      const card = document.createElement("div");
      card.className = "filter-admin-card";
      card.dataset.id = filter.id;

      card.innerHTML = `
        <div class="filter-admin-header">
          <span class="filter-admin-name">${escapeHtml(filter.name)}</span>
          <span class="filter-admin-format">.${filter.format}</span>
        </div>
        <div class="filter-admin-preview-wrap">
          <canvas class="filter-admin-canvas" width="160" height="120" data-filter-id="${filter.id}"></canvas>
          <p class="filter-admin-preview-hint">Upload a preview image below</p>
        </div>
        <div class="filter-admin-controls">
          <label class="filter-admin-opacity-label">
            Opacity: <strong class="filter-opacity-val">${Math.round((filter.opacity ?? 1) * 100)}%</strong>
          </label>
          <input type="range" class="filter-opacity-slider" min="0" max="100" step="1"
                 value="${Math.round((filter.opacity ?? 1) * 100)}" data-filter-id="${filter.id}">
        </div>
        <div class="filter-admin-preview-upload">
          <label class="filter-preview-upload-label">Preview image (optional)</label>
          <input type="file" class="filter-preview-file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" data-filter-id="${filter.id}">
        </div>
        <div class="filter-admin-actions">
          <button class="btn-admin btn-admin-outline btn-sm" data-action="preview-filter">Preview</button>
          <button class="btn-admin btn-admin-ghost btn-sm" data-action="delete-filter">Delete</button>
        </div>
      `;

      // Opacity slider
      const slider = card.querySelector(".filter-opacity-slider");
      const valEl  = card.querySelector(".filter-opacity-val");
      slider.addEventListener("input", () => {
        const pct = parseInt(slider.value, 10);
        valEl.textContent = `${pct}%`;
        filter.opacity = pct / 100;
        saveFilters();
        // Dispatch event so kiosk filter engine can pick this up
        document.dispatchEvent(new CustomEvent("studrio:filterOpacityChanged", { detail: { id: filter.id, opacity: filter.opacity } }));
      });

      // Preview image upload — draws on the canvas with simulated filter effect
      const previewFileInput = card.querySelector(".filter-preview-file");
      const previewCanvas    = card.querySelector(".filter-admin-canvas");
      const previewHint      = card.querySelector(".filter-admin-preview-hint");

      if (filter.previewDataUrl) {
        _drawFilterPreviewOnCanvas(previewCanvas, filter.previewDataUrl, filter.opacity ?? 1, filter);
        if (previewHint) previewHint.style.display = "none";
      }

      previewFileInput.addEventListener("change", () => {
        const file = previewFileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          filter.previewDataUrl = e.target.result;
          saveFilters();
          _drawFilterPreviewOnCanvas(previewCanvas, e.target.result, filter.opacity ?? 1, filter);
          if (previewHint) previewHint.style.display = "none";
        };
        reader.readAsDataURL(file);
      });

      // Preview button — opens a full-size preview modal
      card.querySelector('[data-action="preview-filter"]').addEventListener("click", () => {
        showFilterPreviewModal(filter);
      });

      // Delete button
      card.querySelector('[data-action="delete-filter"]').addEventListener("click", () => {
        if (!confirm(`Delete filter "${filter.name}"?`)) return;
        _filters.splice(index, 1);
        saveFilters(); // saves locally + pushes to Supabase in background
        renderFilterList();
        showToast(`Filter "${filter.name}" deleted.`);
        // Notify kiosk filter engine
        document.dispatchEvent(new CustomEvent("studrio:filtersUpdated", { detail: { filters: _filters } }));
        // Update filter count label
        const filterCountEl = document.getElementById("filterCount");
        if (filterCountEl) {
          filterCountEl.textContent = _filters.length
            ? `${_filters.length} filter${_filters.length !== 1 ? "s" : ""}`
            : "";
        }
      });

      grid.appendChild(card);
    });
  }

  /*
   * Draws a preview image onto the canvas with a simple opacity-based
   * brightness shift to simulate a filter effect (real LUT parsing is complex;
   * this is a representative admin preview only).
   */
  function _drawFilterPreviewOnCanvas(canvas, dataUrl, opacity, filter) {
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Apply a simple desaturation effect as a visual indicator of the filter
      // (full LUT application requires GPU or complex CPU parsing)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      const strength = opacity;
      for (let i = 0; i < data.length; i += 4) {
        const gray = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
        data[i]   = data[i]   * (1 - strength) + gray * strength;
        data[i+1] = data[i+1] * (1 - strength) + gray * strength;
        data[i+2] = data[i+2] * (1 - strength) + gray * strength;
      }
      ctx.putImageData(imageData, 0, 0);

      // Label the filter name on the preview
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, canvas.height - 22, canvas.width, 22);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(filter.name, 6, canvas.height - 7);
    };
    img.src = dataUrl;
  }

  function showFilterPreviewModal(filter) {
    const modal = document.getElementById("filterPreviewModal");
    if (!modal) return;
    const title = modal.querySelector(".filter-preview-modal-title");
    const canvas = modal.querySelector(".filter-preview-modal-canvas");
    if (title) title.textContent = `Preview: ${filter.name}`;
    if (canvas && filter.previewDataUrl) {
      canvas.width  = 480;
      canvas.height = 360;
      _drawFilterPreviewOnCanvas(canvas, filter.previewDataUrl, filter.opacity ?? 1, filter);
    } else if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#f4f5f7";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#888";
      ctx.font = "16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No preview image uploaded", canvas.width / 2, canvas.height / 2);
    }
    modal.hidden = false;
  }

  function wireFilterSection() {
    // ── Sync Filters button ──────────────────────────────────────────────────
    const syncBtn = document.getElementById("btnSyncFilters");
    if (syncBtn) {
      syncBtn.addEventListener("click", async () => {
        syncBtn.disabled = true;
        const orig = syncBtn.textContent;
        syncBtn.textContent = "Syncing…";
        try {
          // 1. Merge cloud + local (loadFilters does the merge internally)
          await loadFilters();

          // 2. Push the MERGED result back to Supabase so nothing is lost.
          //    This is the key fix: Sync = merge then re-upload, not replace.
          await saveFilters();

          renderFilterList();

          // 3. Notify kiosk filter engine so it picks up the merged list
          document.dispatchEvent(new CustomEvent("studrio:filtersUpdated", { detail: { filters: _filters } }));

          // 4. Optionally trigger kiosk-side asset-sync refresh
          if (typeof assetSync !== "undefined" && assetSync.forceRefresh) {
            await assetSync.forceRefresh();
          }

          showToast(`✓ Filters synced — ${_filters.length} filter${_filters.length !== 1 ? "s" : ""} saved.`, 4000);
        } catch (e) {
          showToast(`Sync failed: ${e.message}`);
        } finally {
          syncBtn.disabled = false;
          syncBtn.textContent = orig;
        }
      });
    }

    // Upload filter button
    const openBtn   = document.getElementById("btnUploadFilter");
    const modal     = document.getElementById("filterUploadModal");
    const cancelBtn = document.getElementById("btnFilterUploadCancel");
    const submitBtn = document.getElementById("btnFilterUploadSubmit");

    if (!openBtn || !modal || !cancelBtn || !submitBtn) {
      console.warn("[templateManager] wireFilterSection: missing filter upload elements");
      return;
    }

    openBtn.addEventListener("click", () => {
      const nameEl = document.getElementById("filterName");
      const fileEl = document.getElementById("filterFile");
      if (nameEl) nameEl.value = "";
      if (fileEl) fileEl.value = "";
      modal.hidden = false;
    });

    cancelBtn.addEventListener("click", () => { modal.hidden = true; });

    submitBtn.addEventListener("click", () => {
      const nameEl = document.getElementById("filterName");
      const fileEl = document.getElementById("filterFile");
      const name = nameEl ? nameEl.value.trim() : "";
      const file = fileEl ? fileEl.files[0] : null;

      if (!name) { showToast("Please enter a filter name."); return; }
      if (!file) { showToast("Please select a .lut or .cube file."); return; }

      const format = file.name.split(".").pop().toLowerCase();
      if (!["lut", "cube"].includes(format)) {
        showToast("Only .lut and .cube files are supported.");
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Reading…";

      const reader = new FileReader();
      reader.onload = async (e) => {
        const filter = {
          id: `filter_${Date.now()}`,
          name,
          format,
          fileData: e.target.result, // base64 data URL of the LUT file
          opacity: 1,
          previewDataUrl: null
        };
        _filters.push(filter);

        // Show "saving" state while the cloud upload completes
        submitBtn.textContent = "Saving…";
        try {
          await saveFilters(); // saves locally AND awaits Supabase upload
          modal.hidden = true;
          nameEl.value = "";
          fileEl.value = "";
          renderFilterList();
          showToast(`Filter "${name}" uploaded and synced.`);
        } catch (e) {
          // Local save succeeded; cloud failed — still show as uploaded since
          // the next Sync or background retry will push it.
          modal.hidden = true;
          nameEl.value = "";
          fileEl.value = "";
          renderFilterList();
          showToast(`Filter "${name}" saved locally. Cloud sync pending.`);
        }

        // Notify kiosk filter engine
        document.dispatchEvent(new CustomEvent("studrio:filtersUpdated", { detail: { filters: _filters } }));
        // Update filter count label
        const filterCountEl = document.getElementById("filterCount");
        if (filterCountEl) {
          filterCountEl.textContent = _filters.length
            ? `${_filters.length} filter${_filters.length !== 1 ? "s" : ""}`
            : "";
        }
        submitBtn.disabled = false;
        submitBtn.textContent = "Upload";
      };
      reader.onerror = () => {
        showToast("Could not read filter file.");
        submitBtn.disabled = false;
        submitBtn.textContent = "Upload";
      };
      reader.readAsDataURL(file);
    });

    // Filter preview modal close
    const previewModal = document.getElementById("filterPreviewModal");
    const previewClose = document.getElementById("btnFilterPreviewClose");
    if (previewClose && previewModal) {
      previewClose.addEventListener("click", () => { previewModal.hidden = true; });
    }
  }

  // Public accessor so asset-sync / kiosk can read filters
  function getFilters() { return _filters; }

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
        <div class="template-header-actions">
          <button class="btn-admin btn-admin-outline btn-sm" id="btnSyncTemplates" type="button">↻ Sync Templates</button>
          <button class="btn-admin btn-admin-primary btn-sm" id="btnUploadTemplate" type="button">+ Upload Template</button>
        </div>
      </div>

      <!-- ── Template format tabs ──────────────────────────────────────── -->
      <div class="template-format-tabs" id="templateFormatTabs">
        <button class="template-format-tab active" data-format="2x6" type="button">2×6 Templates</button>
        <button class="template-format-tab" data-format="4x6" type="button">4×6 Templates</button>
      </div>

      <p class="admin-status" id="templateStatus">Loading templates…</p>
      <div class="template-grid" id="templateGrid"></div>

      <!-- ── Delete confirmation modal ──────────────────────────────────── -->
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

      <!-- ── Edit modal ─────────────────────────────────────────────────── -->
      <div class="admin-modal-overlay" id="templateEditModal" hidden>
        <div class="admin-modal-box admin-modal-box--wide">
          <h3 class="admin-modal-title">Edit Template</h3>

          <div class="template-upload-form">

            <div class="form-field">
              <label for="editTemplateName">Template name</label>
              <input type="text" id="editTemplateName" placeholder="e.g. Coastal Cool" maxlength="80">
            </div>

            <div class="form-field">
              <label for="editTemplateAssetType">Asset type</label>
              <select id="editTemplateAssetType">
                <option value="frame_template">Frame Template</option>
                <option value="sticker">Sticker</option>
                <option value="background">Background</option>
                <option value="gif_video">GIF / Video</option>
                <option value="logo">Logo</option>
              </select>
            </div>

            <!-- Edit modal shows only the relevant format file field based on active tab -->
            <div class="form-field" id="editField2x6">
              <label for="editTemplateFile2x6">
                Replace Frame PNG — 2×6 (Long Frame)
                <span class="edit-current-label" id="editCurrent2x6"></span>
              </label>
              <input type="file" id="editTemplateFile2x6" accept=".png,image/png">
              <p class="form-hint">Leave blank to keep the existing 2×6 overlay. Upload a <strong>single strip</strong> at 1200×3600px, 600dpi — the kiosk mirrors it into a two-strip print layout automatically.</p>
            </div>

            <div class="form-field" id="editField4x6">
              <label for="editTemplateFile4x6">
                Replace Frame PNG — 4×6 (Wide Frame)
                <span class="edit-current-label" id="editCurrent4x6"></span>
              </label>
              <input type="file" id="editTemplateFile4x6" accept=".png,image/png">
              <p class="form-hint">Leave blank to keep the existing 4×6 overlay.</p>
            </div>

            <p class="form-hint template-edit-version-note">
              Replacing any file will bump the template's version number so all kiosks re-download the updated assets automatically.
            </p>

            <p class="template-upload-progress" id="editTemplateProgress" hidden></p>
          </div>

          <div class="admin-modal-actions">
            <button class="btn-admin btn-admin-outline" id="btnTemplateEditCancel" type="button">Cancel</button>
            <button class="btn-admin btn-admin-primary" id="btnTemplateEditSubmit" type="button">Save</button>
          </div>
        </div>
      </div>

      <!-- ── Upload modal ───────────────────────────────────────────────── -->
      <div class="admin-modal-overlay" id="templateUploadModal" hidden>
        <div class="admin-modal-box admin-modal-box--wide">
          <!-- Title updates dynamically to show which format is being uploaded -->
          <h3 class="admin-modal-title" id="templateUploadModalTitle">Upload Template</h3>

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

            <!-- 2×6 upload field — shown when 2×6 tab is active -->
            <div class="form-field" id="uploadField2x6">
              <label for="templateFile2x6">Frame PNG — 2×6 (Long Frame)</label>
              <input type="file" id="templateFile2x6" accept=".png,image/png">
              <p class="form-hint">Upload a <strong>single strip</strong> at 1200×3600px, 600dpi. The kiosk automatically mirrors it into a two-strip print layout.</p>
            </div>

            <!-- 4×6 upload field — shown when 4×6 tab is active -->
            <div class="form-field" id="uploadField4x6" style="display:none">
              <label for="templateFile4x6">Frame PNG — 4×6 (Wide Frame)</label>
              <input type="file" id="templateFile4x6" accept=".png,image/png">
              <p class="form-hint">Upload at 2400×3600px (4×6 format), 600dpi.</p>
            </div>

            <p class="template-upload-progress" id="templateUploadProgress" hidden></p>
          </div>

          <div class="admin-modal-actions">
            <button class="btn-admin btn-admin-outline" id="btnTemplateUploadCancel" type="button">Cancel</button>
            <button class="btn-admin btn-admin-primary" id="btnTemplateUploadSubmit" type="button">Upload</button>
          </div>
        </div>
      </div>

      <!-- ══════════════════════════════════════════════════════════════════ -->
      <!-- ── Filter Manager ────────────────────────────────────────────── -->
      <!-- ══════════════════════════════════════════════════════════════════ -->
      <div class="filter-manager-section">
        <div class="gallery-section-head" style="margin-top: 2rem;">
          <div class="gallery-section-head-left">
            <h2>Filters</h2>
            <p class="gallery-count" id="filterCount"></p>
          </div>
          <div class="template-header-actions">
            <button class="btn-admin btn-admin-outline btn-sm" id="btnSyncFilters" type="button">↻ Sync Filters</button>
            <button class="btn-admin btn-admin-primary btn-sm" id="btnUploadFilter" type="button">+ Upload Filter</button>
          </div>
        </div>
        <p class="form-hint" style="margin-bottom:1rem;">Upload <code>.lut</code> or <code>.cube</code> colour-grading files. Adjust each filter's strength with the opacity slider. Filters are saved to Supabase and sync to the kiosk automatically.</p>
        <p class="admin-status" id="filterStatus">No filters yet.</p>
        <div class="filter-admin-grid" id="filterGrid"></div>
      </div>

      <!-- ── Filter upload modal ─────────────────────────────────────────── -->
      <div class="admin-modal-overlay" id="filterUploadModal" hidden>
        <div class="admin-modal-box admin-modal-box--wide">
          <h3 class="admin-modal-title">Upload Filter</h3>
          <div class="template-upload-form">
            <div class="form-field">
              <label for="filterName">Filter name</label>
              <input type="text" id="filterName" placeholder="e.g. Warm Sunset" maxlength="60">
            </div>
            <div class="form-field">
              <label for="filterFile">Filter file (.lut or .cube)</label>
              <input type="file" id="filterFile" accept=".lut,.cube">
              <p class="form-hint">Supports standard 1D/3D LUT files in .lut or .cube format.</p>
            </div>
          </div>
          <div class="admin-modal-actions">
            <button class="btn-admin btn-admin-outline" id="btnFilterUploadCancel" type="button">Cancel</button>
            <button class="btn-admin btn-admin-primary" id="btnFilterUploadSubmit" type="button">Upload</button>
          </div>
        </div>
      </div>

      <!-- ── Filter preview modal ────────────────────────────────────────── -->
      <div class="admin-modal-overlay" id="filterPreviewModal" hidden>
        <div class="admin-modal-box admin-modal-box--wide">
          <h3 class="admin-modal-title filter-preview-modal-title">Preview Filter</h3>
          <div style="display:flex;align-items:center;justify-content:center;padding:1rem 0;">
            <canvas class="filter-preview-modal-canvas" width="480" height="360"
                    style="border-radius:10px;border:1px solid #ddd;max-width:100%;"></canvas>
          </div>
          <p class="form-hint" style="text-align:center;">Simulated preview — actual output depends on the LUT data.</p>
          <div class="admin-modal-actions">
            <button class="btn-admin btn-admin-primary" id="btnFilterPreviewClose" type="button">Close</button>
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
      wireFormatTabs();
      wireUploadModal();
      wireEditModal();
      wireDeleteModal();
      wireSyncButton();
      await loadTemplates();

      // Filter manager — load from cloud (Supabase) first, fall back to localStorage
      await loadFilters();
      renderFilterList();
      wireFilterSection();

      // Update filter count label
      const filterCountEl = document.getElementById("filterCount");
      if (filterCountEl) {
        filterCountEl.textContent = _filters.length
          ? `${_filters.length} filter${_filters.length !== 1 ? "s" : ""}`
          : "";
      }
    },

    async refresh() {
      await loadTemplates();
      renderFilterList();
    },

    // Public: returns current filter list for the kiosk
    getFilters
  };
})();
