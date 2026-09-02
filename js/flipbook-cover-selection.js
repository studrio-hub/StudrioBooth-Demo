/*
 * FLIPBOOK-COVER-SELECTION.JS — "Cover Page Photo Selection" page.
 *
 * Replaces the old animated "Your Flipbook Preview" page (formerly
 * flipbook-preview.js / flipbookPreviewModule). The full-page flip-through
 * animation is no longer shown as its own step — it still exists for the
 * Print & QR page's small preview column (printing.js instantiates its
 * own createFlipbookFlipAnimator independently — see the header comment
 * in flipbook-flip-animator.js).
 *
 * This page instead lets the guest pick 1 of the 3 cover photos captured
 * at the end of flipbook-shooting.js (sessionState.flipbookCoverPhotos),
 * using the exact same single-select grid pattern as flipbook-selection.js
 * (Video Selection) — see that file's header for the general shape this
 * mirrors (cards built once, radio-button selection, Next disabled until
 * a pick is made).
 *
 * On NEXT: same handoff flipbook-preview.js's Next button used to do —
 * starts the gallery upload (flipbook-qr.js) and hands off to
 * printingModule. sessionState.selectedFlipbookCoverPhoto is what the
 * print pipeline should read for the cover slot.
 */

const flipbookCoverSelectionModule = {
  els: {
    grid: document.getElementById("flipbookCoverSelectionGrid"),
    previewImg: document.getElementById("flipbookCoverPreviewImg"),
    nextBtn: document.getElementById("btnNextFromFlipbookCoverSelection"),
    // Minor Fix: admin-uploaded "Cover Page" template preview — now layered
    // on top of the selected cover photo inside the same preview stage
    // (see flipbook.css .flipbook-cover-page-preview-stage) instead of a
    // separate box, so toggling its own `hidden` is enough; no wrap needed.
    coverPageImg: document.getElementById("flipbookCoverSelectCoverPageImg")
  },

  selectedId: null,     // id of the single chosen cover photo, or null
  _cardEls: {},

  init() {
    this.selectedId = null;
    this._buildGrid();
    this._updateAllCardVisuals();
    if (this.els.nextBtn) this.els.nextBtn.disabled = true;
    if (this.els.previewImg) this.els.previewImg.src = "";
    this._renderCoverPage();
  },

  /* Minor Fix: shows the active template's admin-uploaded "Cover Page"
     asset (flipbookCoverUrl) layered on top of the selected cover photo,
     inside the same preview stage. No-ops (stays hidden) if the active
     template hasn't had one uploaded — the photo underneath still shows
     on its own via selectPhoto(). */
  _renderCoverPage() {
    if (!this.els.coverPageImg) return;
    const tmpl = (typeof STRIP_DESIGNS !== "undefined")
      ? STRIP_DESIGNS.find((t) => String(t.id) === String(sessionState.design))
      : null;
    const url = tmpl ? tmpl.flipbookCoverUrl : null;
    if (url) {
      this.els.coverPageImg.src = url;
      this.els.coverPageImg.hidden = false;
    } else {
      this.els.coverPageImg.src = "";
      this.els.coverPageImg.hidden = true;
    }
  },

  _buildGrid() {
    if (!this.els.grid) return;
    this.els.grid.innerHTML = "";
    this._cardEls = {};

    (sessionState.flipbookCoverPhotos || []).forEach((photo) => {
      const card = document.createElement("div");
      card.className = "photo-card flipbook-cover-photo-card";
      card.dataset.photoId = photo.id;

      card.innerHTML = `
        <img src="${photo.imageUrl}" alt="Cover photo ${photo.id}">
        <span class="flipbook-select-check">✓</span>
      `;

      card.addEventListener("click", () => this.selectPhoto(photo.id));

      this.els.grid.appendChild(card);
      this._cardEls[photo.id] = { card };
    });
  },

  _updateAllCardVisuals() {
    (sessionState.flipbookCoverPhotos || []).forEach((photo) => {
      const refs = this._cardEls[photo.id];
      if (!refs) return;
      refs.card.classList.toggle("selected", this.selectedId === photo.id);
    });
  },

  selectPhoto(id) {
    // Radio-button behavior: selecting a new photo replaces the old pick.
    this.selectedId = (this.selectedId === id) ? null : id;
    this._updateAllCardVisuals();

    const photo = (sessionState.flipbookCoverPhotos || []).find((p) => p.id === this.selectedId) || null;
    sessionState.selectedFlipbookCoverPhoto = photo;

    if (this.els.nextBtn) this.els.nextBtn.disabled = !photo;
    if (this.els.previewImg) this.els.previewImg.src = photo ? photo.imageUrl : "";
  },

  /* Timeout fallback — auto-pick the first cover photo, same philosophy
     as flipbook-selection.js's autoSelectOnTimeout(). */
  autoSelectOnTimeout() {
    if (!this.selectedId && sessionState.flipbookCoverPhotos && sessionState.flipbookCoverPhotos.length) {
      this.selectPhoto(sessionState.flipbookCoverPhotos[0].id);
    }
  }
};

document.getElementById("btnNextFromFlipbookCoverSelection")?.addEventListener("click", async () => {
  kioskTimer.hide();
  if (!sessionState.selectedFlipbookCoverPhoto || !sessionState.selectedFlipbookCoverPhoto.image) return;

  sessionState._isFlipbook = true;

  if (typeof audioManager !== "undefined") audioManager.playPrintSfx();

  uploadProgress.start();
  if (typeof flipbookQr !== "undefined") flipbookQr.generateAndRender();

  goToPage("printing");
  if (typeof printingModule !== "undefined") await printingModule.init();
});
