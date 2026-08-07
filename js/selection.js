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

  selectionOrder: [], // shot ids, in the order the guest tapped them

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
        // Determine this shot's 1-based tap order (empty string when not selected)
        const orderIndex = this.selectionOrder.indexOf(shot.id);
        const orderNum   = orderIndex === -1 ? "" : String(orderIndex + 1);
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
      this.selectionOrder.push(id);
    } else {
      this.selectionOrder = this.selectionOrder.filter((sid) => sid !== id);
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

    // Order matches the sequence the guest tapped them in — the first
    // photo selected becomes Photo 1, and so on — NOT capture order.
    sessionState.selectedShots = this.selectionOrder
      .map((id) => sessionState.shots.find((s) => s.id === id))
      .filter(Boolean);
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
  while (selectionModule.selectionOrder.length < 4) {
    const remaining = sessionState.shots.filter((s) => !s.selected);
    if (!remaining.length) break;
    const pick = remaining[Math.floor(Math.random() * remaining.length)];
    pick.selected = true;
    selectionModule.selectionOrder.push(pick.id);
  }

  selectionModule.renderGrid();
  selectionModule.renderPreview(); // also re-enables Next via updateCountAndNav()

  const btn = document.getElementById("btnNextFromSelection");
  if (btn && !btn.disabled) btn.click();
}
