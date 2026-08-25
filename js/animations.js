/*
 * ANIMATIONS.JS — Studrio Booth GSAP animation layer  (v3)
 *
 * Changes in v3:
 *  - Page 4: removed all card-selection animation logic.
 *    Order badges are now rendered by selection.js; CSS handles
 *    show/hide via .visible class + transition. No GSAP on tap.
 *    Kept: cards animate in when the page first becomes active.
 *  - Page 2 timer: goToPage wrapper now stamps data-active-page on
 *    #kioskTimer so CSS can reposition the timer per page.
 *  - Page 6 timer: same data-active-page approach moves the timer
 *    to the bottom-left, away from all three content columns.
 *  - All other behaviour unchanged from v2.
 */

document.addEventListener("DOMContentLoaded", () => {

  /* ─────────────────────────────────────────────────────────────────────────
   * 0. GSAP SETUP
   * ───────────────────────────────────────────────────────────────────────── */
  if (typeof gsap === "undefined") {
    console.warn("[animations] GSAP not loaded — skipping.");
    return;
  }

  if (typeof CustomEase !== "undefined") {
    CustomEase.create("studioPop",   "M0,0 C0.14,0 0.22,1 1,1");
    CustomEase.create("printerFeed", "M0,0 C0.25,0.1 0.1,1 1,1");
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const ctx = gsap.context(() => {

    /* ───────────────────────────────────────────────────────────────────────
     * 1. BUTTON FILL — left-to-right fill on pointerdown
     * ─────────────────────────────────────────────────────────────────────── */
    const FILL_DURATION = reducedMotion ? 0 : 0.38;

    function ensureFillLayer(btn) {
      if (btn.querySelector(".btn-fill-layer")) return;
      const layer = document.createElement("span");
      layer.className = "btn-fill-layer";
      Object.assign(layer.style, {
        position:        "absolute",
        inset:           "0",
        borderRadius:    "inherit",
        background:      "rgba(255,255,255,0.22)",
        transform:       "scaleX(0)",
        transformOrigin: "left center",
        pointerEvents:   "none",
        zIndex:          "0",
      });
      const pos = getComputedStyle(btn).position;
      if (pos === "static") btn.style.position = "relative";
      btn.appendChild(layer);
    }

    function animateBtnFill(btn) {
      if (btn.disabled) return;
      ensureFillLayer(btn);
      const layer = btn.querySelector(".btn-fill-layer");
      gsap.fromTo(layer,
        { scaleX: 0, opacity: 1 },
        {
          scaleX: 1,
          duration: FILL_DURATION,
          ease: typeof CustomEase !== "undefined" ? "studioPop" : "power3.out",
          onComplete: () => {
            gsap.to(layer, {
              opacity: 0, duration: 0.22, ease: "power1.in",
              onComplete: () => gsap.set(layer, { scaleX: 0, opacity: 1 }),
            });
          },
        }
      );
      gsap.fromTo(btn,
        { scale: 1 },
        { scale: 0.97, duration: 0.08, yoyo: true, repeat: 1, ease: "power2.inOut" }
      );
    }

    document.querySelectorAll(
      ".btn, .home-start-btn, .home-card-original, .home-card-tutorial, .lock-submit-btn, .qty-btn, .frame-card"
    ).forEach((btn) => btn.addEventListener("pointerdown", () => animateBtnFill(btn)));


    /* ───────────────────────────────────────────────────────────────────────
     * 2. PAGE TRANSITION — white flash + timer reposition + progress bar
     *
     * On every goToPage() call we:
     *   a) Run the white flash transition
     *   b) Stamp data-active-page on #kioskTimer for CSS repositioning
     *   c) Update #kiosk-progress step states + start bar fill animation
     *
     * Progress bar behaviour:
     *   - Visible on ALL 6 workflow pages including shooting
     *   - Hidden only on lock / boot / home
     *   - Done steps: bar instantly at 100%
     *   - Active step on timer-pages (setup/frame/selection/design/printing):
     *     bar animates from 0→100% over 60 s (CSS transition driven by JS RAF)
     *   - Active step on shooting page:
     *     bar = (shotsTaken / totalShots); updated via window.kioskProgress.setShots()
     * ─────────────────────────────────────────────────────────────────────── */

    // Full-screen flash overlay
    const flashOverlay = document.createElement("div");
    flashOverlay.id = "page-flash-overlay";
    Object.assign(flashOverlay.style, {
      position:      "absolute",
      inset:         "0",
      zIndex:        "60",
      pointerEvents: "none",
      opacity:       "0",
      background:    "#ffffff",
    });
    document.getElementById("kiosk").appendChild(flashOverlay);

    // The shared timer element — stamped with data-active-page on every nav
    const kioskTimerEl = document.getElementById("kioskTimer");

    function _stampTimerPage(pageName) {
      if (kioskTimerEl) kioskTimerEl.dataset.activePage = pageName;
    }

    // ── Progress bar state ──────────────────────────────────────────────────
    const PROGRESS_STEPS = ["setup", "frame", "shooting", "selection", "design", "printing"];
    const WORKFLOW_PAGES  = new Set(PROGRESS_STEPS); // all 6 show the bar
    const TIMER_PAGES     = new Set(["setup", "frame", "selection", "design", "printing"]);

    const progressEl = document.getElementById("kiosk-progress");

    // Fill animation RAF handle + state
    let _fillRaf   = null;
    let _fillStart = null;
    const FILL_DURATION_MS = 60000; // 60 seconds

    function _stopFillAnimation() {
      if (_fillRaf) { cancelAnimationFrame(_fillRaf); _fillRaf = null; }
      _fillStart = null;
    }

    function _setFill(stepName, fraction, skipTransition) {
      const fill = document.getElementById(`kpFill-${stepName}`);
      if (!fill) return;
      // skipTransition: true when called from the RAF loop (frame-by-frame)
      // so the CSS 0.35s ease doesn't fight the per-frame updates.
      if (skipTransition) fill.style.transition = "none";
      else fill.style.transition = "";
      fill.style.transform = `scaleX(${Math.min(1, Math.max(0, fraction))})`;
    }

    function _startTimerFill(stepName) {
      _stopFillAnimation();
      _fillStart = null;
      function tick(ts) {
        if (!_fillStart) _fillStart = ts;
        const elapsed  = ts - _fillStart;
        const fraction = Math.min(1, elapsed / FILL_DURATION_MS);
        _setFill(stepName, fraction, true); // skipTransition during RAF
        if (fraction < 1) _fillRaf = requestAnimationFrame(tick);
        else {
          // RAF done — restore transition for any future class-driven changes
          const fill = document.getElementById(`kpFill-${stepName}`);
          if (fill) fill.style.transition = "";
        }
      }
      _fillRaf = requestAnimationFrame(tick);
    }

    function _updateProgressBar(pageName) {
      if (!progressEl) return;

      // Always stamp for CSS visibility rule
      progressEl.dataset.activePage = pageName;

      if (!WORKFLOW_PAGES.has(pageName)) {
        _stopFillAnimation();
        return;
      }

      const activeIdx = PROGRESS_STEPS.indexOf(pageName);

      // Update step class states
      progressEl.querySelectorAll(".kp-step").forEach((step) => {
        const stepName = step.dataset.step;
        const stepIdx  = PROGRESS_STEPS.indexOf(stepName);
        step.classList.remove("done", "active", "future");
        if (stepIdx < activeIdx)       step.classList.add("done");
        else if (stepIdx === activeIdx) step.classList.add("active");
        else                           step.classList.add("future");
      });

      // Snap done steps to 100%, reset future steps to 0%
      PROGRESS_STEPS.forEach((name, idx) => {
        if (idx < activeIdx)       _setFill(name, 1);
        else if (idx > activeIdx)  _setFill(name, 0);
        // active step handled below
      });

      // Active step fill
      _stopFillAnimation();
      if (TIMER_PAGES.has(pageName)) {
        // Timer pages: animate 0→100% over 60s
        _setFill(pageName, 0);
        _startTimerFill(pageName);
      } else {
        // Shooting page: fill controlled externally by window.kioskProgress.setShots()
        // Also read the current shot counter value immediately on page entry
        const sc = document.getElementById("shotCounter");
        if (sc) {
          const m = (sc.textContent || "").match(/(\d+)\s+OF\s+(\d+)/i);
          if (m) {
            const completed = Math.max(0, parseInt(m[1], 10) - 1);
            const total = parseInt(m[2], 10);
            _setFill("shooting", total > 0 ? completed / total : 0, true);
          } else {
            _setFill(pageName, 0);
          }
        } else {
          _setFill(pageName, 0); // reset; shooting.js will push updates
        }
      }
    }

    // ── Public API for shooting.js ──────────────────────────────────────────
    /*
     * shooting.js calls window.kioskProgress.setShots(taken, total)
     * whenever a photo is captured. This updates the "Photo Taking" bar.
     *
     * Fallback: if shooting.js doesn't call the API, a MutationObserver
     * watches #shotCounter text (e.g. "PHOTO 3 OF 8") and derives the
     * fraction automatically so the bar always stays in sync.
     */
    window.kioskProgress = {
      setShots(taken, total) {
        if (progressEl && progressEl.dataset.activePage === "shooting") {
          _setFill("shooting", total > 0 ? taken / total : 0, true);
        }
      }
    };

    // DOM fallback — parse "PHOTO N OF T" from #shotCounter
    const shotCounterEl = document.getElementById("shotCounter");
    if (shotCounterEl) {
      new MutationObserver(() => {
        if (!progressEl || progressEl.dataset.activePage !== "shooting") return;
        const text = shotCounterEl.textContent || "";
        const m = text.match(/(\d+)\s+OF\s+(\d+)/i);
        if (m) {
          const taken = parseInt(m[1], 10);
          const total = parseInt(m[2], 10);
          // taken is the current photo number (1-based); show completed fraction
          const completed = Math.max(0, taken - 1); // shots already done
          _setFill("shooting", total > 0 ? completed / total : 0, true);
        }
      }).observe(shotCounterEl, { childList: true, characterData: true, subtree: true });
    }

    // Stamp on first load
    const initialPage     = document.querySelector(".page.active");
    const initialPageName = initialPage ? (initialPage.dataset.page || "") : "";
    if (initialPage) _stampTimerPage(initialPageName);
    _updateProgressBar(initialPageName);

    requestAnimationFrame(() => {
      if (typeof goToPage !== "function") return;

      const _originalGoToPage = goToPage;

      window.goToPage = function (pageName) {
        const currentPage = document.querySelector(".page.active");
        const nextPage    = document.querySelector(`.page[data-page="${pageName}"]`);
        if (!nextPage) { _originalGoToPage(pageName); return; }

        // Stamp timer page immediately (CSS repositioning)
        _stampTimerPage(pageName);

        // Progress bar: hide immediately on non-workflow pages;
        // for workflow pages, delay the visual update until the flash
        // clears so the bar and page content appear together.
        const isWorkflow = WORKFLOW_PAGES.has(pageName);
        if (!isWorkflow) {
          // Hide bar right away (home, lock, boot)
          _updateProgressBar(pageName);
        }
        // For workflow pages, _updateProgressBar is called after flash clears (see below)

        if (reducedMotion) { _originalGoToPage(pageName); return; }

        const isHome    = pageName === "home";
        const fromHome  = currentPage && currentPage.dataset.page === "home";
        const isSetup   = pageName === "setup";
        // Simple 1-second white transition for home↔setup (both directions)
        const useSimpleWhite = isHome || fromHome || isSetup;

        if (useSimpleWhite) {
          // Plain white overlay fade: 0.4s in, hold briefly, 0.6s out
          flashOverlay.style.background = "#ffffff";
          const tl = gsap.timeline();

          // Hide the kiosk timer during the transition so it doesn't
          // visually jump / reposition while the flash is active.
          if (kioskTimerEl) gsap.set(kioskTimerEl, { opacity: 0 });

          // Fade out current page quickly
          if (currentPage && currentPage !== nextPage) {
            tl.to(currentPage, {
              opacity: 0, duration: 0.22, ease: "power2.in",
              onComplete: () => {
                currentPage.classList.remove("active");
                gsap.set(currentPage, { opacity: 0, y: 0 });
              },
            });
          }

          // White flash rises
          tl.to(flashOverlay, { opacity: 1, duration: 0.28, ease: "power1.in" }, "-=0.08");

          // Switch page underneath; update progress bar here so it's
          // hidden under the flash until the reveal below
          tl.add(() => {
            if (isWorkflow) _updateProgressBar(pageName);
            nextPage.classList.add("active");
            gsap.set(nextPage, { opacity: 0 });
            nextPage.style.pointerEvents = "auto";
          });

          // White fades out over ~0.7s — total transition ≈ 1 s
          tl.to(flashOverlay, { opacity: 0, duration: 0.70, ease: "power2.out" }, "+=0.02");
          tl.to(nextPage,     { opacity: 1, duration: 0.55, ease: "power1.out" }, "<+=0.08");

          // Reveal the timer together with the page content
          tl.to(kioskTimerEl, { opacity: 1, duration: 0.25, ease: "power1.out" }, "<+=0.10");

          // Home entrance sequence
          if (isHome) {
            tl.add(() => _animateHomeEntrance(), "-=0.30");
          }
          return;
        }

        // All other pages: original fast flash transition
        flashOverlay.style.background = "#ffffff";
        const tl = gsap.timeline();

        // Hide timer during flash so it doesn't pop in early
        if (kioskTimerEl) gsap.set(kioskTimerEl, { opacity: 0 });

        // 1) Fade out current page
        if (currentPage && currentPage !== nextPage) {
          tl.to(currentPage, {
            opacity: 0, duration: 0.18, ease: "power2.in",
            onComplete: () => {
              currentPage.classList.remove("active");
              gsap.set(currentPage, { opacity: 0, y: 0 });
            },
          });
        }

        // 2) Flash up
        tl.to(flashOverlay, { opacity: 1, duration: 0.15, ease: "power1.in" }, "-=0.05");

        // 3) Switch page under the flash; update progress bar here too
        tl.add(() => {
          if (isWorkflow) _updateProgressBar(pageName);
          nextPage.classList.add("active");
          gsap.set(nextPage, { opacity: 0 });
          nextPage.style.pointerEvents = "auto";
        });

        // 4) Flash drops, next page reveals — timer fades in with the page
        tl.to(flashOverlay, { opacity: 0, duration: 0.32, ease: "power2.out" }, "+=0.04");
        tl.to(nextPage,     { opacity: 1, duration: 0.28, ease: "power1.out" }, "<+=0.06");
        tl.to(kioskTimerEl, { opacity: 1, duration: 0.20, ease: "power1.out" }, "<+=0.06");
      };
    });


    /* ───────────────────────────────────────────────────────────────────────
     * 3. HOME SCREEN — 3-card collage entrance animation
     * ─────────────────────────────────────────────────────────────────────── */

    const homePage = document.getElementById("page-home");

    // ── 3a. Home entrance — logo then cards staggered in ───────────────────
    function _animateHomeEntrance() {
      if (reducedMotion) return;
      const tl = gsap.timeline();

      // 3 cards stagger in from below
      tl.fromTo(".home-card",
        { opacity: 0, y: 22, scale: 0.96 },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          stagger: 0.10,
          duration: 0.50,
          ease: "expo.out",
        },
        0.15
      );
    }

    _animateHomeEntrance();


    /* ───────────────────────────────────────────────────────────────────────
     * 4. THUMBNAIL PATH FIX (Page 3 frame picker)
     * ─────────────────────────────────────────────────────────────────────── */
    const thumb2x6 = document.getElementById("frameThumb2x6");
    const thumb4x6 = document.getElementById("frameThumb4x6");
    if (thumb2x6 && !thumb2x6.src.includes("/thumbnail/")) {
      thumb2x6.src = "assets/designs/thumbnail/2x6_Strip_Thumbnail.png";
    }
    if (thumb4x6 && !thumb4x6.src.includes("/thumbnail/")) {
      thumb4x6.src = "assets/designs/thumbnail/4x6_Strip_Thumbnail.png";
    }


    /* ───────────────────────────────────────────────────────────────────────
     * 5. PAGE 4 — PHOTO SELECTION: card entrance animation only
     *
     * Order-badge logic has been moved entirely into selection.js, which
     * now renders the badge number directly inside each card's innerHTML
     * and toggles .visible to show/hide it via CSS transition.
     *
     * Here we only handle:
     *   - Cards animating in when the selection page becomes active
     *   - No per-tap animation; selection.js re-renders the grid on each tap
     * ─────────────────────────────────────────────────────────────────────── */
    const selectionPage = document.getElementById("page-selection");
    const selectionGrid = document.getElementById("selectionGrid");

    if (selectionPage && selectionGrid && !reducedMotion) {
      new MutationObserver(() => {
        if (!selectionPage.classList.contains("active")) return;
        const cards = [...selectionGrid.querySelectorAll(".photo-card")];
        if (!cards.length) return;
        gsap.fromTo(cards,
          { opacity: 0, scale: 0.88, y: 10 },
          { opacity: 1, scale: 1, y: 0, stagger: 0.04, duration: 0.38, ease: "expo.out" }
        );
      }).observe(selectionPage, { attributes: true, attributeFilter: ["class"] });
    }


    /* ───────────────────────────────────────────────────────────────────────
     * 6. PAGE 6 — PRINTING SEQUENCE
     *    Strip feeds down from the top; QR col slides in from the right.
     *    printingStatusCol is hidden (display:none) — not animated.
     * ─────────────────────────────────────────────────────────────────────── */
    const printingFrame  = document.getElementById("printingVideoFrame");
    const printingQrCol  = document.querySelector(".printing-qr-col");
    const printPage      = document.getElementById("page-printing");

    // Reset QR col to hidden whenever printing page is entered
    if (printPage) {
      new MutationObserver(() => {
        if (!printPage.classList.contains("active")) return;
        if (printingQrCol) gsap.set(printingQrCol, { opacity: 0, x: 20 });
      }).observe(printPage, { attributes: true, attributeFilter: ["class"] });
    }

    // Initial hide
    if (printingQrCol) gsap.set(printingQrCol, { opacity: 0, x: 20 });

    if (printingFrame) {
      new MutationObserver((mutations) => {
        mutations.forEach((m) =>
          m.addedNodes.forEach((node) => {
            if (node.nodeType === 1) _animatePrinterFeed(node);
          })
        );
      }).observe(printingFrame, { childList: true });
    }

    function _animatePrinterFeed(el) {
      if (reducedMotion) {
        if (printingQrCol) gsap.set(printingQrCol, { opacity: 1, x: 0 });
        return;
      }

      gsap.set(el, { y: "-110%", opacity: 1 });
      const tl = gsap.timeline();

      const STEPS = [
        { y: "-80%", dur: 0.20 },
        { y: "-58%", dur: 0.15 },
        { y: "-36%", dur: 0.18 },
        { y: "-18%", dur: 0.14 },
        { y: "-5%",  dur: 0.20 },
        { y: "0%",   dur: 0.24 },
      ];

      STEPS.forEach(({ y, dur }, i) => {
        tl.to(el, { y, duration: dur, ease: i === STEPS.length - 1 ? "expo.out" : "power2.out" });
        if (i < STEPS.length - 1) {
          tl.to(el, { y: `+=${1.2}`, duration: 0.04, ease: "power1.in" });
          tl.to(el, { y: `-=${1.2}`, duration: 0.04, ease: "power1.out" });
        }
      });

      // Elastic settle
      tl.to(el, { y: "-1.5%", duration: 0.10, ease: "power1.in" });
      tl.to(el, { y:   "0%",  duration: 0.22, ease: "expo.out" });

      // QR col slides in from the right after strip is seated
      tl.to(printingQrCol, { opacity: 1, x: 0, duration: 0.42, ease: "expo.out" }, "+=0.12");
    }


    /* ───────────────────────────────────────────────────────────────────────
     * 7. PAGE-SPECIFIC ENTRANCE STAGGER
     * ─────────────────────────────────────────────────────────────────────── */
    const PAGE_ENTRANCES = {
      "page-lock":      [".lock-logo", ".lock-subtitle", ".lock-field", ".lock-submit-btn"],
      "page-setup":     [".sb-page-header", ".setup-preview-col", ".setup-controls-col"],
      "page-frame":     [".frame-card", ".quantity-panel"],
      "page-shooting":  [".shooting-topbar", ".shooting-side-panel", ".shooting-look-text"],
      "page-selection": [".sb-page-header", ".selection-grid-col", ".selection-preview-col"],
      "page-design":    [".sb-page-header", ".design-carousel-col", ".design-preview-col"],
      "page-printing":  [".sb-page-header-printing", ".printing-video-col", ".printing-qr-col"],
    };

    Object.entries(PAGE_ENTRANCES).forEach(([pageId, selectors]) => {
      const page = document.getElementById(pageId);
      if (!page) return;
      new MutationObserver(() => {
        if (!page.classList.contains("active") || reducedMotion) return;
        const els = selectors.flatMap((s) => [...page.querySelectorAll(s)]);
        if (!els.length) return;
        gsap.fromTo(els,
          { opacity: 0, y: 12 },
          { opacity: 1, y: 0, stagger: 0.05, duration: 0.38, ease: "expo.out", delay: 0.06 }
        );
      }).observe(page, { attributes: true, attributeFilter: ["class"] });
    });


    /* ───────────────────────────────────────────────────────────────────────
     * 8. QUANTITY TICK
     * ─────────────────────────────────────────────────────────────────────── */
    const qtyNumber = document.getElementById("qtyValue");
    function tickQty(dir) {
      if (reducedMotion || !qtyNumber) return;
      const from = dir === "up" ? 14 : -14;
      const tl = gsap.timeline();
      tl.to(qtyNumber,  { y: -from, opacity: 0, duration: 0.09, ease: "power2.in" });
      tl.set(qtyNumber, { y: from });
      tl.to(qtyNumber,  { y: 0, opacity: 1, duration: 0.18, ease: "expo.out" });
    }
    document.getElementById("btnQtyMinus")?.addEventListener("click", () => tickQty("down"));
    document.getElementById("btnQtyPlus")?.addEventListener("click",  () => tickQty("up"));


    /* ───────────────────────────────────────────────────────────────────────
     * 9. MODAL POP
     * ─────────────────────────────────────────────────────────────────────── */
    function _watchModal(id) {
      const modal = document.getElementById(id);
      if (!modal) return;
      new MutationObserver(() => {
        if (!modal.classList.contains("show") || reducedMotion) return;
        const box = modal.querySelector(".modal-box");
        if (box) gsap.fromTo(box,
          { scale: 0.86, opacity: 0, y: 10 },
          { scale: 1, opacity: 1, y: 0, duration: 0.32, ease: "back.out(2.2)" }
        );
      }).observe(modal, { attributes: true, attributeFilter: ["class", "hidden"] });
    }
    _watchModal("confirmModal");
    _watchModal("endingSessionModal");


    /* ───────────────────────────────────────────────────────────────────────
     * 10. BOOT STATUS STAGGER
     * ─────────────────────────────────────────────────────────────────────── */
    const bootList = document.getElementById("bootStatusList");

    if (bootList && !reducedMotion) {
      new MutationObserver((mutations) => {
        mutations.forEach((m) =>
          m.addedNodes.forEach((node) => {
            if (node.nodeType !== 1) return;
            gsap.fromTo(node,
              { opacity: 0, x: -12 },
              { opacity: 1, x: 0, duration: 0.28, ease: "power2.out" }
            );
          })
        );
      }).observe(bootList, { childList: true });
    }


    /* ───────────────────────────────────────────────────────────────────────
     * 11. COUNTDOWN NUMBER POP
     * ─────────────────────────────────────────────────────────────────────── */
    const countdownEl = document.getElementById("countdownNumber");
    if (countdownEl && !reducedMotion) {
      new MutationObserver(() => {
        gsap.fromTo(countdownEl,
          { scale: 1.28, opacity: 0.35 },
          { scale: 1, opacity: 0.6, duration: 0.32, ease: "expo.out" }
        );
      }).observe(countdownEl, { childList: true, characterData: true, subtree: true });
    }

  }, "#kiosk"); // gsap.context scope

  window.addEventListener("beforeunload", () => ctx.revert());


  /* ═══════════════════════════════════════════════════════════════════════
   * REDESIGN LAYER — Pages 3 & 4 visual improvements
   *
   * Merged from animations-redesign.js spec. Integrates with the existing
   * HTML structure (no DOM restructuring required):
   *
   *  A. PIXEL-GRID TRANSITION — left-to-right cell fill (setup→shooting)
   *  B. NEXT BUTTON WHITE→YELLOW FILL — 1.5s animation before navigation
   *  C. PAGE 3 SHOOTING THUMBNAILS — polls sessionState.shots, injects
   *     taken-photo thumbnails into the existing .shooting-side-right panel
   *  D. PAGE 3 TAKEN-LABEL — injects a "Photos Taken" label above thumbnails
   *  E. PAGE 4 ALL-SELECTED GLOW — watches selection grid for 4 selected photos
   *  F. NAV INTERCEPTOR — wraps goToPage for setup→shooting pixel-grid anim
   * ═══════════════════════════════════════════════════════════════════════ */

  (function _redesignLayer() {

    /* ── A. PIXEL-GRID TRANSITION ─────────────────────────────────────────
     * Creates a grid of 40px squares that fill left-to-right, fires a
     * midpoint callback to switch page, then clears right-to-left.
     * Aligns with the --grid-size CSS variable (40px). */

    const CELL_SIZE        = 40;   // matches --grid-size in style-redesign.css
    const WAVE_DURATION_MS = 650;  // total left-to-right sweep time
    const CELL_STAGGER_MS  = 18;   // extra stagger per column (fractional use)

    let _pgOverlay = null;

    function _ensurePixelOverlay() {
      if (_pgOverlay) return _pgOverlay;
      _pgOverlay = document.createElement("div");
      _pgOverlay.id = "pixelGridTransitionOverlay";
      // CSS from style-redesign.css handles .active show/hide
      Object.assign(_pgOverlay.style, {
        position: "absolute", inset: "0",
        zIndex: "80", pointerEvents: "none",
        display: "none", overflow: "hidden",
      });
      document.getElementById("kiosk").appendChild(_pgOverlay);
      return _pgOverlay;
    }

    function playPixelGridTransition(onMidpoint, onComplete) {
      const overlay = _ensurePixelOverlay();
      overlay.innerHTML = "";
      overlay.style.display = "block";

      const kiosk = document.getElementById("kiosk");
      const W = kiosk.offsetWidth  || 1920;
      const H = kiosk.offsetHeight || 1080;
      const cols = Math.ceil(W / CELL_SIZE);
      const rows = Math.ceil(H / CELL_SIZE);

      const fragment = document.createDocumentFragment();
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = document.createElement("div");
          cell.style.cssText = [
            "position:absolute",
            `left:${c * CELL_SIZE}px`,
            `top:${r * CELL_SIZE}px`,
            `width:${CELL_SIZE + 1}px`,
            `height:${CELL_SIZE + 1}px`,
            "opacity:0",
            "background:#ffffff",
            "will-change:opacity",
          ].join(";");
          fragment.appendChild(cell);
        }
      }
      overlay.appendChild(fragment);

      const allCells = overlay.children;
      let midpointFired = false;

      for (let c = 0; c < cols; c++) {
        const delay = (c / cols) * WAVE_DURATION_MS + c * CELL_STAGGER_MS * 0.05;
        for (let r = 0; r < rows; r++) {
          const cell = allCells[r * cols + c];
          if (!cell) continue;
          cell.style.transitionDuration      = "90ms";
          cell.style.transitionProperty      = "opacity";
          cell.style.transitionTimingFunction = "ease-in";
          setTimeout(() => { cell.style.opacity = "1"; }, delay + r * 2);
        }
        if (!midpointFired && c / cols > 0.58) {
          midpointFired = true;
          setTimeout(() => { if (typeof onMidpoint === "function") onMidpoint(); }, delay);
        }
      }

      const fillTime = WAVE_DURATION_MS + cols * CELL_STAGGER_MS * 0.05 + rows * 2;
      setTimeout(() => {
        for (let c = cols - 1; c >= 0; c--) {
          const delay = ((cols - 1 - c) / cols) * (WAVE_DURATION_MS * 0.65);
          for (let r = 0; r < rows; r++) {
            const cell = allCells[r * cols + c];
            if (!cell) continue;
            cell.style.transitionDuration      = "120ms";
            cell.style.transitionTimingFunction = "ease-out";
            setTimeout(() => { cell.style.opacity = "0"; }, delay + r * 1.5);
          }
        }
        setTimeout(() => {
          overlay.style.display = "none";
          overlay.innerHTML = "";
          if (typeof onComplete === "function") onComplete();
        }, WAVE_DURATION_MS * 0.65 + 200);
      }, fillTime + 160);
    }


    /* ── B. NEXT BUTTON WHITE→YELLOW FILL ────────────────────────────────
     * Plays a 1.5-second left-to-right yellow fill wash on the NEXT button
     * before navigating to the next page. */

    function playNextBtnFill(btn, onComplete) {
      if (!btn) { if (onComplete) onComplete(); return; }

      let fillLayer = btn.querySelector(".btn-next-fill");
      if (!fillLayer) {
        fillLayer = document.createElement("span");
        fillLayer.className = "btn-next-fill";
        Object.assign(fillLayer.style, {
          position: "absolute", inset: "0",
          background: "linear-gradient(90deg,#ffffff 0%,#ffdd66 100%)",
          transform: "scaleX(0)", transformOrigin: "left center",
          borderRadius: "inherit", pointerEvents: "none",
          zIndex: "1", opacity: "0",
        });
        if (getComputedStyle(btn).position === "static") btn.style.position = "relative";
        btn.appendChild(fillLayer);
      }

      // Use GSAP if available, otherwise plain CSS
      if (typeof gsap !== "undefined") {
        gsap.set(fillLayer, { scaleX: 0, opacity: 0.9 });
        gsap.to(fillLayer, {
          scaleX: 1, duration: 0.9, ease: "power2.inOut",
          onComplete: () => {
            gsap.to(fillLayer, {
              opacity: 0, duration: 0.4, ease: "power1.in",
              onComplete: () => {
                gsap.set(fillLayer, { scaleX: 0, opacity: 0 });
                if (typeof onComplete === "function") onComplete();
              },
            });
          },
        });
      } else {
        setTimeout(() => { if (typeof onComplete === "function") onComplete(); }, 1500);
      }
    }


    /* ── C. PAGE 3 SHOOTING THUMBNAILS ───────────────────────────────────
     * Polls sessionState.shots every 300 ms and injects thumbnails of
     * taken photos into the existing .shooting-side-right dark panel,
     * above the existing photos-taken counter.
     * Does NOT restructure the HTML — works with the current layout. */

    function _injectShootingTakenLabel() {
      const panel = document.querySelector("#page-shooting .shooting-side-right");
      if (!panel || panel.querySelector(".shooting-side-taken-label")) return;
      const label = document.createElement("div");
      label.className = "shooting-side-taken-label";
      label.textContent = "Photos Taken";
      // Insert as the very first child (above future thumbnails)
      panel.insertBefore(label, panel.firstChild);
    }

    function _addShootingThumbnail(imageUrl, number) {
      const panel = document.querySelector("#page-shooting .shooting-side-right");
      if (!panel) return;

      const thumb = document.createElement("div");
      thumb.className = "shooting-taken-thumb";
      thumb.innerHTML = `
        <img src="${imageUrl}" alt="Photo ${number}" loading="lazy">
        <span class="shooting-taken-thumb-num">${number}</span>`;

      // Insert before the .shooting-photos-taken counter block
      const counter = panel.querySelector(".shooting-photos-taken");
      if (counter) {
        panel.insertBefore(thumb, counter);
      } else {
        panel.appendChild(thumb);
      }

      // Gentle entrance animation with GSAP if available
      if (typeof gsap !== "undefined" && !reducedMotion) {
        gsap.fromTo(thumb,
          { opacity: 0, scale: 0.85, y: -8 },
          { opacity: 1, scale: 1, y: 0, duration: 0.28, ease: "expo.out" }
        );
      }
    }

    function _hookShootingThumbnails() {
      let _lastShotCount = 0;

      const _pollId = setInterval(() => {
        if (!window.sessionState) return;
        const shots = window.sessionState.shots || [];
        if (shots.length > _lastShotCount) {
          for (let i = _lastShotCount; i < shots.length; i++) {
            const shot = shots[i];
            if (shot && shot.imageUrl) {
              _addShootingThumbnail(shot.imageUrl, i + 1);
            }
          }
          _lastShotCount = shots.length;
        }
      }, 300);

      // Reset thumbnails when shooting page becomes active again
      const shootPage = document.getElementById("page-shooting");
      if (shootPage) {
        new MutationObserver(() => {
          if (!shootPage.classList.contains("active")) return;
          _lastShotCount = 0;
          // Remove all injected thumbnails but keep the label and counter
          const panel = shootPage.querySelector(".shooting-side-right");
          if (panel) {
            panel.querySelectorAll(".shooting-taken-thumb").forEach((t) => t.remove());
          }
        }).observe(shootPage, { attributes: true, attributeFilter: ["class"] });
      }
    }


    /* ── D. PAGE 3 LABEL INJECTION ───────────────────────────────────────
     * Waits for the shooting page to be in the DOM, then injects label. */

    function _initShootingEnhancements() {
      _injectShootingTakenLabel();
      _hookShootingThumbnails();
    }


    /* ── E. PAGE 4 ALL-SELECTED GLOW ─────────────────────────────────────
     * Watches the selection grid for the moment all 4 photos are chosen
     * and temporarily adds .all-selected for the CSS glow animation. */

    function _watchSelectionCompletion() {
      const grid = document.getElementById("selectionGrid");
      if (!grid) return;

      new MutationObserver(() => {
        const selected = grid.querySelectorAll(".photo-card.selected");
        if (selected.length >= 4) {
          grid.classList.add("all-selected");
          setTimeout(() => grid.classList.remove("all-selected"), 1300);
        }
      }).observe(grid, { subtree: true, attributes: true, attributeFilter: ["class"] });
    }


    /* ── F. NAV INTERCEPTOR ───────────────────────────────────────────────
     * Wraps window.goToPage (which animations.js has already wrapped with
     * GSAP flash logic) to layer in:
     *   – setup/frame → shooting: NEXT fill then pixel-grid transition
     *   – printing → home/ticket: pixel-grid transition
     * All other routes fall through to the existing GSAP flash handler. */

    function _installNavInterceptor() {
      // Run after animations.js's own DOMContentLoaded + rAF wrapper
      setTimeout(() => {
        if (typeof window.goToPage !== "function") return;

        const _prevGoToPage = window.goToPage;

        window.goToPage = function (pageName) {
          const currentPage = document.querySelector(".page.active");
          const currentName = currentPage ? (currentPage.dataset.page || "") : "";

          // setup/frame → shooting: fill then pixel-grid
          const isSetupToShooting =
            (currentName === "setup" || currentName === "frame") && pageName === "shooting";

          // printing → home/ticket: pixel-grid
          const isPrintingToHome =
            currentName === "printing" && (pageName === "home" || pageName === "ticket");

          if (isSetupToShooting) {
            const nextBtn =
              document.getElementById("btnNextFromSetup") ||
              document.getElementById("btnNextFromFrame");
            playNextBtnFill(nextBtn, () => {
              playPixelGridTransition(
                () => { _prevGoToPage(pageName); },
                () => { /* sweep complete */ }
              );
            });
            return;
          }

          if (isPrintingToHome) {
            playPixelGridTransition(
              () => { _prevGoToPage(pageName); },
              () => { /* sweep complete */ }
            );
            return;
          }

          // Default: use existing GSAP flash transition
          _prevGoToPage(pageName);
        };
      }, 50); // small delay so animations.js rAF wrapper has already installed
    }


    /* ── INIT ─────────────────────────────────────────────────────────────*/
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        _initShootingEnhancements();
        _watchSelectionCompletion();
        _installNavInterceptor();
      });
    } else {
      _initShootingEnhancements();
      _watchSelectionCompletion();
      _installNavInterceptor();
    }

  })(); // end _redesignLayer

}); // end DOMContentLoaded
