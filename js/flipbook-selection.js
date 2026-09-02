/*
 * FLIPBOOK-SELECTION.JS — Video Selection page.
 *
 * Same general layout/build pattern as selection.js (Page 4 photo
 * selection: cards built once, updated in place, single-flight preview
 * render queue) but simplified per spec:
 *   - No 4/4 multi-select system.
 *   - Exactly ONE of the 3 recorded videos can be chosen (radio-button
 *     behavior — picking a new one deselects the previous pick).
 *
 * On NEXT, the chosen clip is handed to flipbookFrameExtractor to produce
 * the 19 frames (only now — never for the other two clips), then routes
 * to the Cover Page Photo Selection page (flipbook-cover-selection.js).
 */

const flipbookSelectionModule = {
  els: {
    grid: document.getElementById("flipbookSelectionGrid"),
    previewContainer: document.getElementById("flipbookPreviewFrameContainer"),
    nextBtn: document.getElementById("btnNextFromFlipbookSelection"),
    loadingOverlay: document.getElementById("flipbookExtractingOverlay"),
    // Minor Fix: admin-uploaded "Cover Page" template preview — now
    // layered on top of the video preview inside the same stage (see
    // flipbook.css .flipbook-cover-page-preview-stage), instead of a
    // separate box above it.
    coverPageLabel: document.getElementById("flipbookSelectCoverPageLabel"),
    coverPageImg: document.getElementById("flipbookSelectCoverPageImg")
  },

  selectedId: null,     // id of the single chosen clip, or null
  _cardEls: {},
  _cardsBuilt: false,

  init() {
    this.selectedId = null;
    this._cardsBuilt = false;
    this._buildGrid();
    this._updateAllCardVisuals();
    if (this.els.nextBtn) this.els.nextBtn.disabled = true;
    if (this.els.previewContainer) flipbookPreviewFrame.render(this.els.previewContainer, null);
    this._renderCoverPage();
  },

  /* Minor Fix: shows the active template's admin-uploaded "Cover Page"
     asset (flipbookCoverUrl) layered on top of the video preview, inside
     the same stage — matching the fix made for Cover Page Photo
     Selection. No-ops (stays hidden, video fills the full stage) if the
     active template hasn't had one uploaded. */
  _renderCoverPage() {
    if (!this.els.coverPageImg) return;
    const tmpl = (typeof STRIP_DESIGNS !== "undefined")
      ? STRIP_DESIGNS.find((t) => String(t.id) === String(sessionState.design))
      : null;
    const url = tmpl ? tmpl.flipbookCoverUrl : null;

    if (this.els.previewContainer) {
      this.els.previewContainer.classList.toggle("flipbook-cover-page-preview-photo", !!url);
    }

    if (url) {
      this.els.coverPageImg.src = url;
      this.els.coverPageImg.hidden = false;
      if (this.els.coverPageLabel) this.els.coverPageLabel.hidden = false;
    } else {
      this.els.coverPageImg.src = "";
      this.els.coverPageImg.hidden = true;
      if (this.els.coverPageLabel) this.els.coverPageLabel.hidden = true;
    }
  },

  _buildGrid() {
    if (!this.els.grid) return;
    this.els.grid.innerHTML = "";
    this._cardEls = {};

    (sessionState.flipbookVideos || []).forEach((clip) => {
      const card = document.createElement("div");
      card.className = "photo-card flipbook-video-card";
      card.dataset.clipId = clip.id;

      card.innerHTML = `
        <video src="${clip.videoUrl}" muted playsinline loop></video>
        <span class="photo-card-badge">VIDEO ${clip.id}</span>
        <span class="flipbook-select-check">✓</span>
      `;

      card.addEventListener("click", () => this.selectClip(clip.id));
      // Loop a muted preview so guests can see which take is which.
      const vidEl = card.querySelector("video");
      card.addEventListener("mouseenter", () => vidEl.play().catch(() => {}));
      vidEl.addEventListener("loadeddata", () => vidEl.play().catch(() => {}));

      this.els.grid.appendChild(card);
      this._cardEls[clip.id] = { card };
    });

    this._cardsBuilt = true;
  },

  _updateAllCardVisuals() {
    (sessionState.flipbookVideos || []).forEach((clip) => {
      const refs = this._cardEls[clip.id];
      if (!refs) return;
      refs.card.classList.toggle("selected", this.selectedId === clip.id);
    });
  },

  selectClip(id) {
    // Radio-button behavior: selecting a new clip replaces the old pick.
    this.selectedId = (this.selectedId === id) ? null : id;
    this._updateAllCardVisuals();

    const clip = (sessionState.flipbookVideos || []).find((c) => c.id === this.selectedId) || null;
    sessionState.selectedFlipbookVideo = clip;

    if (this.els.nextBtn) this.els.nextBtn.disabled = !clip;
    if (this.els.previewContainer) flipbookPreviewFrame.render(this.els.previewContainer, clip);
  },

  /* Timeout fallback — auto-pick the first recorded clip so the guest is
     never stuck, same philosophy as autoCompleteSelectionOnTimeout() in
     selection.js. */
  autoSelectOnTimeout() {
    if (!this.selectedId && sessionState.flipbookVideos && sessionState.flipbookVideos.length) {
      this.selectClip(sessionState.flipbookVideos[0].id);
    }
  }
};

document.addEventListener("flipbook-shooting:complete", () => {
  flipbookSelectionModule.init();
  goToPage("flipbook-select");
  kioskTimer.start(60, () => {
    flipbookSelectionModule.autoSelectOnTimeout();
    const btn = document.getElementById("btnNextFromFlipbookSelection");
    if (btn && !btn.disabled) btn.click();
  });
});

document.getElementById("btnNextFromFlipbookSelection")?.addEventListener("click", async () => {
  kioskTimer.hide();
  if (!sessionState.selectedFlipbookVideo || !sessionState.selectedFlipbookVideo.video) return;

  const overlay = flipbookSelectionModule.els.loadingOverlay;
  if (overlay) overlay.classList.add("show");

  try {
    // 19 frames generated ONLY now, after the guest has committed to a video.
    sessionState.flipbookFrames = await flipbookFrameExtractor.extractFrames(
      sessionState.selectedFlipbookVideo.video,
      FLIPBOOK_TOTAL_FRAMES
    );
  } catch (e) {
    console.error("[flipbook-selection] Frame extraction failed:", e);
    if (overlay) overlay.classList.remove("show");
    return; // don't advance on failure — guest can retry NEXT
  }

  if (overlay) overlay.classList.remove("show");

  if (typeof flipbookCoverSelectionModule !== "undefined") flipbookCoverSelectionModule.init();
  goToPage("flipbook-cover-select");
  kioskTimer.start(60, () => {
    flipbookCoverSelectionModule.autoSelectOnTimeout();
    const btn = document.getElementById("btnNextFromFlipbookCoverSelection");
    if (btn && !btn.disabled) btn.click();
  });
});
