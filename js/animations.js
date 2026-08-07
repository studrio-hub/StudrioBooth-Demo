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
      ".btn, .home-start-btn, .lock-submit-btn, .qty-btn, .frame-card"
    ).forEach((btn) => btn.addEventListener("pointerdown", () => animateBtnFill(btn)));


    /* ───────────────────────────────────────────────────────────────────────
     * 2. PAGE TRANSITION — white flash + data-active-page for timer position
     *
     * On every goToPage() call we:
     *   a) Run the white flash transition (unchanged from v2)
     *   b) Stamp data-active-page="<pageName>" on #kioskTimer so CSS can
     *      reposition it per page without any JS layout calculation.
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

    // Stamp on first load with whatever page is currently active
    const initialPage = document.querySelector(".page.active");
    if (initialPage) _stampTimerPage(initialPage.dataset.page || "");

    requestAnimationFrame(() => {
      if (typeof goToPage !== "function") return;

      const _originalGoToPage = goToPage;

      window.goToPage = function (pageName) {
        const currentPage = document.querySelector(".page.active");
        const nextPage    = document.querySelector(`.page[data-page="${pageName}"]`);
        if (!nextPage) { _originalGoToPage(pageName); return; }

        // Always update the timer position attribute immediately
        _stampTimerPage(pageName);

        if (reducedMotion) { _originalGoToPage(pageName); return; }

        const isHome = pageName === "home";

        flashOverlay.style.background = isHome
          ? "linear-gradient(135deg, #fffbeb 0%, #ffffff 100%)"
          : "#ffffff";

        const tl = gsap.timeline();

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

        // 3) Switch page under the flash
        tl.add(() => {
          nextPage.classList.add("active");
          gsap.set(nextPage, { opacity: 0 });
          nextPage.style.pointerEvents = "auto";
        });

        // 4) Flash drops, next page reveals
        tl.to(flashOverlay, { opacity: 0, duration: 0.32, ease: "power2.out" }, "+=0.04");
        tl.to(nextPage,     { opacity: 1, duration: 0.28, ease: "power1.out" }, "<+=0.06");

        // 5) Home entrance sequence
        if (isHome) {
          tl.add(() => _animateHomeEntrance(), "-=0.18");
        }
      };
    });


    /* ───────────────────────────────────────────────────────────────────────
     * 3. HOME SCREEN — floating objects + staged logo then button entrance
     * ─────────────────────────────────────────────────────────────────────── */

    const homePage   = document.getElementById("page-home");
    const homeCenter = homePage.querySelector(".home-center");

    // ── 3a. Floating sprite shards ──────────────────────────────────────────
    const OBJECT_SPRITES = [
      { x: 6,  y: 8,  s: "9vmin",  o: 0.55, r: -12, color: "#f5a623" },
      { x: 82, y: 6,  s: "8vmin",  o: 0.45, r: 8,   color: "#e63f3f" },
      { x: 20, y: 78, s: "11vmin", o: 0.42, r: 6,   color: "#f0c231" },
      { x: 75, y: 72, s: "13vmin", o: 0.38, r: -5,  color: "#ec4899" },
      { x: 48, y: 85, s: "7vmin",  o: 0.50, r: 15,  color: "#f5a623" },
      { x: 88, y: 38, s: "10vmin", o: 0.35, r: -8,  color: "#ec4899" },
      { x: 10, y: 50, s: "12vmin", o: 0.38, r: 4,   color: "#3b82f6" },
      { x: 60, y: 10, s: "9vmin",  o: 0.44, r: -4,  color: "#ec4899" },
    ];

    const floatLayer = document.createElement("div");
    floatLayer.id    = "home-float-layer";
    Object.assign(floatLayer.style, {
      position:      "absolute",
      inset:         "0",
      zIndex:        "5",
      pointerEvents: "none",
      overflow:      "hidden",
    });
    homePage.insertBefore(floatLayer, homeCenter);

    const floatShards = [];
    OBJECT_SPRITES.forEach((sp, i) => {
      const el = document.createElement("div");
      el.className = "home-float-shard";
      Object.assign(el.style, {
        position:      "absolute",
        left:          `${sp.x}%`,
        top:           `${sp.y}%`,
        width:         sp.s,
        height:        sp.s,
        borderRadius:  "50%",
        opacity:       "0",
        transform:     `rotate(${sp.r}deg)`,
        mixBlendMode:  "multiply",
        willChange:    "transform, opacity",
        background:    `radial-gradient(circle, ${sp.color}cc 0%, ${sp.color}44 100%)`,
      });
      el.style.backgroundImage = "url('assets/designs/objects.jpg')";
      el.style.backgroundSize  = "500% 500%";
      el.style.backgroundPositionX = `${(i % 4) * 33}%`;
      el.style.backgroundPositionY = `${Math.floor(i / 4) * 50}%`;
      floatLayer.appendChild(el);
      floatShards.push(el);
    });

    // ── 3b. Continuous float loop ───────────────────────────────────────────
    function _startFloating() {
      if (reducedMotion) return;
      floatShards.forEach((el, i) => {
        gsap.to(el, {
          y: `+=${6 + (i % 4) * 3}`,
          x: `+=${4 + (i % 3) * 2}`,
          rotation: `+=${(i % 2 === 0 ? 1 : -1) * 4}`,
          duration: 3.5 + i * 0.4,
          delay: i * 0.3,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
        });
      });
    }

    // ── 3c. Home entrance — logo first, button after ────────────────────────
    function _animateHomeEntrance() {
      if (reducedMotion) return;
      const tl = gsap.timeline();

      tl.fromTo(floatShards,
        { opacity: 0, scale: 0.7 },
        {
          opacity: (i) => OBJECT_SPRITES[i]?.o ?? 0.4,
          scale:   1,
          stagger: 0.06,
          duration: 0.65,
          ease:    "expo.out",
        },
        0
      );

      tl.fromTo(".home-logo",
        { opacity: 0, y: 16, scale: 0.96 },
        { opacity: 1, y: 0,  scale: 1, duration: 0.55, ease: "expo.out" },
        0.1
      );

      tl.fromTo(".home-start-btn",
        { opacity: 0, y: 10, scale: 0.92 },
        { opacity: 1, y: 0,  scale: 1, duration: 0.45, ease: "back.out(1.8)" },
        0.55
      );
    }

    _animateHomeEntrance();
    _startFloating();


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
     *    Strip feeds first; status col + QR col slide in after.
     * ─────────────────────────────────────────────────────────────────────── */
    const printingFrame    = document.getElementById("printingVideoFrame");
    const printingStatusCol = document.getElementById("printingStatusCol");
    const printingQrCol     = document.querySelector(".printing-qr-col");
    const printPage         = document.getElementById("page-printing");

    // Reset side cols to hidden whenever printing page is entered
    if (printPage) {
      new MutationObserver(() => {
        if (!printPage.classList.contains("active")) return;
        if (printingStatusCol) gsap.set(printingStatusCol, { opacity: 0, x: -20 });
        if (printingQrCol)     gsap.set(printingQrCol,     { opacity: 0, x:  20 });
      }).observe(printPage, { attributes: true, attributeFilter: ["class"] });
    }

    // Initial hide
    if (printingStatusCol) gsap.set(printingStatusCol, { opacity: 0, x: -20 });
    if (printingQrCol)     gsap.set(printingQrCol,     { opacity: 0, x:  20 });

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
        if (printingStatusCol) gsap.set(printingStatusCol, { opacity: 1, x: 0 });
        if (printingQrCol)     gsap.set(printingQrCol,     { opacity: 1, x: 0 });
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

      // Side columns appear after strip is seated
      tl.to(printingStatusCol, { opacity: 1, x: 0, duration: 0.42, ease: "expo.out" }, "+=0.12");
      tl.to(printingQrCol,     { opacity: 1, x: 0, duration: 0.42, ease: "expo.out" }, "-=0.28");
    }


    /* ───────────────────────────────────────────────────────────────────────
     * 7. PAGE-SPECIFIC ENTRANCE STAGGER
     * ─────────────────────────────────────────────────────────────────────── */
    const PAGE_ENTRANCES = {
      "page-lock":   [".lock-logo", ".lock-subtitle", ".lock-field", ".lock-submit-btn"],
      "page-setup":  [".setup-header", ".preview-panel", ".zoom-controls", ".nav-row"],
      "page-frame":  [".page-title", ".frame-card", ".quantity-panel"],
      "page-design": [".page-title", ".design-swatch", ".design-preview-panel"],
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

}); // end DOMContentLoaded
