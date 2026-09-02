/*
 * ADMIN-TEMPLATE-MANAGER.JS
 * ─────────────────────────────────────────────────────────────────────────────
 * Template Manager tab on the admin dashboard.
 * Depends on: cloud-storage.js (adminStorage + adminTemplates), admin.css
 *
 * What it does:
 *   • Lists all templates from the Supabase `templates` table
 *   • Organises templates by CATEGORY (Originals / Designs / Accessories)
 *     and FORMAT (2×6 / 4×6) — these are independent filters, not tabs
 *   • Upload new frame template — one file per template, one format per template
 *   • Edit existing templates — replace overlay file, rename, change category
 *   • Enable / disable templates (kiosk skips disabled ones during sync)
 *   • Rename templates (updates `name` column)
 *   • Reorder templates by drag-handle or up/down buttons (updates `sort_order`)
 *   • Delete templates (removes Supabase Storage files + table row)
 *   • Sync Templates button — triggers the kiosk's local server to re-pull
 *     the latest templates immediately, without waiting for the 3-min poll
 *
 * DATA MODEL (per template):
 *   id, name, category (stored in asset_type column), format (2x6 or 4x6,
 *   derived from which overlay_path is set), overlay_path_2x6 or
 *   overlay_path_4x6, enabled, sort_order, version
 *
 *   The `asset_type` column in Supabase is repurposed to store the category
 *   value ("Originals", "Designs", or "Accessories"). The format is implicit:
 *   a template with overlay_path_2x6 set is a 2×6; one with overlay_path_4x6
 *   set is a 4×6. Each template is a single format — they are separate records.
 *
 * KIOSK INTEGRATION:
 *   The kiosk reads `category` (from asset_type) and `format` from each
 *   template record. It uses its hard-coded rendering configuration for the
 *   format — the Admin Panel never manages canvas/photo positions.
 *
 *   KEYCHAIN TEMPLATES (Accessories category, 4×6 format):
 *   Keychain templates are uploaded as independent 4×6 templates under the
 *   Accessories category. The uploaded PNG is the Mini-Strip overlay
 *   (591×1795 px, 600 DPI) applied to both Mini-Strip frames on the right
 *   half of the keychain print sheet (2400×3600 px canvas). The left half
 *   (2×6 strip, 4 photos + QR) uses the standard 2×6 slot positions — no
 *   separate overlay is needed for it. The kiosk identifies keychain
 *   templates by asset_type = "Accessories" and format = "4x6".
 *
 * SYNC BUTTON BEHAVIOR:
 *   See previous comment — same behaviour as before.
 */

const templateManager = (() => {

  // ── DOM refs ────────────────────────────────────────────────────────────────
  // These are all inside #templateSection, injected into dashboard.html.
  const sel = (id) => document.getElementById(id);

  let _containerEl   = null; // #templateGrid — card grid
  let _statusEl      = null; // #templateStatus — loading/empty message
  let _toast         = null; // shared with admin-dashboard.js

  // ── Category / format constants ─────────────────────────────────────────────
  const CATEGORIES = ["Originals", "Designs", "Accessories", "Flipbook"];
  const FORMATS    = ["2x6", "4x6", "long-duo", "long-mini", "film-duo", "wide-mini", "flipbook"];

  // Human-readable labels for the new frame formats
  const FORMAT_LABELS = {
    "2x6":      "2×6 (Long Frame)",
    "4x6":      "4×6 (Wide Frame)",
    "long-duo": "Long Duo",
    "long-mini":"Long Mini",
    "film-duo": "Film Duo",
    "wide-mini":"Wide Mini",
    "flipbook": "Flipbook (3 Slots)"
  };

  // Flipbook templates use 3 independent overlay slots instead of one
  // shared frame PNG — checked in a few places below wherever the code
  // otherwise looks at a single overlay_path_* column.
  const FLIPBOOK_OVERLAY_COLS = ["overlay_path_flipbook_cover", "overlay_path_flipbook_a4_1", "overlay_path_flipbook_a4_2", "overlay_path_flipbook_preview"];

  let _templates     = [];
  let _dragSrcIndex  = null; // for drag-and-drop reordering
  let _activeCategory = "all"; // "all" | "Originals" | "Designs" | "Accessories"
  let _activeFormat   = "all"; // "all" | "2x6" | "4x6"

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

    // Helper: derive the format of a template from which overlay path is set
    function _templateFormat(t) {
      if (t.overlay_path_2x6)      return "2x6";
      if (t.overlay_path_4x6)      return "4x6";
      if (t.overlay_path_long_duo) return "long-duo";
      if (t.overlay_path_long_mini)return "long-mini";
      if (t.overlay_path_film_duo) return "film-duo";
      if (t.overlay_path_wide_mini)return "wide-mini";
      if (t.overlay_path_flipbook_cover || t.overlay_path_flipbook_a4_1 || t.overlay_path_flipbook_a4_2) return "flipbook";
      return null;
    }

    // Helper: derive the category from asset_type (stored as e.g. "Originals")
    function _templateCategory(t) {
      const v = (t.asset_type || "").trim();
      // Accept exact matches or legacy values mapped to "Originals"
      if (CATEGORIES.includes(v)) return v;
      return "Originals"; // default for legacy templates
    }

    // Filter by category then format
    const filtered = templates.filter((t) => {
      const catMatch = _activeCategory === "all" || _templateCategory(t) === _activeCategory;
      const fmtMatch = _activeFormat   === "all" || _templateFormat(t)   === _activeFormat;
      return catMatch && fmtMatch;
    });

    if (!filtered.length) {
      _statusEl.hidden = false;
      const hasAny = templates.length > 0;
      const catLabel = _activeCategory !== "all" ? _activeCategory : null;
      const fmtLabel = _activeFormat   !== "all" ? (_activeFormat === "2x6" ? "2×6" : "4×6") : null;
      const filterDesc = [catLabel, fmtLabel].filter(Boolean).join(" · ");
      _statusEl.textContent = hasAny
        ? `No ${filterDesc || "matching"} templates. Click "Upload Template" to add one.`
        : 'No templates yet. Click "Upload Template" to add one.';
      return;
    }
    _statusEl.hidden = true;

    filtered.forEach((t, index) => {
      const card = document.createElement("div");
      card.className = "template-card" + (t.enabled ? "" : " template-card--disabled");
      card.dataset.id = t.id;
      card.draggable = true;

      const category  = _templateCategory(t);
      const format    = _templateFormat(t);
      const formatLabel = format ? (FORMAT_LABELS[format] || format) : "—";

      // Thumbnail: prefer thumbnail_url (resolved public URL from adminTemplates.listTemplates)
      const thumbSrc = t.thumbnail_url || null;

      card.innerHTML = `
        <div class="template-card-drag-handle" title="Drag to reorder">⠿</div>
        <div class="template-card-thumb">
          ${thumbSrc
            ? `<img class="template-thumb" src="${escapeHtml(thumbSrc)}" alt="${escapeHtml(t.name)} thumbnail" loading="lazy">`
            : `<div class="template-thumb template-thumb--empty">No thumbnail</div>`
          }
        </div>
        <div class="template-card-body">
          <p class="template-card-name" data-field="name">${escapeHtml(t.name)}</p>
          <div class="template-card-badges">
            <span class="template-badge template-badge--category">${escapeHtml(category)}</span>
            <span class="template-badge template-badge--format">${escapeHtml(formatLabel)}</span>
          </div>
          <p class="template-card-meta">v${t.version || 1}${t.enabled ? "" : " · Disabled"}</p>
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
    // Swap within the filtered (category+format subset) copy
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

    // Derive category and format from the template record
    const existingCategory = CATEGORIES.includes((template.asset_type || "").trim())
      ? template.asset_type.trim()
      : "Originals";
    const existingFormat = template.overlay_path_2x6       ? "2x6"
                         : template.overlay_path_4x6       ? "4x6"
                         : template.overlay_path_long_duo  ? "long-duo"
                         : template.overlay_path_long_mini ? "long-mini"
                         : template.overlay_path_film_duo  ? "film-duo"
                         : template.overlay_path_wide_mini ? "wide-mini"
                         : (template.overlay_path_flipbook_cover || template.overlay_path_flipbook_a4_1 || template.overlay_path_flipbook_a4_2) ? "flipbook"
                         : "2x6";

    // Pre-fill name, category, format
    const nameEl     = sel("editTemplateName");
    const categoryEl = sel("editTemplateCategory");
    const formatEl   = sel("editTemplateFormat");
    if (nameEl)     nameEl.value     = template.name || "";
    if (categoryEl) categoryEl.value = existingCategory;
    if (formatEl)   formatEl.value   = existingFormat;

    // Clear file inputs (they can't be pre-filled for security reasons)
    const f2El = sel("editTemplateFile2x6");
    const f4El = sel("editTemplateFile4x6");
    const fPvEl = sel("editTemplateFilePreviewOverlay");
    const fFbCoverEl = sel("editTemplateFileFlipbookCover");
    const fFbA1El    = sel("editTemplateFileFlipbookA4Page1");
    const fFbA2El    = sel("editTemplateFileFlipbookA4Page2");
    const fFbPvEl    = sel("editTemplateFileFlipbookPreview");
    if (f2El)  f2El.value  = "";
    if (f4El)  f4El.value  = "";
    if (fPvEl) fPvEl.value = "";
    if (fFbCoverEl) fFbCoverEl.value = "";
    if (fFbA1El)    fFbA1El.value    = "";
    if (fFbA2El)    fFbA2El.value    = "";
    if (fFbPvEl)    fFbPvEl.value    = "";

    // Show the existing overlay file status (check all supported format columns)
    const curFileEl = sel("editCurrentFile");
    if (curFileEl) {
      const hasFile = template.overlay_path_2x6       ||
                      template.overlay_path_4x6       ||
                      template.overlay_path_long_duo  ||
                      template.overlay_path_long_mini ||
                      template.overlay_path_film_duo  ||
                      template.overlay_path_wide_mini;
      curFileEl.textContent = hasFile ? "✓ Existing file" : "None";
    }

    // Show per-slot existing-file status for flipbook templates
    const curFbCoverEl = sel("editCurrentFlipbookCover");
    const curFbA1El    = sel("editCurrentFlipbookA4Page1");
    const curFbA2El    = sel("editCurrentFlipbookA4Page2");
    if (curFbCoverEl) curFbCoverEl.textContent = template.overlay_path_flipbook_cover ? "✓ Existing file" : "None";
    if (curFbA1El)    curFbA1El.textContent    = template.overlay_path_flipbook_a4_1  ? "✓ Existing file" : "None";
    if (curFbA2El)    curFbA2El.textContent    = template.overlay_path_flipbook_a4_2  ? "✓ Existing file" : "None";
    const curFbPvEl = sel("editCurrentFlipbookPreview");
    if (curFbPvEl)    curFbPvEl.textContent    = template.overlay_path_flipbook_preview ? "✓ Existing file" : "None (optional)";

    // Show the existing strip preview overlay status
    const curPreviewOverlayEl = sel("editCurrentPreviewOverlay");
    if (curPreviewOverlayEl) {
      const hasPreviewOverlay = template.preview_overlay_path_long_duo  ||
                                template.preview_overlay_path_long_mini ||
                                template.preview_overlay_path_film_duo  ||
                                template.preview_overlay_path_wide_mini;
      curPreviewOverlayEl.textContent = hasPreviewOverlay ? "✓ Existing preview overlay" : "";
    }

    // Show the existing thumbnail status
    const curThumbEl = sel("editCurrentThumb");
    if (curThumbEl) {
      curThumbEl.textContent = template.thumbnail_path ? "✓ Existing thumbnail" : "";
    }

    // Clear thumbnail file input
    const fThEl = sel("editTemplateFileThumb");
    if (fThEl) fThEl.value = "";

    // Show only the format's file field (driven by the format select)
    _syncEditFormatFields(existingFormat);

    // Wire the format select to update the visible file field
    if (formatEl) {
      formatEl.onchange = () => _syncEditFormatFields(formatEl.value);
    }

    // Reset progress/error state
    const progressEl = sel("editTemplateProgress");
    if (progressEl) { progressEl.textContent = ""; progressEl.hidden = true; }

    if (modal) modal.hidden = false;
  }

  function _syncEditFormatFields(format) {
    const field2x6 = sel("editField2x6");
    const field4x6 = sel("editField4x6");
    const fieldPreview = sel("editFieldPreviewOverlay");
    const previewLabel = sel("editPreviewOverlayLabel");
    const previewHint  = sel("editPreviewOverlayHint");
    const fieldFlipbook = sel("editFieldFlipbook");

    const isFlipbook = format === "flipbook";

    // New frame types reuse the 2×6 file field with an updated label
    const isNew = ["long-duo", "long-mini", "film-duo", "wide-mini"].includes(format);

    if (field2x6) field2x6.style.display = (format === "2x6" || isNew) ? "" : "none";
    if (field4x6) field4x6.style.display = format === "4x6" ? "" : "none";
    if (fieldFlipbook) fieldFlipbook.style.display = isFlipbook ? "" : "none";

    // Update the label inside the 2x6 field when a new format is selected
    if (field2x6) {
      const lbl = field2x6.querySelector("label");
      if (lbl) {
        lbl.textContent = isNew
          ? `Replace Frame PNG — ${FORMAT_LABELS[format] || format}`
          : "Replace Frame PNG — 2×6";
      }
      const hint = field2x6.querySelector(".form-hint");
      if (hint) {
        hint.textContent = isNew
          ? `Upload a full 2400×3600 px overlay PNG at 600 DPI for the ${FORMAT_LABELS[format] || format} frame.`
          : "Leave blank to keep the existing overlay. Single strip at 1200×3600px, 600dpi — kiosk mirrors into two-strip print automatically.";
      }
    }

    // Strip preview overlay field — shown only for new frame types
    if (fieldPreview) fieldPreview.style.display = isNew ? "" : "none";
    if (isNew) {
      const dims = PREVIEW_DIMS[format] || "see format spec";
      if (previewLabel) {
        // Preserve the <span> for editCurrentPreviewOverlay inside the label
        const spanEl = previewLabel.querySelector
          ? previewLabel.querySelector("#editCurrentPreviewOverlay")
          : sel("editCurrentPreviewOverlay");
        // Set first text node only, keeping the span
        if (previewLabel.childNodes.length > 0) {
          previewLabel.childNodes[0].textContent = `Replace Strip Preview Overlay — ${FORMAT_LABELS[format] || format} `;
        } else {
          previewLabel.textContent = `Replace Strip Preview Overlay — ${FORMAT_LABELS[format] || format}`;
        }
      }
      if (previewHint) {
        previewHint.innerHTML =
          `Leave blank to keep the existing preview overlay. ` +
          `Upload a PNG at <strong>${dims}</strong> — sized for the strip preview canvas, not the full print sheet.`;
      }
    }
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

      const nameEl     = sel("editTemplateName");
      const categoryEl = sel("editTemplateCategory");
      const formatEl   = sel("editTemplateFormat");
      const f2El       = sel("editTemplateFile2x6");
      const f4El       = sel("editTemplateFile4x6");
      const fThEl      = sel("editTemplateFileThumb");
      const fPvEl      = sel("editTemplateFilePreviewOverlay");
      const fFbCoverEl = sel("editTemplateFileFlipbookCover");
      const fFbA1El    = sel("editTemplateFileFlipbookA4Page1");
      const fFbA2El    = sel("editTemplateFileFlipbookA4Page2");
      const fFbPvEl    = sel("editTemplateFileFlipbookPreview");

      const newName     = nameEl     ? nameEl.value.trim()     : "";
      const newCategory = categoryEl ? categoryEl.value.trim() : "Originals";
      const newFormat   = formatEl   ? formatEl.value          : "2x6";

      // Only the file field for the active format is used
      const newFile2x6     = (newFormat === "2x6"       && f2El) ? (f2El.files[0] || null) : null;
      const newFile4x6     = (newFormat === "4x6"       && f4El) ? (f4El.files[0] || null) : null;
      const newFileLongDuo = (newFormat === "long-duo"  && f2El) ? (f2El.files[0] || null) : null;
      const newFileLongMini= (newFormat === "long-mini" && f2El) ? (f2El.files[0] || null) : null;
      const newFileFilmDuo = (newFormat === "film-duo"  && f2El) ? (f2El.files[0] || null) : null;
      const newFileWideMini= (newFormat === "wide-mini" && f2El) ? (f2El.files[0] || null) : null;
      const newThumb    = fThEl ? (fThEl.files[0] || null) : null;

      // Strip preview overlay — only applicable for new frame types
      const isNewFormat = ["long-duo", "long-mini", "film-duo", "wide-mini"].includes(newFormat);
      const newPreviewOverlay = (isNewFormat && fPvEl) ? (fPvEl.files[0] || null) : null;

      // Flipbook — 3 independent slots, each replaceable independently.
      // Leaving any of the 3 blank keeps that slot's existing asset.
      const isFlipbookFormat = newFormat === "flipbook";
      const newFileFlipbookCover   = (isFlipbookFormat && fFbCoverEl) ? (fFbCoverEl.files[0] || null) : null;
      const newFileFlipbookA4Page1 = (isFlipbookFormat && fFbA1El)    ? (fFbA1El.files[0]    || null) : null;
      const newFileFlipbookA4Page2 = (isFlipbookFormat && fFbA2El)    ? (fFbA2El.files[0]    || null) : null;
      // Preview Frame Overlay — optional, screen preview only (not printed).
      const newFileFlipbookPreview = (isFlipbookFormat && fFbPvEl)    ? (fFbPvEl.files[0]    || null) : null;

      if (!newName) { showToast("Template name cannot be empty."); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
      if (progressEl) { progressEl.hidden = false; progressEl.textContent = "Saving…"; }

      try {
        const current = _templates.find((t) => t.id === _editingTemplateId);
        if (!current) throw new Error("Template not found — try refreshing.");

        // Derive storage prefix from whichever overlay path is already set
        let storagePrefix = null;
        const firstPath = current.overlay_path_2x6 || current.overlay_path_4x6 ||
                          current.overlay_path_long_duo || current.overlay_path_long_mini ||
                          current.overlay_path_film_duo || current.overlay_path_wide_mini ||
                          current.overlay_path_flipbook_cover || current.overlay_path_flipbook_a4_1 ||
                          current.overlay_path_flipbook_a4_2  || current.overlay_path_flipbook_preview;
        if (firstPath) {
          storagePrefix = firstPath.replace(/\/overlay_[^/]+\.png$/, "");
        } else if (current.thumbnail_path) {
          storagePrefix = current.thumbnail_path.replace(/\/thumbnail\.[^/]+$/, "");
        }
        if (!storagePrefix) {
          const slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").substring(0, 48);
          storagePrefix = `templates/${slug}-${Date.now()}`;
        }

        // asset_type stores the category value
        const updates = { name: newName, asset_type: newCategory };

        // All overlay path columns not matching the new format are cleared when a
        // new file is uploaded (format switch). This prevents stale paths persisting.
        // Flipbook's 3 slots are NOT included here — they are cleared only when the
        // format switches AWAY from flipbook (see below), never against each other.
        const ALL_OVERLAY_COLS = [
          "overlay_path_2x6", "overlay_path_4x6",
          "overlay_path_long_duo", "overlay_path_long_mini",
          "overlay_path_film_duo", "overlay_path_wide_mini",
          ...FLIPBOOK_OVERLAY_COLS
        ];

        if (newFile2x6) {
          if (progressEl) progressEl.textContent = "Uploading 2×6 overlay…";
          updates.overlay_path_2x6 = await adminTemplates._uploadFile(
            newFile2x6, `${storagePrefix}/overlay_2x6.png`, "image/png"
          );
          // Clear other format columns when format changes
          ALL_OVERLAY_COLS.filter(c => c !== "overlay_path_2x6").forEach(c => {
            if (current[c] && newFormat === "2x6") updates[c] = null;
          });
        }
        if (newFile4x6) {
          if (progressEl) progressEl.textContent = "Uploading 4×6 overlay…";
          updates.overlay_path_4x6 = await adminTemplates._uploadFile(
            newFile4x6, `${storagePrefix}/overlay_4x6.png`, "image/png"
          );
          ALL_OVERLAY_COLS.filter(c => c !== "overlay_path_4x6").forEach(c => {
            if (current[c] && newFormat === "4x6") updates[c] = null;
          });
        }
        if (newFileLongDuo) {
          if (progressEl) progressEl.textContent = "Uploading Long Duo overlay…";
          updates.overlay_path_long_duo = await adminTemplates._uploadFile(
            newFileLongDuo, `${storagePrefix}/overlay_long_duo.png`, "image/png"
          );
          ALL_OVERLAY_COLS.filter(c => c !== "overlay_path_long_duo").forEach(c => {
            if (current[c] && newFormat === "long-duo") updates[c] = null;
          });
        }
        if (newFileLongMini) {
          if (progressEl) progressEl.textContent = "Uploading Long Mini overlay…";
          updates.overlay_path_long_mini = await adminTemplates._uploadFile(
            newFileLongMini, `${storagePrefix}/overlay_long_mini.png`, "image/png"
          );
          ALL_OVERLAY_COLS.filter(c => c !== "overlay_path_long_mini").forEach(c => {
            if (current[c] && newFormat === "long-mini") updates[c] = null;
          });
        }
        if (newFileFilmDuo) {
          if (progressEl) progressEl.textContent = "Uploading Film Duo overlay…";
          updates.overlay_path_film_duo = await adminTemplates._uploadFile(
            newFileFilmDuo, `${storagePrefix}/overlay_film_duo.png`, "image/png"
          );
          ALL_OVERLAY_COLS.filter(c => c !== "overlay_path_film_duo").forEach(c => {
            if (current[c] && newFormat === "film-duo") updates[c] = null;
          });
        }
        if (newFileWideMini) {
          if (progressEl) progressEl.textContent = "Uploading Wide Mini overlay…";
          updates.overlay_path_wide_mini = await adminTemplates._uploadFile(
            newFileWideMini, `${storagePrefix}/overlay_wide_mini.png`, "image/png"
          );
          ALL_OVERLAY_COLS.filter(c => c !== "overlay_path_wide_mini").forEach(c => {
            if (current[c] && newFormat === "wide-mini") updates[c] = null;
          });
        }

        // Flipbook — each of the 3 print slots + optional Preview Frame
        // Overlay is replaced independently; leaving a slot's file input
        // blank keeps that slot's existing asset.
        if (newFileFlipbookCover || newFileFlipbookA4Page1 || newFileFlipbookA4Page2 || newFileFlipbookPreview) {
          if (newFileFlipbookCover) {
            if (progressEl) progressEl.textContent = "Uploading Flipbook — Cover Page…";
            updates.overlay_path_flipbook_cover = await adminTemplates._uploadFile(
              newFileFlipbookCover, `${storagePrefix}/overlay_flipbook_cover.png`, "image/png"
            );
          }
          if (newFileFlipbookA4Page1) {
            if (progressEl) progressEl.textContent = "Uploading Flipbook — A4 Page 1…";
            updates.overlay_path_flipbook_a4_1 = await adminTemplates._uploadFile(
              newFileFlipbookA4Page1, `${storagePrefix}/overlay_flipbook_a4_1.png`, "image/png"
            );
          }
          if (newFileFlipbookA4Page2) {
            if (progressEl) progressEl.textContent = "Uploading Flipbook — A4 Page 2…";
            updates.overlay_path_flipbook_a4_2 = await adminTemplates._uploadFile(
              newFileFlipbookA4Page2, `${storagePrefix}/overlay_flipbook_a4_2.png`, "image/png"
            );
          }
          if (newFileFlipbookPreview) {
            if (progressEl) progressEl.textContent = "Uploading Flipbook — Preview Frame Overlay…";
            updates.overlay_path_flipbook_preview = await adminTemplates._uploadFile(
              newFileFlipbookPreview, `${storagePrefix}/overlay_flipbook_preview.png`, "image/png"
            );
          }
          // Clear non-flipbook overlay columns when switching a template TO
          // flipbook format — never clears sibling flipbook slots.
          ALL_OVERLAY_COLS.filter(c => !FLIPBOOK_OVERLAY_COLS.includes(c)).forEach(c => {
            if (current[c] && newFormat === "flipbook") updates[c] = null;
          });
        }

        // Strip preview overlay — upload if provided (new frame types only)
        if (newPreviewOverlay) {
          const previewStorageName = {
            "long-duo":  "preview_overlay_long_duo.png",
            "long-mini": "preview_overlay_long_mini.png",
            "film-duo":  "preview_overlay_film_duo.png",
            "wide-mini": "preview_overlay_wide_mini.png"
          }[newFormat];
          const previewColumnName = {
            "long-duo":  "preview_overlay_path_long_duo",
            "long-mini": "preview_overlay_path_long_mini",
            "film-duo":  "preview_overlay_path_film_duo",
            "wide-mini": "preview_overlay_path_wide_mini"
          }[newFormat];
          if (previewStorageName && previewColumnName) {
            if (progressEl) progressEl.textContent = `Uploading ${FORMAT_LABELS[newFormat] || newFormat} strip preview overlay…`;
            updates[previewColumnName] = await adminTemplates._uploadFile(
              newPreviewOverlay, `${storagePrefix}/${previewStorageName}`, "image/png"
            );
          }
        }

        if (newThumb) {
          if (progressEl) progressEl.textContent = "Uploading thumbnail…";
          const thumbMime = newThumb.type || "image/png";
          const thumbExt  = thumbMime.includes("jpeg") ? "jpg" : thumbMime.includes("webp") ? "webp" : "png";
          updates.thumbnail_path = await adminTemplates._uploadFile(
            newThumb, `${storagePrefix}/thumbnail.${thumbExt}`, thumbMime
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

  // ── Category filter tabs (Originals / Designs / Accessories / All) ──────────

  function wireCategoryFilter() {
    const tabsEl = document.getElementById("templateCategoryTabs");
    if (!tabsEl) return;

    tabsEl.addEventListener("click", (ev) => {
      const tab = ev.target.closest(".template-category-tab");
      if (!tab) return;

      const cat = tab.dataset.category;
      if (cat === undefined || cat === _activeCategory) return;

      _activeCategory = cat;

      tabsEl.querySelectorAll(".template-category-tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.category === cat);
      });

      renderTemplateList(_templates);
      _updateTemplateCount();
    });
  }

  // ── Format filter pills (All / 2×6 / 4×6) ──────────────────────────────────

  function wireFormatFilter() {
    const pillsEl = document.getElementById("templateFormatPills");
    if (!pillsEl) return;

    pillsEl.addEventListener("click", (ev) => {
      const pill = ev.target.closest(".template-format-pill");
      if (!pill) return;

      const fmt = pill.dataset.format;
      if (fmt === undefined || fmt === _activeFormat) return;

      _activeFormat = fmt;

      pillsEl.querySelectorAll(".template-format-pill").forEach((p) => {
        p.classList.toggle("active", p.dataset.format === fmt);
      });

      renderTemplateList(_templates);
      _updateTemplateCount();
    });
  }

  function _updateTemplateCount() {
    const countEl = document.getElementById("templateCount");
    if (!countEl) return;

    // Re-use the same format/category helpers used by renderTemplateList
    function _fmt(t) {
      if (t.overlay_path_2x6)       return "2x6";
      if (t.overlay_path_4x6)       return "4x6";
      if (t.overlay_path_long_duo)  return "long-duo";
      if (t.overlay_path_long_mini) return "long-mini";
      if (t.overlay_path_film_duo)  return "film-duo";
      if (t.overlay_path_wide_mini) return "wide-mini";
      if (t.overlay_path_flipbook_cover || t.overlay_path_flipbook_a4_1 || t.overlay_path_flipbook_a4_2) return "flipbook";
      return null;
    }

    const visible = _templates.filter((t) => {
      const fmt = _fmt(t);
      const cat = CATEGORIES.includes((t.asset_type || "").trim()) ? t.asset_type.trim() : "Originals";
      const catMatch = _activeCategory === "all" || cat === _activeCategory;
      const fmtMatch = _activeFormat   === "all" || fmt === _activeFormat;
      return catMatch && fmtMatch;
    });
    countEl.textContent = visible.length
      ? `${visible.length} template${visible.length !== 1 ? "s" : ""}`
      : "";
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
      const categoryEl = sel("templateCategory");
      const formatEl   = sel("templateFormat");
      const f2El       = sel("templateFile2x6");
      const f4El       = sel("templateFile4x6");
      const fThEl      = sel("templateFileThumb");
      const fPvEl      = sel("templateFilePreviewOverlay");
      const fFbCoverEl = sel("templateFileFlipbookCover");
      const fFbA1El    = sel("templateFileFlipbookA4Page1");
      const fFbA2El    = sel("templateFileFlipbookA4Page2");
      const fFbPvEl    = sel("templateFileFlipbookPreview");

      if (nameEl)     nameEl.value = "";
      if (categoryEl) categoryEl.value = _activeCategory !== "all" ? _activeCategory : "Originals";
      if (f2El)       f2El.value = "";
      if (f4El)       f4El.value = "";
      if (fThEl)      fThEl.value = "";
      if (fPvEl)      fPvEl.value = "";
      if (fFbCoverEl) fFbCoverEl.value = "";
      if (fFbA1El)    fFbA1El.value = "";
      if (fFbA2El)    fFbA2El.value = "";
      if (fFbPvEl)    fFbPvEl.value = "";
      if (progressEl) { progressEl.textContent = ""; progressEl.hidden = true; }

      // Default format to the active filter, or 2x6 if "all"
      const defaultFmt = _activeFormat !== "all" ? _activeFormat : "2x6";
      if (formatEl) {
        formatEl.value = defaultFmt;
        _syncUploadFormatFields(defaultFmt);
      }

      modal.hidden = false;
    });

    // When the format select changes, show the matching file field
    const formatEl = sel("templateFormat");
    if (formatEl) {
      formatEl.addEventListener("change", () => _syncUploadFormatFields(formatEl.value));
    }

    cancelBtn.addEventListener("click", () => { modal.hidden = true; });

    submitBtn.addEventListener("click", async () => {
      console.log("[templateManager] Upload submit clicked.");

      let name, category, format, file2x6, file4x6, thumbFile;
      let fileFlipbookCover, fileFlipbookA4Page1, fileFlipbookA4Page2, fileFlipbookPreview;
      try {
        const nameEl     = sel("templateName");
        const categoryEl = sel("templateCategory");
        const formatEl   = sel("templateFormat");
        const f2El       = sel("templateFile2x6");
        const f4El       = sel("templateFile4x6");
        const fThEl      = sel("templateFileThumb");
        const fFbCoverEl = sel("templateFileFlipbookCover");
        const fFbA1El    = sel("templateFileFlipbookA4Page1");
        const fFbA2El    = sel("templateFileFlipbookA4Page2");
        const fFbPvEl    = sel("templateFileFlipbookPreview");

        if (!nameEl || !categoryEl || !formatEl) {
          throw new Error("Upload form fields not found in the page — try a hard refresh (Ctrl+Shift+R).");
        }

        name      = nameEl.value.trim();
        category  = categoryEl.value;   // "Originals" | "Designs" | "Accessories" | "Flipbook"
        format    = formatEl.value;     // "2x6" | "4x6" | "long-duo" | "long-mini" | "film-duo" | "wide-mini" | "flipbook"

        // All single-file formats share one file field (#templateFile2x6) in the
        // upload modal. f2El is repurposed to accept the overlay for any of them.
        const uploadFileEl = f2El || f4El;
        const uploadFile = uploadFileEl ? (uploadFileEl.files[0] || null) : null;
        file2x6   = (format === "2x6" ) ? uploadFile : null;
        file4x6   = (format === "4x6" ) ? uploadFile : null;
        thumbFile = fThEl ? (fThEl.files[0] || null) : null;

        // Flipbook has its own dedicated slot fields, not the shared field above.
        // Preview Frame Overlay is optional (screen preview only, never printed).
        fileFlipbookCover   = fFbCoverEl ? (fFbCoverEl.files[0] || null) : null;
        fileFlipbookA4Page1 = fFbA1El    ? (fFbA1El.files[0]    || null) : null;
        fileFlipbookA4Page2 = fFbA2El    ? (fFbA2El.files[0]    || null) : null;
        fileFlipbookPreview = fFbPvEl    ? (fFbPvEl.files[0]    || null) : null;
      } catch (e) {
        console.error("[templateManager] Could not read upload form:", e);
        showToast(`Could not read upload form: ${e.message}`);
        return;
      }

      if (!name) { showToast("Please enter a template name."); return; }

      if (format === "flipbook") {
        // All 3 slots are required on first upload — a partial flipbook can't print.
        if (!fileFlipbookCover || !fileFlipbookA4Page1 || !fileFlipbookA4Page2) {
          showToast("Please select all 3 files: Cover Page, A4 Page 1, and A4 Page 2.");
          return;
        }
      } else {
        // For single-file formats, the file is still required — check that one was selected
        const uploadFileEl2 = sel("templateFile2x6") || sel("templateFile4x6");
        const uploadedFile  = uploadFileEl2 ? (uploadFileEl2.files[0] || null) : null;
        if (!file2x6 && !file4x6 && !uploadedFile) {
          showToast(`Please select a frame PNG file for the ${FORMAT_LABELS[format] || format} format.`);
          return;
        }
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Uploading…";
      if (progressEl) { progressEl.hidden = false; progressEl.textContent = "Uploading files…"; }

      try {
        // Build the format-specific file payload
        const formatFileKey = {
          "2x6":      "file2x6",
          "4x6":      "file4x6",
          "long-duo": "fileLongDuo",
          "long-mini":"fileLongMini",
          "film-duo": "fileFilmDuo",
          "wide-mini":"fileWideMini"
        }[format];

        // Preview overlay payload key for new frame types
        const previewFormatFileKey = {
          "long-duo": "previewFileLongDuo",
          "long-mini":"previewFileLongMini",
          "film-duo": "previewFileFilmDuo",
          "wide-mini":"previewFileWideMini"
        }[format] || null;

        // The upload form uses #templateFile2x6 as the shared file field for
        // single-file formats only (not flipbook, which has its own 3 fields).
        const sharedFileEl = sel("templateFile2x6") || sel("templateFile4x6");
        const sharedFile   = sharedFileEl ? (sharedFileEl.files[0] || null) : null;

        // Strip preview overlay file (optional, new frame types only)
        const fPvEl      = sel("templateFilePreviewOverlay");
        const previewFile = fPvEl ? (fPvEl.files[0] || null) : null;

        const uploadPayload = { name, assetType: category, thumbFile };
        if (format === "2x6")       uploadPayload.file2x6      = file2x6      || sharedFile;
        else if (format === "4x6")  uploadPayload.file4x6      = file4x6      || sharedFile;
        else if (format === "flipbook") {
          uploadPayload.fileFlipbookCover   = fileFlipbookCover;
          uploadPayload.fileFlipbookA4Page1 = fileFlipbookA4Page1;
          uploadPayload.fileFlipbookA4Page2 = fileFlipbookA4Page2;
          uploadPayload.fileFlipbookPreview = fileFlipbookPreview;
        }
        else if (formatFileKey)     uploadPayload[formatFileKey] = sharedFile;

        // Attach preview overlay if provided for a new frame type
        if (previewFormatFileKey && previewFile) {
          uploadPayload[previewFormatFileKey] = previewFile;
        }

        // category is stored in the asset_type column
        await adminTemplates.uploadTemplate(uploadPayload);
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

  // ── Upload format field sync helper ────────────────────────────────────────

  // Per-format preview canvas size labels for the upload/edit hints
  const PREVIEW_DIMS = {
    "long-duo":  "1200 × 3600 px",
    "long-mini": "1200 × 3600 px",
    "film-duo":  "1200 × 3600 px",
    "wide-mini": "2400 × 1800 px"
  };

  function _syncUploadFormatFields(format) {
    const field2x6    = sel("uploadField2x6");
    const field4x6    = sel("uploadField4x6");
    const fieldNew    = sel("uploadFieldNew");
    const fieldNewLabel = sel("uploadFieldNewLabel");
    const fieldNewHint  = sel("uploadFieldNewHint");
    const fieldPreview      = sel("uploadFieldPreviewOverlay");
    const previewLabel      = sel("uploadPreviewOverlayLabel");
    const previewHint       = sel("uploadPreviewOverlayHint");
    const fieldFlipbook     = sel("uploadFieldFlipbook");
    const fieldThumb        = sel("uploadFieldThumb");

    const isFlipbook = format === "flipbook";

    // Standard formats use their own dedicated field; new formats reuse #uploadField2x6
    // with an updated label/hint via the shared #uploadFieldNew wrapper.
    const isNew = ["long-duo", "long-mini", "film-duo", "wide-mini"].includes(format);

    if (field2x6) field2x6.style.display = (format === "2x6" || isNew) ? "" : "none";
    if (field4x6) field4x6.style.display = format === "4x6" ? "" : "none";
    if (fieldFlipbook) fieldFlipbook.style.display = isFlipbook ? "" : "none";
    // Thumbnail stays optional/available for every format, including flipbook.
    if (fieldThumb) fieldThumb.style.display = "";

    // Update label and hint for new frame types (reuse the 2x6 field)
    if (isNew && fieldNewLabel) {
      fieldNewLabel.textContent = `Frame PNG — ${FORMAT_LABELS[format] || format}`;
    }
    if (isNew && fieldNewHint) {
      fieldNewHint.textContent = `Upload a full 2400×3600 px overlay PNG at 600 DPI for the ${FORMAT_LABELS[format] || format} frame.`;
    } else if (!isNew && field2x6) {
      // Restore the original 2×6 label/hint when switching back
      const lbl = field2x6.querySelector("label");
      if (lbl && format === "2x6") lbl.textContent = "Frame PNG — 2×6";
    }

    // Strip preview overlay field — shown only for new frame types
    if (fieldPreview) fieldPreview.style.display = isNew ? "" : "none";
    if (isNew) {
      const dims = PREVIEW_DIMS[format] || "see format spec";
      if (previewLabel) {
        previewLabel.textContent = `Strip Preview Overlay — ${FORMAT_LABELS[format] || format} (optional)`;
      }
      if (previewHint) {
        previewHint.innerHTML =
          `Upload a PNG overlay at <strong>${dims}</strong> sized for the <strong>strip preview canvas</strong> — ` +
          `not the full 2400×3600 print sheet. Shown on Photo Selection and Print &amp; QR screens. ` +
          `Leave blank to use the full-frame overlay cropped to the preview region instead.`;
      }
    }
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
      _updateTemplateCount();
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

    // Update the active-filter status banner above the grid
    _updateActiveFilterBanner();

    _filters.forEach((filter, index) => {
      const card = document.createElement("div");
      const isActive = !!filter.active;
      card.className = "filter-admin-card" + (isActive ? " filter-admin-card--active" : "");
      card.dataset.id = filter.id;

      card.innerHTML = `
        <div class="filter-admin-header">
          <span class="filter-admin-name">${escapeHtml(filter.name)}</span>
          <span class="filter-admin-format">.${filter.format}</span>
        </div>
        ${isActive ? `<div class="filter-admin-active-badge">● Active on kiosk</div>` : ""}
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
          <button class="btn-admin ${isActive ? "btn-admin-primary" : "btn-admin-outline"} btn-sm" data-action="set-active-filter">
            ${isActive ? "✓ Active" : "Set Active"}
          </button>
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

      // Set Active button — only one filter active at a time
      card.querySelector('[data-action="set-active-filter"]').addEventListener("click", () => {
        if (filter.active) {
          // Already active — clicking again removes the active flag
          filter.active = false;
        } else {
          // Deactivate all others, activate this one
          _filters.forEach((f) => { f.active = false; });
          filter.active = true;
        }
        saveFilters();
        renderFilterList(); // re-render cards to update badge + button state
        const activeFilter = _filters.find((f) => f.active) || null;
        showToast(filter.active
          ? `"${filter.name}" is now active on the kiosk.`
          : `Filter removed — no filter active.`
        );
        // Notify kiosk filter engine with the single active filter (or null)
        document.dispatchEvent(new CustomEvent("studrio:activeFilterChanged", {
          detail: { activeFilter }
        }));
      });

      // Preview button — opens a full-size preview modal
      card.querySelector('[data-action="preview-filter"]').addEventListener("click", () => {
        showFilterPreviewModal(filter);
      });

      // Delete button
      card.querySelector('[data-action="delete-filter"]').addEventListener("click", () => {
        if (!confirm(`Delete filter "${filter.name}"?`)) return;
        // If we're deleting the active filter, clear active state
        const wasActive = !!filter.active;
        _filters.splice(index, 1);
        saveFilters(); // saves locally + pushes to Supabase in background
        renderFilterList();
        showToast(`Filter "${filter.name}" deleted.`);
        // Notify kiosk filter engine
        document.dispatchEvent(new CustomEvent("studrio:filtersUpdated", { detail: { filters: _filters } }));
        if (wasActive) {
          document.dispatchEvent(new CustomEvent("studrio:activeFilterChanged", { detail: { activeFilter: null } }));
        }
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

  // ── Active filter banner helper ─────────────────────────────────────────────

  function _updateActiveFilterBanner() {
    const bannerEl = document.getElementById("filterActiveStatus");
    const nameEl   = document.getElementById("filterActiveName");
    if (!bannerEl || !nameEl) return;

    const active = _filters.find((f) => f.active) || null;
    if (active) {
      nameEl.textContent = `Active filter: ${active.name} (.${active.format})`;
      bannerEl.hidden = false;
    } else {
      bannerEl.hidden = true;
    }
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
    // ── "Remove Active" button in the active-filter status banner ─────────────
    const clearActiveBtn = document.getElementById("btnClearActiveFilter");
    if (clearActiveBtn) {
      clearActiveBtn.addEventListener("click", () => {
        _filters.forEach((f) => { f.active = false; });
        saveFilters();
        renderFilterList();
        showToast("Filter removed — no filter active on kiosk.");
        document.dispatchEvent(new CustomEvent("studrio:activeFilterChanged", { detail: { activeFilter: null } }));
      });
    }

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
          const activeFilter = _filters.find((f) => f.active) || null;
          document.dispatchEvent(new CustomEvent("studrio:activeFilterChanged", { detail: { activeFilter } }));

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
      if (!["lut", "cube", "xmp"].includes(format)) {
        showToast("Only .lut, .cube, and .xmp files are supported.");
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

      <!-- ── Category tabs ─────────────────────────────────────────────── -->
      <div class="template-category-tabs" id="templateCategoryTabs">
        <button class="template-category-tab active" data-category="all"         type="button">All</button>
        <button class="template-category-tab"        data-category="Originals"   type="button">Originals</button>
        <button class="template-category-tab"        data-category="Designs"     type="button">Designs</button>
        <button class="template-category-tab"        data-category="Accessories" type="button">Accessories</button>
        <button class="template-category-tab"        data-category="Flipbook"    type="button">Flipbook</button>
      </div>

      <!-- ── Format pills ──────────────────────────────────────────────── -->
      <div class="template-filter-row">
        <span class="template-filter-label">Format:</span>
        <div class="template-format-pills" id="templateFormatPills">
          <button class="template-format-pill active" data-format="all"       type="button">All</button>
          <button class="template-format-pill"        data-format="2x6"       type="button">2×6</button>
          <button class="template-format-pill"        data-format="4x6"       type="button">4×6</button>
          <button class="template-format-pill"        data-format="long-duo"  type="button">Long Duo</button>
          <button class="template-format-pill"        data-format="long-mini" type="button">Long Mini</button>
          <button class="template-format-pill"        data-format="film-duo"  type="button">Film Duo</button>
          <button class="template-format-pill"        data-format="wide-mini" type="button">Wide Mini</button>
          <button class="template-format-pill"        data-format="flipbook"  type="button">Flipbook</button>
        </div>
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
              <label for="editTemplateCategory">Frame Category</label>
              <select id="editTemplateCategory">
                <option value="Originals">Originals</option>
                <option value="Designs">Designs</option>
                <option value="Accessories">Accessories</option>
                <option value="Flipbook">Flipbook</option>
              </select>
            </div>

            <div class="form-field">
              <label for="editTemplateFormat">Frame Format</label>
              <select id="editTemplateFormat">
                <option value="2x6">2×6 (Long Frame)</option>
                <option value="4x6">4×6 (Wide Frame)</option>
                <option value="long-duo">Long Duo</option>
                <option value="long-mini">Long Mini</option>
                <option value="film-duo">Film Duo</option>
                <option value="wide-mini">Wide Mini</option>
                <option value="flipbook">Flipbook (3 Slots)</option>
              </select>
              <p class="form-hint">Changing the format and uploading a new file will switch this template to the new format. The old overlay file will be cleared.</p>
            </div>

            <!-- Shown when format = 2x6 -->
            <div class="form-field" id="editField2x6">
              <label for="editTemplateFile2x6">
                Replace Frame PNG — 2×6
                <span class="edit-current-label" id="editCurrentFile"></span>
              </label>
              <input type="file" id="editTemplateFile2x6" accept=".png,image/png">
              <p class="form-hint">Leave blank to keep the existing overlay. Single strip at 1200×3600px, 600dpi — kiosk mirrors into two-strip print automatically.</p>
            </div>

            <!-- Shown when format = 4x6 -->
            <div class="form-field" id="editField4x6" style="display:none">
              <label for="editTemplateFile4x6">
                Replace Frame PNG — 4×6
              </label>
              <input type="file" id="editTemplateFile4x6" accept=".png,image/png">
              <p class="form-hint">
                Leave blank to keep the existing overlay. Upload at <strong>2400×3600 px, 600 DPI</strong>.<br>
                <strong>Accessories (Keychain) templates:</strong> upload the
                <strong>Mini-Strip overlay PNG at 591×1795 px, 600 DPI</strong>.
                Applied to both Mini-Strip frames on the keychain print sheet automatically.
              </p>
            </div>

            <!-- Strip preview overlay — shown for new frame formats only -->
            <div class="form-field" id="editFieldPreviewOverlay" style="display:none">
              <label for="editTemplateFilePreviewOverlay" id="editPreviewOverlayLabel">
                Replace Strip Preview Overlay
                <span class="edit-current-label" id="editCurrentPreviewOverlay"></span>
              </label>
              <input type="file" id="editTemplateFilePreviewOverlay" accept=".png,image/png">
              <p class="form-hint" id="editPreviewOverlayHint">
                Leave blank to keep the existing preview overlay. This PNG is shown on the
                Photo Selection and Print &amp; QR preview screens only — not used for print.
              </p>
            </div>

            <!-- Flipbook — 3 independent slots, shown when format = flipbook -->
            <div class="form-field" id="editFieldFlipbook" style="display:none">
              <p class="form-hint" style="margin-top:0;">
                Each slot below is replaced independently — leaving a slot blank keeps its existing file.
              </p>

              <label for="editTemplateFileFlipbookCover">
                Replace Cover Page
                <span class="edit-current-label" id="editCurrentFlipbookCover"></span>
              </label>
              <input type="file" id="editTemplateFileFlipbookCover" accept=".png,image/png">
              <p class="form-hint">1200 × 666 px, 300 DPI.</p>

              <label for="editTemplateFileFlipbookA4Page1" style="margin-top:0.75rem;display:block;">
                Replace A4 Page 1
                <span class="edit-current-label" id="editCurrentFlipbookA4Page1"></span>
              </label>
              <input type="file" id="editTemplateFileFlipbookA4Page1" accept=".png,image/png">
              <p class="form-hint">2480 × 3508 px, 300 DPI — sheet 1: cover + flipbook pages 1–9.</p>

              <label for="editTemplateFileFlipbookA4Page2" style="margin-top:0.75rem;display:block;">
                Replace A4 Page 2
                <span class="edit-current-label" id="editCurrentFlipbookA4Page2"></span>
              </label>
              <input type="file" id="editTemplateFileFlipbookA4Page2" accept=".png,image/png">
              <p class="form-hint">2480 × 3508 px, 300 DPI — sheet 2: flipbook pages 10–19.</p>

              <label for="editTemplateFileFlipbookPreview" style="margin-top:0.75rem;display:block;">
                Replace Preview Frame Overlay (optional)
                <span class="edit-current-label" id="editCurrentFlipbookPreview"></span>
              </label>
              <input type="file" id="editTemplateFileFlipbookPreview" accept=".png,image/png">
              <p class="form-hint">1060 × 666 px — decorative frame shown around the video on the Video Selection and Print &amp; QR screens only; never printed. Leave blank for no frame graphic.</p>
            </div>

            <!-- Thumbnail field — always visible -->
            <div class="form-field">
              <label for="editTemplateFileThumb">
                Replace Thumbnail
                <span class="edit-current-label" id="editCurrentThumb"></span>
              </label>
              <input type="file" id="editTemplateFileThumb" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp">
              <p class="form-hint">Leave blank to keep the existing thumbnail. Recommended 300×450px PNG.</p>
            </div>

            <p class="form-hint template-edit-version-note">
              Replacing the file will bump the template's version number so all kiosks re-download the updated asset automatically.
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
          <h3 class="admin-modal-title">Upload Template</h3>

          <div id="templateUploadForm" class="template-upload-form">

            <div class="form-field">
              <label for="templateName">Template name</label>
              <input type="text" id="templateName" placeholder="e.g. Miffy 2×6" maxlength="80">
            </div>

            <div class="form-field">
              <label for="templateCategory">Frame Category</label>
              <select id="templateCategory">
                <option value="Originals">Originals</option>
                <option value="Designs">Designs</option>
                <option value="Accessories">Accessories</option>
                <option value="Flipbook">Flipbook</option>
              </select>
            </div>

            <div class="form-field">
              <label for="templateFormat">Frame Format</label>
              <select id="templateFormat">
                <option value="2x6">2×6 (Long Frame)</option>
                <option value="4x6">4×6 (Wide Frame)</option>
                <option value="long-duo">Long Duo</option>
                <option value="long-mini">Long Mini</option>
                <option value="film-duo">Film Duo</option>
                <option value="wide-mini">Wide Mini</option>
                <option value="flipbook">Flipbook (3 Slots)</option>
              </select>
            </div>

            <!-- Overlay upload field — shown for 2×6 and all new frame formats -->
            <div class="form-field" id="uploadField2x6">
              <label for="templateFile2x6" id="uploadFieldNewLabel">Frame PNG — 2×6</label>
              <input type="file" id="templateFile2x6" accept=".png,image/png">
              <p class="form-hint" id="uploadFieldNewHint">Upload a <strong>single strip</strong> at 1200×3600px, 600dpi. The kiosk mirrors it into a two-strip print layout automatically.</p>
            </div>

            <!-- 4×6 upload field — shown when format = 4x6 -->
            <div class="form-field" id="uploadField4x6" style="display:none">
              <label for="templateFile4x6">Frame PNG — 4×6</label>
              <input type="file" id="templateFile4x6" accept=".png,image/png">
              <p class="form-hint">
                Upload at <strong>2400×3600 px, 600 DPI</strong>.<br>
                <strong>Accessories (Keychain) templates:</strong> upload the
                <strong>Mini-Strip overlay PNG at 591×1795 px, 600 DPI</strong>.
                The kiosk uses this overlay for both Mini-Strip frames on the right half
                of the keychain print sheet. The left half (2×6 strip) always uses the
                standard 2×6 photo slot positions — no separate overlay needed for it.
              </p>
            </div>

            <!-- Strip preview overlay — shown for new frame formats only -->
            <div class="form-field" id="uploadFieldPreviewOverlay" style="display:none">
              <label for="templateFilePreviewOverlay" id="uploadPreviewOverlayLabel">Strip Preview Overlay (optional)</label>
              <input type="file" id="templateFilePreviewOverlay" accept=".png,image/png">
              <p class="form-hint" id="uploadPreviewOverlayHint">
                Upload a PNG overlay sized to the <strong>strip preview canvas</strong> only —
                not the full 2400×3600 print sheet. This overlay is shown on the Photo Selection
                and Print &amp; QR preview screens. Leave blank to use the full-frame overlay
                cropped to the preview region instead.
              </p>
            </div>

            <!-- Flipbook — 3 independent slots, shown when format = flipbook -->
            <div class="form-field" id="uploadFieldFlipbook" style="display:none">
              <label for="templateFileFlipbookCover">Cover Page</label>
              <input type="file" id="templateFileFlipbookCover" accept=".png,image/png">
              <p class="form-hint">1200 × 666 px, 300 DPI.</p>

              <label for="templateFileFlipbookA4Page1" style="margin-top:0.75rem;display:block;">A4 Page 1</label>
              <input type="file" id="templateFileFlipbookA4Page1" accept=".png,image/png">
              <p class="form-hint">2480 × 3508 px, 300 DPI — sheet 1: cover + flipbook pages 1–9.</p>

              <label for="templateFileFlipbookA4Page2" style="margin-top:0.75rem;display:block;">A4 Page 2</label>
              <input type="file" id="templateFileFlipbookA4Page2" accept=".png,image/png">
              <p class="form-hint">2480 × 3508 px, 300 DPI — sheet 2: flipbook pages 10–19. These 3 files are required.</p>

              <label for="templateFileFlipbookPreview" style="margin-top:0.75rem;display:block;">Preview Frame Overlay (optional)</label>
              <input type="file" id="templateFileFlipbookPreview" accept=".png,image/png">
              <p class="form-hint">1060 × 666 px — decorative frame shown around the video on the Video Selection and Print &amp; QR screens only; never printed. Leave blank for no frame graphic.</p>
            </div>

            <!-- Thumbnail upload field — always visible -->
            <div class="form-field" id="uploadFieldThumb">
              <label for="templateFileThumb">Thumbnail (optional)</label>
              <input type="file" id="templateFileThumb" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp">
              <p class="form-hint">Small preview image shown in the kiosk design picker. Recommended 300×450px PNG. Leave blank to skip.</p>
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
      <!-- ── Accessories: Mini-Strip Keychain ──────────────────────────── -->
      <!-- ══════════════════════════════════════════════════════════════════ -->
      <div class="keychain-admin-section" style="margin-top:2rem;">
        <div class="gallery-section-head">
          <div class="gallery-section-head-left">
            <h2>Accessories — Mini-Strip Keychain</h2>
          </div>
        </div>
        <p class="form-hint" style="margin-bottom:1rem;">
          Keychain templates are uploaded independently under the
          <strong>Accessories</strong> category — no linking to a regular template is needed.
          Each keychain template is a standalone 4×6 frame (2400×3600 px) that the kiosk
          renders as: <strong>1pc 2×6 strip</strong> (left half) +
          <strong>2pcs Mini-Strip frames</strong> (right half).
        </p>
        <div class="keychain-admin-info-box" style="background:#fffbee;border:1.5px solid #F0C231;border-radius:12px;padding:1rem 1.2rem;font-size:0.92rem;color:#555;">
          <strong style="color:#1a1200;">How to add a Keychain template:</strong>
          <ol style="margin:0.5rem 0 0 1.2rem;padding:0;line-height:1.8;">
            <li>Click <strong>+ Upload Template</strong> above.</li>
            <li>Set <strong>Frame Category</strong> to <em>Accessories</em>.</li>
            <li>Set <strong>Frame Format</strong> to <em>4×6</em>.</li>
            <li>Upload the Mini-Strip overlay PNG — <strong>591×1795 px at 600 DPI</strong>. One file is used for both Mini-Strip frames automatically.</li>
            <li>Click <strong>Upload</strong>. The kiosk will sync automatically.</li>
          </ol>
          <p style="margin:0.6rem 0 0;">
            <strong>Canvas layout (2400×3600 px @ 600 DPI):</strong><br>
            Left half — 2×6 strip: 4 photos at the standard 2×6 slot positions + QR code.<br>
            Right half — 2× Mini-Strip frames side by side, each composited with the uploaded overlay.<br>
            The 2×6 strip on the left uses the same photo layout as a standard 2×6 template.
          </p>
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
        <p class="form-hint" style="margin-bottom:0.75rem;">Upload <code>.lut</code>, <code>.cube</code>, or <code>.xmp</code> colour-grading files. Adjust each filter's strength with the opacity slider. Only one filter can be active for the kiosk at a time. Filters are saved to Supabase and sync to the kiosk automatically.</p>
        <div class="filter-active-status" id="filterActiveStatus" hidden>
          <span class="filter-active-dot"></span>
          <span id="filterActiveName">No active filter</span>
          <button class="btn-admin btn-admin-ghost btn-sm" id="btnClearActiveFilter" type="button">Remove Active</button>
        </div>
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
              <label for="filterFile">Filter file (.lut, .cube, or .xmp)</label>
              <input type="file" id="filterFile" accept=".lut,.cube,.xmp">
              <p class="form-hint">Supports standard 1D/3D LUT files in .lut or .cube format, and Adobe Camera Raw colour presets in .xmp format.</p>
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
      wireCategoryFilter();
      wireFormatFilter();
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
