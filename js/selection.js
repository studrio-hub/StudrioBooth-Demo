/*
 * SELECTION LOGIC — Page 4
 * User must pick exactly 4 of the 8 captured photos.
 * Picking a photo automatically carries its paired video along
 * (they share the same `id`, so no separate video-selection UI
 * is needed — see sessionState.shots pairing from shooting.js).
 */

const selectionModule = {
  els: {
    grid: document.getElementById("selectionGrid"),
    count: document.getElementById("selectionCount"),
    previewContainer: document.getElementById("stripPreviewContainer"),
    backBtn: document.getElementById("btnBackFromSelection"),
    nextBtn: document.getElementById("btnNextFromSelection")
  },

  init() {
    this.renderGrid();
    this.renderPreview();
  },

  renderGrid() {
    this.els.grid.innerHTML = "";

    sessionState.shots
      .slice()
      .sort((a, b) => a.id - b.id)
      .forEach((shot) => {
        const card = document.createElement("div");
        card.className = "photo-card" + (shot.selected ? " selected" : "");
        card.dataset.shotId = shot.id;

        card.innerHTML = `
          <img src="${shot.imageUrl}" alt="Photo ${shot.id}">
          <span class="photo-card-badge">PHOTO ${shot.id}</span>
          <span class="photo-card-check">✓</span>
          <span class="photo-card-video-tag">${shot.videoUrl ? "🎬 video" : "no video"}</span>
        `;

        card.addEventListener("click", () => this.toggleShot(shot.id));
        this.els.grid.appendChild(card);
      });
  },

  toggleShot(id) {
    const shot = sessionState.shots.find((s) => s.id === id);
    if (!shot) return;

    const selectedCount = sessionState.shots.filter((s) => s.selected).length;

    if (!shot.selected && selectedCount >= 4) {
      // Already at the 4-photo limit — ignore, briefly flash the count
      this.flashLimit();
      return;
    }

    shot.selected = !shot.selected;
    this.renderGrid();
    this.renderPreview();
    this.updateCountAndNav();
  },

  flashLimit() {
    this.els.count.style.color = "var(--off)";
    setTimeout(() => { this.els.count.style.color = ""; }, 300);
  },

  updateCountAndNav() {
    const selected = sessionState.shots.filter((s) => s.selected);
    this.els.count.textContent = `(${selected.length} / 4 selected)`;
    this.els.nextBtn.disabled = selected.length !== 4;

    // Keep chronological order (by shot id) for the printed strip
    sessionState.selectedShots = sessionState.shots
      .filter((s) => s.selected)
      .sort((a, b) => a.id - b.id);
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

document.getElementById("btnBackFromSelection").addEventListener("click", () => goToPage("shooting"));
document.getElementById("btnNextFromSelection").addEventListener("click", () => {
  designModule.init();
  goToPage("design");
});

/* Auto-jump into selection once the 8-shot session finishes (from shooting.js) */
document.addEventListener("shooting:complete", () => {
  selectionModule.init();
  goToPage("selection");
});
