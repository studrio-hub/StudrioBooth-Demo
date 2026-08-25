/*
 * ANIMATIONS-REDESIGN.JS — Studrio Booth Pages 2–6 UI Redesign
 *
 * Load AFTER animations.js (which wraps goToPage).
 * This layer adds:
 *   1. Pixel-grid left-to-right transition (Page 2→3, Page 6→Page1)
 *   2. NEXT button white→yellow fill animation (1.5s) before navigation
 *   3. Page 4 → 5: fade out other elements, keep strip + NEXT, center strip
 *   4. Page 5 → 6: same strip keep + transform to video strip
 *   5. Page 6 DONE: pixel-grid transition back to Page 1
 *   6. Page 6: yellow wave overlay when printing starts
 *   7. Design carousel: infinite swipe, template sync
 *   8. Pose overlay: shown only on 4×6 page-shooting
 *
 * All hooks preserve existing functionality — only navigation timing and
 * visual transitions are changed.
 */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════
   * PIXEL-GRID TRANSITION
   * Creates a grid of small squares that fill left-to-right, then clear.
   * Grid cells align to the CSS --grid-size (40px) background.
   * ═══════════════════════════════════════════════════════════════════════ */

  const CELL_SIZE = 40;  // must match --grid-size in style-redesign.css
  const WAVE_DURATION_MS = 650; // total left-to-right sweep time
  const CELL_STAGGER_MS  = 18;  // extra stagger per column

  let _pgOverlay = null;

  function _ensurePixelOverlay() {
    if (_pgOverlay) return _pgOverlay;
    _pgOverlay = document.createElement('div');
    _pgOverlay.id = 'pixelGridTransitionOverlay';
    document.getElementById('kiosk').appendChild(_pgOverlay);
    return _pgOverlay;
  }

  /**
   * Plays a left-to-right pixel-grid fill transition.
   * @param {Function} onMidpoint - called when overlay is fully opaque (switch page here)
   * @param {Function} onComplete - called after overlay clears
   */
  function playPixelGridTransition(onMidpoint, onComplete) {
    const overlay = _ensurePixelOverlay();
    overlay.innerHTML = '';
    overlay.classList.add('active');

    const kiosk = document.getElementById('kiosk');
    const W = kiosk.offsetWidth  || 1920;
    const H = kiosk.offsetHeight || 1080;

    const cols = Math.ceil(W / CELL_SIZE);
    const rows = Math.ceil(H / CELL_SIZE);

    // Create cells
    const fragment = document.createDocumentFragment();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement('div');
        cell.className = 'pg-cell';
        cell.style.cssText = [
          `left:${c * CELL_SIZE}px`,
          `top:${r * CELL_SIZE}px`,
          `width:${CELL_SIZE + 1}px`,   /* +1 prevents subpixel gaps */
          `height:${CELL_SIZE + 1}px`,
          `opacity:0`,
          `background:#ffffff`,
          `will-change:opacity`,
        ].join(';');
        fragment.appendChild(cell);
      }
    }
    overlay.appendChild(fragment);

    const allCells = overlay.querySelectorAll('.pg-cell');
    let midpointFired = false;

    // Animate: fade in column by column
    for (let c = 0; c < cols; c++) {
      const delay = (c / cols) * WAVE_DURATION_MS + c * CELL_STAGGER_MS * 0.05;
      for (let r = 0; r < rows; r++) {
        const cell = allCells[r * cols + c];
        if (!cell) continue;
        cell.style.transitionDuration = '90ms';
        cell.style.transitionProperty = 'opacity';
        cell.style.transitionTimingFunction = 'ease-in';
        setTimeout(() => {
          cell.style.opacity = '1';
        }, delay + r * 2); // tiny row stagger for texture
      }

      // Midpoint: at ~60% of the sweep
      if (!midpointFired && c / cols > 0.58) {
        midpointFired = true;
        const mid = delay;
        setTimeout(() => {
          if (typeof onMidpoint === 'function') onMidpoint();
        }, mid);
      }
    }

    // After full fill: hold briefly then clear
    const fillTime = WAVE_DURATION_MS + cols * CELL_STAGGER_MS * 0.05 + rows * 2;
    const holdTime = 160;

    setTimeout(() => {
      // Fade out right-to-left
      for (let c = cols - 1; c >= 0; c--) {
        const delay = ((cols - 1 - c) / cols) * (WAVE_DURATION_MS * 0.65);
        for (let r = 0; r < rows; r++) {
          const cell = allCells[r * cols + c];
          if (!cell) continue;
          cell.style.transitionDuration = '120ms';
          cell.style.transitionTimingFunction = 'ease-out';
          setTimeout(() => {
            cell.style.opacity = '0';
          }, delay + r * 1.5);
        }
      }

      // Cleanup
      const clearTime = WAVE_DURATION_MS * 0.65 + 200;
      setTimeout(() => {
        overlay.classList.remove('active');
        overlay.innerHTML = '';
        if (typeof onComplete === 'function') onComplete();
      }, clearTime);
    }, fillTime + holdTime);
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * NEXT BUTTON: white→yellow gradient fill (1.5s)
   * ═══════════════════════════════════════════════════════════════════════ */

  function playNextBtnFill(btn, onComplete) {
    if (!btn) { if (onComplete) onComplete(); return; }

    // Ensure fill layer exists
    let fillLayer = btn.querySelector('.btn-next-fill');
    if (!fillLayer) {
      fillLayer = document.createElement('span');
      fillLayer.className = 'btn-next-fill';
      const pos = getComputedStyle(btn).position;
      if (pos === 'static') btn.style.position = 'relative';
      btn.appendChild(fillLayer);
    }

    btn.classList.remove('fill-anim');
    void btn.offsetWidth; // reflow
    btn.classList.add('fill-anim');

    setTimeout(() => {
      btn.classList.remove('fill-anim');
      if (typeof onComplete === 'function') onComplete();
    }, 1500);
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * STRIP + NEXT ISOLATION TRANSITION
   * Fades out everything except the strip preview and NEXT button,
   * then optionally centers the strip before navigating.
   * Used: Page 4→5, Page 5→6
   * ═══════════════════════════════════════════════════════════════════════ */

  function isolateStripAndNext(page, stripEl, nextBtn, onComplete) {
    if (!page) { if (onComplete) onComplete(); return; }

    // Find all direct children of page (or layout wrapper) except strip + next
    const layout = page.querySelector('.selection-layout, .design-layout') || page;
    const allChildren = Array.from(layout.children);

    // Elements to hide
    const toFade = allChildren.filter((el) => {
      return !el.contains(stripEl) && !el.contains(nextBtn) && el !== stripEl && el !== nextBtn;
    });

    toFade.forEach((el) => {
      el.style.transition = 'opacity 0.5s ease';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
    });

    // After fade: center the strip
    setTimeout(() => {
      if (stripEl) {
        stripEl.style.transition = 'transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)';
        // Calculate offset to center
        const kioskRect = document.getElementById('kiosk').getBoundingClientRect();
        const stripRect  = stripEl.getBoundingClientRect();
        const centerX    = kioskRect.left + kioskRect.width  / 2;
        const centerY    = kioskRect.top  + kioskRect.height / 2;
        const stripCX    = stripRect.left + stripRect.width  / 2;
        const stripCY    = stripRect.top  + stripRect.height / 2;
        const tx = centerX - stripCX;
        const ty = centerY - stripCY;
        stripEl.style.transform = `translate(${tx}px, ${ty}px)`;
      }

      setTimeout(() => {
        if (typeof onComplete === 'function') onComplete();
        // Restore after navigation (cleanup)
        toFade.forEach((el) => {
          el.style.opacity = '';
          el.style.transition = '';
          el.style.pointerEvents = '';
        });
        if (stripEl) {
          stripEl.style.transform = '';
          stripEl.style.transition = '';
        }
      }, 580);
    }, 520);
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * PAGE 6: YELLOW WAVE OVERLAY on printing start
   * ═══════════════════════════════════════════════════════════════════════ */

  function _ensureWaveOverlay() {
    let waveEl = document.getElementById('printWaveOverlay');
    if (!waveEl) {
      waveEl = document.createElement('div');
      waveEl.id = 'printWaveOverlay';
      waveEl.innerHTML = '<div class="print-wave"></div>';
      const printingPage = document.getElementById('page-printing');
      if (printingPage) printingPage.prepend(waveEl);
    }
    return waveEl;
  }

  function activatePrintWave() {
    const wave = _ensureWaveOverlay();
    wave.classList.add('active');
  }

  // Hook into uploadProgress.complete to show the wave when printing starts
  // We do this by watching the Done button getting .ready class
  let _waveObserver = null;
  function _watchDoneBtnForWave() {
    const doneBtn = document.getElementById('btnPrintingDone');
    if (!doneBtn) return;
    _waveObserver = new MutationObserver(() => {
      if (doneBtn.classList.contains('ready')) {
        activatePrintWave();
      }
    });
    _waveObserver.observe(doneBtn, { attributes: true, attributeFilter: ['class'] });
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * POSE OVERLAY (Page 3 — 4×6 only)
   * Preview-only grid overlay. NEVER affects captured photos.
   * ═══════════════════════════════════════════════════════════════════════ */

  function _ensurePoseOverlay() {
    const shootingFrame = document.getElementById('shootingPreviewFrame');
    if (!shootingFrame) return;
    if (shootingFrame.querySelector('.pose-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'pose-overlay';
    overlay.innerHTML = `
      <div class="pose-overlay-grid">
        <div class="pose-box"><span class="pose-box-num">1</span></div>
        <div class="pose-box"><span class="pose-box-num">2</span></div>
        <div class="pose-box"><span class="pose-box-num">3</span></div>
        <div class="pose-box"><span class="pose-box-num">4</span></div>
      </div>`;
    shootingFrame.appendChild(overlay);
  }

  function _updatePoseOverlay() {
    _ensurePoseOverlay();
    const overlay = document.querySelector('#shootingPreviewFrame .pose-overlay');
    if (!overlay) return;
    const is4x6 = window.sessionState && window.sessionState.frameType === '4x6';
    overlay.classList.toggle('visible', is4x6);
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * DESIGN CAROUSEL — infinite horizontal swipe for templates & filters
   * ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Wraps an existing design-options grid into a horizontal carousel.
   * Works with the existing strip.js design swatches.
   */
  function _initDesignCarousels() {
    // The existing .design-options grid contains .design-swatch elements.
    // We restructure them into a horizontal scroll carousel on Page 5.
    const designOptions = document.getElementById('designOptions');
    if (!designOptions) return;

    // Already initialized
    if (designOptions.dataset.carouselReady) return;
    designOptions.dataset.carouselReady = '1';

    // Convert vertical grid to horizontal flex scroll
    designOptions.style.display = 'flex';
    designOptions.style.flexDirection = 'row';
    designOptions.style.flexWrap = 'nowrap';
    designOptions.style.overflowX = 'auto';
    designOptions.style.overflowY = 'hidden';
    designOptions.style.gap = '1vw';
    designOptions.style.alignItems = 'stretch';
    designOptions.style.paddingBottom = '0.5vh';
    designOptions.style.scrollSnapType = 'x mandatory';
    designOptions.style.scrollbarWidth = 'none';
    designOptions.style.gridTemplateColumns = 'unset';

    // Style each swatch as a carousel card
    const swatches = designOptions.querySelectorAll('.design-swatch');
    swatches.forEach((swatch) => {
      swatch.style.flex = '0 0 9vw';
      swatch.style.scrollSnapAlign = 'center';
      swatch.style.minWidth = '9vw';
    });

    // Touch/pointer drag-scroll support
    _addDragScroll(designOptions);
  }

  function _addDragScroll(el) {
    let startX = 0;
    let scrollLeft = 0;
    let isDragging = false;

    el.addEventListener('pointerdown', (e) => {
      isDragging = true;
      startX = e.pageX - el.offsetLeft;
      scrollLeft = el.scrollLeft;
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const x = e.pageX - el.offsetLeft;
      const walk = (x - startX) * 1.2;
      el.scrollLeft = scrollLeft - walk;
    });

    el.addEventListener('pointerup',    () => { isDragging = false; });
    el.addEventListener('pointercancel',() => { isDragging = false; });
  }

  // Re-run whenever design page becomes active (strip.js may re-render swatches)
  function _watchDesignPage() {
    const designPage = document.getElementById('page-design');
    if (!designPage) return;

    new MutationObserver(() => {
      if (designPage.classList.contains('active')) {
        // Give strip.js a tick to render swatches
        setTimeout(_initDesignCarousels, 80);
      }
    }).observe(designPage, { attributes: true, attributeFilter: ['class'] });
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * PAGE HEADER INJECTION
   * Injects the icon + title + subtitle header block at the top of each
   * workflow page if it doesn't already exist.
   * ═══════════════════════════════════════════════════════════════════════ */

  const PAGE_HEADERS = {
    'page-setup': {
      icon:     'assets/designs/icons/camera-mode.png',
      title:    'Camera Mode',
      subtitle: 'Choose your camera settings',
    },
    'page-frame': {
      icon:     'assets/designs/icons/camera-mode.png',
      title:    'Camera Mode',
      subtitle: 'Choose your camera settings',
    },
    'page-shooting': {
      icon:     'assets/designs/icons/camera-mode.png',
      title:    'Photo Taking',
      subtitle: '',
    },
    'page-selection': {
      icon:     'assets/designs/icons/photo-select.png',
      title:    'Select Photos',
      subtitle: 'Choose your best photo',
    },
    'page-design': {
      icon:     'assets/designs/icons/design.png',
      title:    'Select Frame Design',
      subtitle: 'Choose your favorite frame design',
    },
    'page-printing': {
      icon:     'assets/designs/icons/design.png',
      title:    'Print & QR',
      subtitle: '',
    },
  };

  function _injectPageHeaders() {
    Object.entries(PAGE_HEADERS).forEach(([pageId, cfg]) => {
      const page = document.getElementById(pageId);
      if (!page) return;
      if (page.querySelector('.page-header-block')) return;

      const block = document.createElement('div');
      block.className = 'page-header-block';

      // For shooting page: include blinking red dot next to title
      const isShoot = pageId === 'page-shooting';
      const recDot  = isShoot ? '<span class="shooting-rec-dot"></span>' : '';
      const iconSize = pageId === 'page-printing' ? '3.75vw' : '3.75vw';

      block.innerHTML = `
        <img class="page-header-icon" src="${cfg.icon}"
             style="width:${iconSize}"
             alt="${cfg.title} icon"
             onerror="this.style.display='none'">
        <div class="page-header-text">
          <div class="page-header-title">
            ${recDot}${cfg.title}
          </div>
          ${cfg.subtitle ? `<div class="page-header-subtitle">${cfg.subtitle}</div>` : ''}
        </div>`;

      // Insert at top of page (before existing first child)
      page.insertBefore(block, page.firstChild);
    });
  }

  /* Inject upload/print status lines under Page 6 header */
  function _injectPrintStatusLines() {
    const page = document.getElementById('page-printing');
    if (!page || page.querySelector('.print-upload-status-wrap')) return;

    const wrap = document.createElement('div');
    wrap.className = 'print-upload-status-wrap';
    wrap.innerHTML = `
      <div class="print-upload-status-row" id="uploadStatusLine">
        <span class="print-status-dot idle" id="uploadStatusDot"></span>
        <span id="uploadStatusText">Uploading your photos…</span>
      </div>
      <div class="print-upload-status-row" id="printStatusLine">
        <span class="print-status-dot idle" id="printStatusDot"></span>
        <span id="printStatusTextLine">Waiting for printer…</span>
      </div>`;

    // Insert after the page-header-block
    const header = page.querySelector('.page-header-block');
    if (header) {
      header.after(wrap);
    } else {
      page.insertBefore(wrap, page.firstChild);
    }
  }

  /* Sync upload/print status dots with existing hidden status elements */
  function _watchPrintStatus() {
    const uploadLabel = document.getElementById('uploadProgressLabel');
    const uploadPct   = document.getElementById('uploadProgressPct');

    if (uploadLabel) {
      new MutationObserver(() => {
        const txt = document.getElementById('uploadStatusText');
        const dot = document.getElementById('uploadStatusDot');
        if (txt) txt.textContent = uploadLabel.textContent || 'Uploading…';
        if (dot) {
          const wrap = document.getElementById('uploadProgressWrap');
          if (wrap && wrap.classList.contains('complete')) {
            dot.className = 'print-status-dot done';
          } else if (wrap && wrap.classList.contains('error')) {
            dot.className = 'print-status-dot idle';
          } else {
            dot.className = 'print-status-dot';
          }
        }
      }).observe(uploadLabel, { childList: true, characterData: true, subtree: true });
    }

    // Watch the hidden printStatusText for printing status
    const printTxt = document.getElementById('printStatusText');
    if (printTxt) {
      new MutationObserver(() => {
        const line = document.getElementById('printStatusTextLine');
        const dot  = document.getElementById('printStatusDot');
        if (line) line.textContent = printTxt.textContent || 'Waiting for printer…';
        if (dot) {
          const isPrinting = (printTxt.textContent || '').toLowerCase().includes('print');
          dot.className = isPrinting ? 'print-status-dot done' : 'print-status-dot idle';
        }
      }).observe(printTxt, { childList: true, characterData: true, subtree: true });
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * SHOOTING PAGE: add taken-photo thumbnails to left column
   * ═══════════════════════════════════════════════════════════════════════ */

  function _injectShootingTakenCol() {
    const page = document.getElementById('page-shooting');
    if (!page || page.querySelector('.shooting-taken-col')) return;

    // Wrap existing layout in shooting-redesign-layout if not already
    const existingLayout = page.querySelector('.shooting-layout-solo');
    if (!existingLayout) return;

    // Create new two-column wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'shooting-redesign-layout';

    // Left: taken photos column
    const takenCol = document.createElement('div');
    takenCol.className = 'shooting-taken-col';
    takenCol.id = 'shootingTakenCol';
    takenCol.innerHTML = `
      <div class="shooting-taken-label">Photos Taken</div>
      <div class="shooting-taken-count" id="shootingTakenCount">0</div>`;

    // Right: main column (contains existing shooting layout)
    const mainCol = document.createElement('div');
    mainCol.className = 'shooting-main-col';

    // Header row inside main col
    const headerRow = document.createElement('div');
    headerRow.className = 'shooting-header-row';
    headerRow.innerHTML = `
      <img class="shooting-header-icon"
           src="assets/designs/icons/camera-mode.png"
           alt="Photo Taking"
           onerror="this.style.display='none'">
      <span class="shooting-header-title">Photo Taking</span>
      <span class="shooting-rec-dot"></span>`;

    // Instruction wrap
    const instrWrap = document.createElement('div');
    instrWrap.className = 'shooting-instruction-wrap';
    instrWrap.innerHTML = `
      <div class="shooting-look-text">Look at the camera.</div>
      <div class="shooting-sub-text">Smile and hold still for each shot!</div>`;

    mainCol.appendChild(headerRow);
    mainCol.appendChild(existingLayout);
    mainCol.appendChild(instrWrap);

    wrapper.appendChild(takenCol);
    wrapper.appendChild(mainCol);

    // Replace page content with the new layout
    // Keep the header-block if it exists
    const headerBlock = page.querySelector('.page-header-block');
    page.innerHTML = '';
    if (headerBlock) page.appendChild(headerBlock);
    page.appendChild(wrapper);
  }

  /* Add thumbnail to taken-col when a photo is captured */
  function _addTakenThumbnail(imageUrl, number) {
    const col = document.getElementById('shootingTakenCol');
    if (!col) return;

    const thumb = document.createElement('div');
    thumb.className = 'shooting-taken-thumb';
    thumb.innerHTML = `
      <img src="${imageUrl}" alt="Photo ${number}" loading="lazy">
      <span class="shooting-taken-thumb-num">${number}</span>`;

    // Insert before the label/count at end
    const label = col.querySelector('.shooting-taken-label');
    if (label) col.insertBefore(thumb, label);
    else col.appendChild(thumb);

    // Update count
    const countEl = document.getElementById('shootingTakenCount');
    if (countEl) countEl.textContent = String(number);
  }

  /* Hook into shooting module's photo-captured event */
  function _hookShootingThumbnails() {
    // Watch sessionState.shots for new entries via polling (avoids modifying shooting.js)
    let _lastShotCount = 0;
    setInterval(() => {
      if (!window.sessionState) return;
      const shots = window.sessionState.shots || [];
      if (shots.length > _lastShotCount) {
        for (let i = _lastShotCount; i < shots.length; i++) {
          const shot = shots[i];
          if (shot && shot.imageUrl) {
            _addTakenThumbnail(shot.imageUrl, i + 1);
          }
        }
        _lastShotCount = shots.length;

        // Update pose overlay
        _updatePoseOverlay();
      }
    }, 300);

    // Reset when shooting page becomes active
    const shootPage = document.getElementById('page-shooting');
    if (shootPage) {
      new MutationObserver(() => {
        if (shootPage.classList.contains('active')) {
          _lastShotCount = 0;
          const col = document.getElementById('shootingTakenCol');
          if (col) {
            // Clear thumbnails but keep count label
            const thumbs = col.querySelectorAll('.shooting-taken-thumb');
            thumbs.forEach((t) => t.remove());
            const countEl = document.getElementById('shootingTakenCount');
            if (countEl) countEl.textContent = '0';
          }
          _updatePoseOverlay();
        }
      }).observe(shootPage, { attributes: true, attributeFilter: ['class'] });
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * CAMERA CONTROL ICONS — inject icon images next to zoom/mirror labels
   * ═══════════════════════════════════════════════════════════════════════ */

  function _injectCameraControlIcons() {
    const ICONS = {
      btnZoomWide:    { src: 'assets/designs/icons/zoom-out.png', label: 'Zoom Wide' },
      btnZoomNormal:  { src: 'assets/designs/icons/zoom-in.png',  label: 'Zoom Normal' },
      btnMirrorToggle:{ src: 'assets/designs/icons/mirror.png',   label: 'Mirror' },
    };

    Object.entries(ICONS).forEach(([id]) => {
      const btn = document.getElementById(id);
      if (!btn || btn.dataset.iconInjected) return;
      btn.dataset.iconInjected = '1';
      // The HTML already contains <img> + <span> for each button.
      // No additional icon elements are injected to avoid duplicates.
    });
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * NEXT BUTTON UPGRADE — wrap existing NEXT buttons in Studrio styling
   * ═══════════════════════════════════════════════════════════════════════ */

  function _upgradeNextButtons() {
    const btns = [
      document.getElementById('btnNextFromSetup'),
      document.getElementById('btnNextFromFrame'),
      document.getElementById('btnNextFromSelection'),
      document.getElementById('btnNextFromDesign'),
    ];
    btns.forEach((btn) => {
      if (!btn) return;
      btn.classList.add('btn-next-studrio');
      // Ensure fill span exists
      if (!btn.querySelector('.btn-next-fill')) {
        const fill = document.createElement('span');
        fill.className = 'btn-next-fill';
        btn.appendChild(fill);
      }
    });
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * SETUP PHOTO TAKING HINT (below NEXT on Page 2)
   * ═══════════════════════════════════════════════════════════════════════ */

  function _injectSetupNextHint() {
    const navRow = document.querySelector('#page-setup .nav-row');
    if (!navRow || navRow.querySelector('.setup-photo-hint')) return;

    const hint = document.createElement('div');
    hint.className = 'setup-photo-hint';
    hint.style.justifyContent = 'flex-end';
    hint.innerHTML = `
      <img src="assets/designs/icons/camera.png"
           alt="camera"
           onerror="this.style.display='none'">
      <span>Photo Taking</span>`;
    navRow.after(hint);
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * SELECTION PAGE: 4-column tight grid + all-selected glow
   * ═══════════════════════════════════════════════════════════════════════ */

  function _watchSelectionCompletion() {
    const grid = document.getElementById('selectionGrid');
    if (!grid) return;

    // Guard: only fire the glow once per completed selection, not on every DOM mutation.
    // selection.js wipes innerHTML on each tap, which floods the observer with dozens
    // of simultaneous mutations. Combined with the class changes from .all-selected
    // itself, this creates a feedback loop that freezes the page on the 4th photo.
    // Fix: debounce all mutations into one deferred check, and use a lock to prevent
    // re-entry while the animation + setTimeout removal are still in flight.
    let _glowPending = false;
    let _debounceTimer = null;

    new MutationObserver(() => {
      clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => {
        if (_glowPending) return;
        const selected = grid.querySelectorAll('.photo-card.selected');
        if (selected.length >= 4) {
          _glowPending = true;
          grid.classList.add('all-selected');
          setTimeout(() => {
            grid.classList.remove('all-selected');
            _glowPending = false;
          }, 1300);
        }
      }, 80); // coalesces the full innerHTML-wipe mutation burst
    }).observe(grid, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * NAVIGATION INTERCEPTOR
   * Wraps goToPage to inject:
   *  – NEXT fill animation before navigating
   *  – Pixel-grid transition for setup→shooting and printing→home
   *  – Strip isolation + centering for selection→design and design→printing
   * ═══════════════════════════════════════════════════════════════════════ */

  function _installNavInterceptor() {
    // Wait a tick for animations.js to install its own wrapper first
    setTimeout(() => {
      if (typeof window.goToPage !== 'function') return;

      const _prevGoToPage = window.goToPage;

      window.goToPage = function (pageName) {
        const currentPage = document.querySelector('.page.active');
        const currentName = currentPage ? currentPage.dataset.page : '';

        // ── Case 1: Page 2 (setup/frame) → Page 3 (shooting)
        //    Play NEXT fill (1.5s) then pixel-grid transition
        const isSetupToShooting = (currentName === 'setup' || currentName === 'frame') && pageName === 'shooting';

        // ── Case 2: Page 4 (selection) → Page 5 (design)
        //    Play NEXT fill, fade others, center strip, then navigate
        const isSelectionToDesign = currentName === 'selection' && pageName === 'design';

        // ── Case 3: Page 5 (design) → Page 6 (printing)
        //    Same fade-other + strip centering
        const isDesignToPrinting = currentName === 'design' && pageName === 'printing';

        // ── Case 4: Page 6 (printing) Done → Page 1/home
        //    Pixel-grid transition
        const isPrintingToHome = currentName === 'printing' && (pageName === 'home' || pageName === 'setup');

        if (isSetupToShooting) {
          // Play NEXT fill on the relevant button
          const nextBtn = document.getElementById('btnNextFromSetup') || document.getElementById('btnNextFromFrame');
          playNextBtnFill(nextBtn, () => {
            playPixelGridTransition(
              () => { _prevGoToPage(pageName); },
              () => { /* done */ }
            );
          });
          return;
        }

        if (isSelectionToDesign) {
          const nextBtn  = document.getElementById('btnNextFromSelection');
          const stripEl  = document.getElementById('stripPreviewContainer');
          const page     = document.getElementById('page-selection');
          playNextBtnFill(nextBtn, () => {
            isolateStripAndNext(page, stripEl, nextBtn, () => {
              _prevGoToPage(pageName);
            });
          });
          return;
        }

        if (isDesignToPrinting) {
          const nextBtn = document.getElementById('btnNextFromDesign');
          const stripEl = document.getElementById('designPreviewContainer');
          const page    = document.getElementById('page-design');
          playNextBtnFill(nextBtn, () => {
            isolateStripAndNext(page, stripEl, nextBtn, () => {
              _prevGoToPage(pageName);
            });
          });
          return;
        }

        if (isPrintingToHome) {
          playPixelGridTransition(
            () => { _prevGoToPage(pageName); },
            () => { /* done */ }
          );
          return;
        }

        // Default: fall through to previous goToPage (animations.js handler)
        _prevGoToPage(pageName);
      };
    }, 0);
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * DONE BUTTON: also wrap to use pixel-grid transition
   * ═══════════════════════════════════════════════════════════════════════ */
  // The pixel-grid for printing→home is handled by the nav interceptor above,
  // because resetSessionAndRestart() calls goToPage("home").
  // No additional hook needed here.


  /* ═══════════════════════════════════════════════════════════════════════
   * TEMPLATE CAROUSEL: touch/pointer swipe + selection-animation suppression
   *
   * The template track-outer is made scrollable via CSS
   * (overflow-x: auto; scroll-snap-type: x mandatory in style-redesign.css).
   * This function adds pointer-drag support so click-and-drag also scrolls,
   * mirroring the design-carousel drag behaviour (_addDragScroll).
   *
   * Selection-animation suppression:
   *   app.js _selectTemplate() calls _renderCarousel() which adds .animating
   *   to the track.  To suppress the slide-in animation on selection (but keep
   *   it for category-change / arrow navigation), we intercept clicks on
   *   .template-card elements and briefly set data-selecting on the track.
   *   CSS rule  `.template-carousel-track[data-selecting] > .template-card`
   *   sets animation:none, so the fade-slide does not play.
   * ═══════════════════════════════════════════════════════════════════════ */

  function _initTemplateCarouselSwipe() {
    const outer = document.querySelector('.template-carousel-track-outer');
    if (!outer || outer.dataset.swipeReady) return;
    outer.dataset.swipeReady = '1';

    /* ── Arrow buttons: one card at a time, smooth scrollBy ─────────────────
     *
     * app.js wires Prev/Next to _scroll(±VISIBLE_COUNT) which re-renders the
     * whole carousel.  We intercept those clicks in the capture phase and
     * cancel them, then do a smooth single-card scrollBy instead.
     * Arrow disabled state is kept accurate via a scroll listener.
     */
    const prevBtn = document.getElementById('templateCarouselPrev');
    const nextBtn = document.getElementById('templateCarouselNext');

    function _getCardWidth() {
      // Width of the first rendered card, including its right gap.
      const track = outer.firstElementChild;
      if (!track) return 0;
      const card  = track.querySelector('.template-card');
      if (!card) return 0;
      // Use the card's offsetWidth plus the computed column-gap on the track.
      const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
      return card.offsetWidth + gap;
    }

    function _syncArrows() {
      if (!prevBtn || !nextBtn) return;
      const atStart = outer.scrollLeft <= 1;
      const atEnd   = outer.scrollLeft >= outer.scrollWidth - outer.clientWidth - 1;
      prevBtn.disabled = atStart;
      nextBtn.disabled = atEnd;
    }

    // Smooth single-card scroll — intercept app.js's batch _scroll() entirely.
    function _arrowScroll(dir, e) {
      e.stopImmediatePropagation();   // cancel app.js's click handler
      e.preventDefault();
      const cardW = _getCardWidth();
      if (!cardW) return;
      outer.scrollBy({ left: dir * cardW, behavior: 'smooth' });
      // Re-sync arrows after the smooth scroll settles (~350ms is enough)
      setTimeout(_syncArrows, 360);
    }

    if (prevBtn) {
      prevBtn.addEventListener('click', (e) => _arrowScroll(-1, e), { capture: true });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', (e) => _arrowScroll(+1, e), { capture: true });
    }

    // Keep arrows synced to native scroll position (touch / programmatic)
    outer.addEventListener('scroll', _syncArrows, { passive: true });

    // Initial state after first render
    requestAnimationFrame(_syncArrows);

    /* ── Pointer drag: momentum-based, 1:1 tracking then deceleration ───────
     *
     * For mouse/stylus drag (touch is handled natively by the browser with its
     * own momentum physics — we do not override touch events).
     *
     * Velocity is sampled over the last ~80ms of movement so a short fast
     * flick produces a long coast, and a slow deliberate drag stops quickly.
     *
     * Threshold: drag only begins after 6px movement, so taps always reach
     * the card's own click listener.
     */
    const DRAG_THRESHOLD = 6;
    const DECEL_FACTOR   = 0.92;   // multiply velocity each frame (0.9=fast stop, 0.95=long coast)
    const MIN_VELOCITY   = 0.5;    // px/frame below which momentum stops

    // Ring buffer for velocity sampling
    const VEL_SAMPLES    = 5;
    let _velBuf          = [];

    let _startX     = 0;
    let _lastX      = 0;
    let _lastTime   = 0;
    let _scrollLeft = 0;
    let _dragging   = false;
    let _pendingId  = null;
    let _rafId      = null;

    function _cancelMomentum() {
      if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
    }

    function _applyMomentum(vx) {
      // Exponential deceleration loop
      function step() {
        if (Math.abs(vx) < MIN_VELOCITY) {
          _syncArrows();
          return;
        }
        outer.scrollLeft += vx;
        vx *= DECEL_FACTOR;
        _rafId = requestAnimationFrame(step);
      }
      _rafId = requestAnimationFrame(step);
    }

    outer.addEventListener('pointerdown', (e) => {
      // Ignore touch pointers — the browser's native touch-momentum handles those
      if (e.pointerType === 'touch') return;

      _cancelMomentum();
      _startX     = e.pageX;
      _lastX      = e.pageX;
      _lastTime   = performance.now();
      _scrollLeft = outer.scrollLeft;
      _dragging   = false;
      _pendingId  = e.pointerId;
      _velBuf     = [];
    });

    outer.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      if (_pendingId === null) return;

      const dx   = e.pageX - _startX;
      const now  = performance.now();

      if (!_dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        _dragging = true;
        try { outer.setPointerCapture(_pendingId); } catch (_) {}
      }

      // 1:1 scroll tracking — no multiplier, feels natural
      outer.scrollLeft = _scrollLeft - dx;

      // Sample velocity (px/ms → convert to px/frame at 60fps later)
      const dt = now - _lastTime;
      if (dt > 0) {
        _velBuf.push({ v: (e.pageX - _lastX) / dt, t: now });
        if (_velBuf.length > VEL_SAMPLES) _velBuf.shift();
      }
      _lastX    = e.pageX;
      _lastTime = now;
    });

    function _end(e) {
      if (e && e.pointerType === 'touch') return;
      if (!_dragging) { _dragging = false; _pendingId = null; return; }
      _dragging  = false;
      _pendingId = null;

      // Compute average velocity from the sample buffer (px/ms)
      if (_velBuf.length) {
        const now    = performance.now();
        // Weight recent samples — keep only last 80ms
        const recent = _velBuf.filter(s => now - s.t < 80);
        const avgV   = recent.length
          ? recent.reduce((sum, s) => sum + s.v, 0) / recent.length
          : 0;
        // Convert px/ms → px/frame (16.67ms per frame at 60fps)
        const vxFrame = -avgV * 16.67;
        if (Math.abs(vxFrame) > MIN_VELOCITY) _applyMomentum(vxFrame);
      }

      _velBuf = [];
      _syncArrows();
    }

    outer.addEventListener('pointerup',     _end);
    outer.addEventListener('pointercancel', _end);
  }

  function _initTemplateSelectionAnimSuppression() {
    const track = document.getElementById('templateCarouselTrack');
    if (!track || track.dataset.selGuardReady) return;
    track.dataset.selGuardReady = '1';

    // Intercept clicks that land on a .template-card (selection action).
    // Set data-selecting before app.js's click handler fires (which calls
    // _renderCarousel → requestAnimationFrame → classList.add("animating")).
    //
    // Timing chain inside _renderCarousel after a selection click:
    //   capture click → data-selecting = '1'
    //   card click handler → _selectTemplate() → _renderCarousel()
    //     → rAF(A): track.classList.remove("animating"); reflow; classList.add("animating")
    //   rAF(B) [our guard]: delete data-selecting  ← MUST fire AFTER rAF(A)
    //
    // Two rAFs are not sufficient because rAF(A) is queued before our rAF
    // and both run in the same frame batch, meaning rAF(B) can fire before
    // the .animating class is added.  Using setTimeout(fn, 0) defers past
    // the current animation frame batch entirely, guaranteeing data-selecting
    // is still present when .animating is applied.
    track.addEventListener('click', (e) => {
      const card = e.target.closest('.template-card');
      if (!card) return;
      track.dataset.selecting = '1';
      // Clear the flag after a full event-loop turn so it outlives the rAF
      // that _renderCarousel uses to add .animating.
      setTimeout(() => { delete track.dataset.selecting; }, 0);
    }, true); // capture phase so we fire before the card's own click listener
  }

  // Re-run swipe init whenever page-template becomes active (first render
  // of .template-carousel-track-outer may not have happened on DOMContentLoaded).
  function _watchTemplatePage() {
    const templatePage = document.getElementById('page-template');
    if (!templatePage) return;
    new MutationObserver(() => {
      if (templatePage.classList.contains('active')) {
        // Small delay so app.js _renderCarousel() has run and inserted cards
        setTimeout(() => {
          _initTemplateCarouselSwipe();
          _initTemplateSelectionAnimSuppression();
        }, 80);
      }
    }).observe(templatePage, { attributes: true, attributeFilter: ['class'] });
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * PRINTING ANIMATION RESTORE
   *
   * animations.js _animatePrinterFeed() is triggered by a MutationObserver
   * on #printingVideoFrame watching for child-node additions (childList).
   * printing.js injects the strip content via `await printingModule.init()`
   * BEFORE goToPage("printing") is called — so the GSAP animation starts
   * while the page is still invisible (opacity:0 during the flash transition).
   *
   * By the time the printing page fades in (~0.5s flash), the animation is
   * already ~0.5s into its ~2s run.  Depending on timing, guests may only
   * catch the tail end of the slide-in, or miss it entirely if GSAP finished
   * before the page became visible.
   *
   * Fix: when page-printing receives the .active class, check whether
   * #printingVideoFrame already has a child.  If so, and if GSAP is available,
   * re-run the printer-feed animation fresh so guests always see it from the
   * beginning on the now-visible page.  A guard flag prevents double-firing
   * if the MutationObserver in animations.js fires at the same moment.
   * ═══════════════════════════════════════════════════════════════════════ */

  function _restorePrinterFeedAnim() {
    const printPage = document.getElementById('page-printing');
    const frame     = document.getElementById('printingVideoFrame');
    const qrCol     = document.querySelector('.printing-qr-col');
    if (!printPage || !frame) return;

    new MutationObserver(() => {
      if (!printPage.classList.contains('active')) return;
      if (typeof gsap === 'undefined') return;

      const child = frame.firstElementChild;
      if (!child) return;

      // Guard: only re-trigger once per page activation
      if (frame.dataset.animPlayed === '1') return;
      frame.dataset.animPlayed = '1';

      // Hide QR col until strip is seated (matches animations.js behaviour)
      if (qrCol) gsap.set(qrCol, { opacity: 0, x: 20 });

      // Printer-feed slide: stepwise descent matching animations.js STEPS
      gsap.killTweensOf(child); // cancel any in-progress animation from animations.js
      gsap.set(child, { y: '-110%', opacity: 1 });

      const STEPS = [
        { y: '-80%', dur: 0.20 },
        { y: '-58%', dur: 0.15 },
        { y: '-36%', dur: 0.18 },
        { y: '-18%', dur: 0.14 },
        { y: '-5%',  dur: 0.20 },
        { y:  '0%',  dur: 0.24 },
      ];

      const tl = gsap.timeline();
      STEPS.forEach(({ y, dur }, i) => {
        tl.to(child, { y, duration: dur, ease: i === STEPS.length - 1 ? 'expo.out' : 'power2.out' });
        if (i < STEPS.length - 1) {
          tl.to(child, { y: `+=${1.2}`, duration: 0.04, ease: 'power1.in' });
          tl.to(child, { y: `-=${1.2}`, duration: 0.04, ease: 'power1.out' });
        }
      });

      // Elastic settle
      tl.to(child, { y: '-1.5%', duration: 0.10, ease: 'power1.in' });
      tl.to(child, { y:   '0%',  duration: 0.22, ease: 'expo.out' });

      // QR col slides in after strip is seated
      if (qrCol) {
        tl.to(qrCol, { opacity: 1, x: 0, duration: 0.42, ease: 'expo.out' }, '+=0.12');
      }
    }).observe(printPage, { attributes: true, attributeFilter: ['class'] });

    // Reset the guard when the printing page is left so the animation
    // can replay on the next session.
    new MutationObserver(() => {
      if (!printPage.classList.contains('active')) {
        frame.dataset.animPlayed = '';
      }
    }).observe(printPage, { attributes: true, attributeFilter: ['class'] });
  }


  /* ═══════════════════════════════════════════════════════════════════════
   * INIT — run after DOMContentLoaded
   * ═══════════════════════════════════════════════════════════════════════ */

  function init() {
    _injectPageHeaders();
    _injectPrintStatusLines();
    _upgradeNextButtons();
    _injectSetupNextHint();
    _injectCameraControlIcons();
    _ensureWaveOverlay();
    _watchDoneBtnForWave();
    _watchSelectionCompletion();
    _watchDesignPage();
    _ensurePoseOverlay();

    // Template carousel: swipe support + selection-animation suppression
    _watchTemplatePage();
    // Also run immediately in case page-template is already active
    _initTemplateCarouselSwipe();
    _initTemplateSelectionAnimSuppression();

    // Printing animation restore
    _restorePrinterFeedAnim();

    // Shooting page layout
    // Wait for shooting page to be structurally ready before injecting
    const shootPage = document.getElementById('page-shooting');
    if (shootPage) {
      // Inject immediately (shooting.js builds its own elements inside .shooting-layout-solo)
      requestAnimationFrame(() => {
        _injectShootingTakenCol();
        _hookShootingThumbnails();
      });
    }

    // Install nav interceptor after other scripts have run
    _installNavInterceptor();

    // Watch for design page to convert swatches to carousel
    _watchDesignPage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
