/*
 * SELECTION LOGIC — Page 4  (v2)
 *
 * Changes from v1:
 *  - Removed ✓ checkmark span; replaced with .photo-card-order-badge
 *    that shows the 1-based tap-order number (e.g. first photo tapped → "1").
 *  - No external animations on selection — badge visibility is CSS-only
 *    (.visible class toggled here; transition in animations.css).
 *  - All selection logic (toggleShot, selectionOrder, limit flash,
 *    autoComplete, strip preview) is preserved exactly.
 *
 * Why the badge lives here and not in animations.js:
 *   renderGrid() clears innerHTML on every toggle, destroying any nodes
 *   injected externally. The badge must be part of the initial innerHTML
 *   so it is recreated correctly on every re-render.
 */

const selectionModule = {
  els: {
    grid: document.getElementById("selectionGrid"),
    previewContainer: document.getElementById("stripPreviewContainer"),
    nextBtn: document.getElementById("btnNextFromSelection"),
    counterCard: null // created dynamically in renderGrid()
  },

  selectionOrder: [], // shot ids in tap order; null means slot is empty (max 4 slots)

  init() {
    this.selectionOrder = [];
    this.renderGrid();
    this.renderPreview();
  },

  renderGrid() {
    this.els.grid.innerHTML = "";

    sessionState.shots
      .slice()
      .sort((a, b) => a.id - b.id)
      .forEach((shot) => {
        // Slot number is the 1-based position in selectionOrder (nulls are skipped for display)
        // selectionOrder holds shot ids; find which slot this shot occupies.
        const slotIndex = this.selectionOrder.indexOf(shot.id);
        // Display the 1-based slot number (position in the fixed order array)
        const orderNum   = slotIndex === -1 ? "" : String(slotIndex + 1);
        const isSelected = shot.selected;

        const card = document.createElement("div");
        card.className = "photo-card" + (isSelected ? " selected" : "");
        card.dataset.shotId = shot.id;

        /*
         * .photo-card-order-badge:
         *   - always rendered in the DOM so CSS transitions work
         *   - .visible class makes it opaque/scaled-up (see animations.css)
         *   - textContent is the tap-order number, empty when not selected
         */
        card.innerHTML = `
          <img src="${shot.imageUrl}" alt="Photo ${shot.id}">
          <span class="photo-card-badge">PHOTO ${shot.id}</span>
          <span class="photo-card-order-badge${isSelected ? " visible" : ""}">${orderNum}</span>
        `;

        card.addEventListener("click", () => this.toggleShot(shot.id));
        this.els.grid.appendChild(card);
      });

    // 9th tile — live selection counter
    const counterCard = document.createElement("div");
    counterCard.className = "selection-counter-card";
    counterCard.id = "selectionCounterCard";
    this.els.grid.appendChild(counterCard);
    this.els.counterCard = counterCard;
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

    // Re-render the full grid so order badges update correctly on all cards
    this.renderGrid();
    this.renderPreview();
    this.updateCountAndNav();
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
    stripModule.render(this.els.previewContainer, {
      frameType: sessionState.frameType || "2x6",
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design
    });
  }
};

document.getElementById("btnNextFromSelection").addEventListener("click", () => {
  kioskTimer.hide();
  designModule.init();
  goToPage("design");
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
