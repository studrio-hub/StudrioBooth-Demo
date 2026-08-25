/*
 * SELECTION LOGIC — Page 4  (v3)
 *
 * Changes from v2 (crash fix — "page lags/errors right after the 4th photo"):
 *
 *  ROOT CAUSE #1 — full grid teardown on every tap:
 *   renderGrid() used to wipe #selectionGrid's innerHTML and recreate all
 *   8 <img> cards (+ re-attach 8 click listeners) on EVERY single tap, just
 *   to update one badge/class. That meant every photo was re-decoded by the
 *   browser on every tap, and old event listeners were only cleaned up by
 *   GC — never guaranteed to happen promptly. Fixed by building the 8 cards
 *   ONCE (per session, on init()) and afterwards only updating the
 *   `.selected` class + order-badge text/visibility in place. Listeners are
 *   attached exactly once per card per session — no duplicates.
 *
 *  ROOT CAUSE #2 — unthrottled concurrent preview renders:
 *   renderPreview() -> stripModule.render() is async (full-resolution
 *   2400×3600 canvas compositing) but was never awaited by toggleShot().
 *   Fast taps fired a new render() before the previous one had finished,
 *   so several heavy composites ran concurrently, all racing to write into
 *   the same preview container. Because the 4th tap is the first time all
 *   4 slots hold *real* photos (vs. cheap placeholder outlines for empty
 *   slots), that's exactly where the pile-up became heavy enough to freeze
 *   the page. Fixed with a single-flight queue in _queuePreviewRender():
 *   only one stripModule.render() call is ever in flight for the preview;
 *   any taps that land while one is running are coalesced into a single
 *   follow-up render of the latest state (see also the generation guard
 *   added inside stripModule.render() itself, as defense in depth).
 *
 *  Selection behavior (toggleShot, selectionOrder, limit flash,
 *  autoComplete, strip preview, badge numbering) is unchanged — only the
 *  DOM/async plumbing around it was tightened.
 */

const selectionModule = {
  els: {
    grid: document.getElementById("selectionGrid"),
    previewContainer: document.getElementById("stripPreviewContainer"),
    nextBtn: document.getElementById("btnNextFromSelection"),
    counterCard: null // created in renderGrid() the first time it runs
  },

  selectionOrder: [], // shot ids in tap order; null means slot is empty (max 4 slots)

  // shotId -> { card, badge } — built once per session by renderGrid()
  _cardEls: {},
  _cardsBuilt: false,

  // Single-flight guard for the async strip preview render (see header note)
  _previewRenderInFlight: false,
  _previewRenderPending: false,

  init() {
    this.selectionOrder = [];
    this._cardsBuilt = false; // force a full grid rebuild for the new session's shots
    this.renderGrid();
    this.renderPreview();
  },

  renderGrid() {
    if (!this._cardsBuilt) {
      this._buildGrid();
    }
    this._updateAllCardVisuals();
  },

  /* Builds the 8 photo cards + counter tile exactly once per session. */
  _buildGrid() {
    this.els.grid.innerHTML = "";
    this._cardEls = {};

    sessionState.shots
      .slice()
      .sort((a, b) => a.id - b.id)
      .forEach((shot) => {
        const card = document.createElement("div");
        card.className = "photo-card";
        card.dataset.shotId = shot.id;

        /*
         * .photo-card-order-badge:
         *   - always rendered in the DOM so CSS transitions work
         *   - .visible class makes it opaque/scaled-up (see animations.css)
         *   - textContent is the tap-order number, empty when not selected
         *   - lives here permanently now (not recreated per tap), so the
         *     CSS "spring pop" transition actually plays instead of the
         *     badge always appearing already in its end state.
         */
        card.innerHTML = `
          <img src="${shot.imageUrl}" alt="Photo ${shot.id}">
          <span class="photo-card-badge">PHOTO ${shot.id}</span>
          <span class="photo-card-order-badge"></span>
        `;

        card.addEventListener("click", () => this.toggleShot(shot.id));
        this.els.grid.appendChild(card);

        this._cardEls[shot.id] = {
          card,
          badge: card.querySelector(".photo-card-order-badge")
        };
      });

    // 9th tile — live selection counter
    const counterCard = document.createElement("div");
    counterCard.className = "selection-counter-card";
    counterCard.id = "selectionCounterCard";
    this.els.grid.appendChild(counterCard);
    this.els.counterCard = counterCard;

    this._cardsBuilt = true;
  },

  /* Cheap in-place update — no DOM teardown, no image re-decode, no new listeners. */
  _updateAllCardVisuals() {
    sessionState.shots.forEach((shot) => {
      const refs = this._cardEls[shot.id];
      if (!refs) return;

      const slotIndex   = this.selectionOrder.indexOf(shot.id);
      const orderNum    = slotIndex === -1 ? "" : String(slotIndex + 1);
      const isSelected  = shot.selected;

      refs.card.classList.toggle("selected", isSelected);
      refs.badge.textContent = orderNum;
      refs.badge.classList.toggle("visible", isSelected);
    });

    this.renderCounterCard();
  },

  toggleShot(id) {
    const shot = sessionState.shots.find((s) => s.id === id);
    if (!shot) return;

    const selectedCount = sessionState.shots.filter((s) => s.selected).length;

    if (!shot.selected && selectedCount >= 4) {
      // Already at the 4-photo limit — ignore, briefly flash the counter tile
      this.flashLimit();
      return;
    }

    shot.selected = !shot.selected;

    if (shot.selected) {
      // Find the first empty slot (null) or append a new slot
      const emptySlot = this.selectionOrder.indexOf(null);
      if (emptySlot !== -1) {
        this.selectionOrder[emptySlot] = id;
      } else {
        this.selectionOrder.push(id);
      }
    } else {
      // Replace with null to keep slots of later picks unchanged
      const slotIdx = this.selectionOrder.indexOf(id);
      if (slotIdx !== -1) {
        this.selectionOrder[slotIdx] = null;
      }
    }

    // Cheap in-place visual update (see renderGrid/_updateAllCardVisuals above)
    this.renderGrid();
    // Queues (and coalesces) the async strip-preview canvas render
    this.renderPreview();
  },

  flashLimit() {
    if (!this.els.counterCard) return;
    this.els.counterCard.classList.remove("flash");
    void this.els.counterCard.offsetWidth;
    this.els.counterCard.classList.add("flash");
  },

  renderCounterCard() {
    if (!this.els.counterCard) return;
    const selected = sessionState.shots.filter((s) => s.selected).length;
    this.els.counterCard.classList.toggle("complete", selected === 4);
    this.els.counterCard.innerHTML = `
      <span><span class="selection-counter-number">${selected}</span><span class="selection-counter-total">/4</span></span>
      <span class="selection-counter-label">Selected</span>
    `;
  },

  updateCountAndNav() {
    const selected = sessionState.shots.filter((s) => s.selected);
    this.renderCounterCard();
    this.els.nextBtn.disabled = selected.length !== 4;

    /*
     * Build a FIXED-LENGTH sparse array (length = 4) so canvas slot positions
     * are preserved exactly when a photo is deselected mid-session.
     *
     * Example: selectionOrder = [id1, null, id3, id4] (slot 2 deselected)
     * → selectedShots = [shot1, null, shot3, shot4]
     *
     * _compositePhotosOnly reads photoImages[config.slotToPhotoIndex[i]].
     * photoImages is built from selectedShots via Promise.all, so a null
     * entry resolves to null → canvas draws the empty-slot outline for that
     * position instead of shifting photo 4 into slot 3.
     */
    const ORDER_SIZE = 4;
    const sparse = [];
    for (let i = 0; i < ORDER_SIZE; i++) {
      const id = this.selectionOrder[i] !== undefined ? this.selectionOrder[i] : null;
      sparse.push(id !== null ? (sessionState.shots.find((s) => s.id === id) || null) : null);
    }
    sessionState.selectedShots = sparse;
  },

  renderPreview() {
    this.updateCountAndNav();
    this._queuePreviewRender();
  },

  /*
   * Single-flight + coalescing queue for the strip preview canvas render.
   *
   * Without this, every tap kicked off its own `await stripModule.render(...)`
   * (a full-resolution canvas composite) with no regard for whether a
   * previous one was still running. Rapid taps piled up several of these
   * concurrently, which is what froze/crashed Page 4 right around the 4th
   * photo. Now: only one render is ever in flight; if more taps land while
   * it's running, we don't start a second one — we just remember to render
   * once more with the latest state as soon as the current one finishes.
   */
  _queuePreviewRender() {
    if (this._previewRenderInFlight) {
      this._previewRenderPending = true;
      return;
    }

    this._previewRenderInFlight = true;
    const opts = {
      frameType: sessionState.frameType || "2x6",
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design
    };

    stripModule.render(this.els.previewContainer, opts)
      .catch((e) => console.warn("[selection] preview render failed:", e && e.message || e))
      .finally(() => {
        this._previewRenderInFlight = false;
        if (this._previewRenderPending) {
          this._previewRenderPending = false;
          this._queuePreviewRender();
        }
      });
  }
};

document.getElementById("btnNextFromSelection").addEventListener("click", async () => {
  kioskTimer.hide();

  // ── Audio: fire printing SFX immediately on button press ──────────────
  if (typeof audioManager !== "undefined") {
    audioManager.playPrintSfx();
  }

  // The design was already selected on Page 2 (template selection).
  // Ensure designModule has the correct selection before printing.
  if (typeof designModule !== "undefined") {
    if (!sessionState.design && typeof STRIP_DESIGNS !== "undefined" && STRIP_DESIGNS.length) {
      sessionState.design = STRIP_DESIGNS[0].id;
    }
    designModule._activeFilter = "none"; // reset filter
  }

  // Reset + start progress bar immediately
  if (typeof uploadProgress !== "undefined") uploadProgress.start();
  // Fire QR generation
  if (typeof qrModule !== "undefined") qrModule.generateAndRender();
  // Set the video frame's aspect ratio
  if (typeof _setPrintingFrameAspectRatio === "function") _setPrintingFrameAspectRatio();
  // Init printing module
  if (typeof printingModule !== "undefined") await printingModule.init();

  // Link ticket to session (fire-and-forget)
  if (sessionState.ticketId && sessionState.id && typeof queueTickets !== "undefined") {
    queueTickets.linkSession(sessionState.ticketId, sessionState.id).catch((e) => {
      console.warn("[selection] Could not link ticket to session:", e.message || e);
    });
  }

  goToPage("printing");
});

/* Auto-jump into selection once the 8-shot session finishes (from shooting.js) */
document.addEventListener("shooting:complete", () => {
  selectionModule.init();
  goToPage("selection");
  kioskTimer.start(60, autoCompleteSelectionOnTimeout);
});

/* Time's up on Page 4 — randomly fill any still-empty slots (up to 4)
   from photos the guest hasn't already picked, keeping whatever they
   DID choose and the order they tapped them in, then proceed
   automatically, exactly as if NEXT had been tapped. */
function autoCompleteSelectionOnTimeout() {
  // Count real selections (ignore null slots)
  const realCount = () => selectionModule.selectionOrder.filter((id) => id !== null).length;
  while (realCount() < 4) {
    const remaining = sessionState.shots.filter((s) => !s.selected);
    if (!remaining.length) break;
    const pick = remaining[Math.floor(Math.random() * remaining.length)];
    pick.selected = true;
    // Fill first null slot, or append
    const emptySlot = selectionModule.selectionOrder.indexOf(null);
    if (emptySlot !== -1) {
      selectionModule.selectionOrder[emptySlot] = pick.id;
    } else {
      selectionModule.selectionOrder.push(pick.id);
    }
  }

  selectionModule.renderGrid();
  selectionModule.renderPreview(); // also re-enables Next via updateCountAndNav()

  const btn = document.getElementById("btnNextFromSelection");
  if (btn && !btn.disabled) btn.click();
}
