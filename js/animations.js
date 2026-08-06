/*
 * ANIMATIONS.JS — Studrio Booth GSAP animation layer  (v2)
 *
 * Changes in v2:
 *  - Replaced blob wipe with full-screen white fade-in → fade-out transition
 *  - Home: logo visible first, then Start button fades in after
 *  - Page 6: video strip prints first; QR card + status col animate in after
 *  - Page 4: photo cards animate in; selected state highlights border only;
 *            checkmark replaced by selection-order number (1, 2, 3, 4)
 *  - Page 3: thumbnail paths corrected to assets/designs/thumbnail/
 *
 * Unchanged: button fill, qty tick, modal pop, boot stagger, countdown pop,
 *            floating home objects, page entrance stagger, goToPage wrapper
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
     * 2. PAGE TRANSITION — white full-screen fade-in → fade-out
     *
     * A plain white overlay flashes on every page change:
     *   current page fades out → white covers everything → next page fades in
     *   → white fades away.
     * For the "home" destination the overlay is warmer (amber-tinted) to
     * complement the golden home screen.
     * ─────────────────────────────────────────────────────────────────────── */

    // Build the full-screen flash overlay once
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

    requestAnimationFrame(() => {
      if (typeof goToPage !== "function") return;

      const _originalGoToPage = goToPage;

      window.goToPage = function (pageName) {
        const currentPage = document.querySelector(".page.active");
        const nextPage    = document.querySelector(`.page[data-page="${pageName}"]`);
        if (!nextPage) { _originalGoToPage(pageName); return; }

        if (reducedMotion) { _originalGoToPage(pageName); return; }

        const isHome = pageName === "home";

        // Tint the flash warmer when returning to Home
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

        // 2) Flash overlay comes up
        tl.to(flashOverlay, { opacity: 1, duration: 0.15, ease: "power1.in" }, "-=0.05");

        // 3) Switch page while covered
        tl.add(() => {
          nextPage.classList.add("active");
          gsap.set(nextPage, { opacity: 0 });
          nextPage.style.pointerEvents = "auto";
        });

        // 4) Flash drops, next page reveals
        tl.to(flashOverlay, { opacity: 0, duration: 0.32, ease: "power2.out" }, "+=0.04");
        tl.to(nextPage,     { opacity: 1, duration: 0.28, ease: "power1.out" }, "<+=0.06");

        // 5) If going home, trigger the entrance sequence
        if (isHome) {
          tl.add(() => _animateHomeEntrance(), "-=0.18");
        }
      };
    });


    /* ───────────────────────────────────────────────────────────────────────
     * 3. HOME SCREEN — floating objects + staged logo then button entrance
     *
     * Logo is always visible (opacity set to 1) on first load and fades in
     * on return visits. Start button fades in 0.5 s after the logo.
     * ─────────────────────────────────────────────────────────────────────── */

    const homePage   = document.getElementById("page-home");
    const homeCenter = homePage.querySelector(".home-center");

    // ── 3a. Inject floating sprite shards ──────────────────────────────────
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
      // Try the Objects.jpg sprite; gradient is the fallback
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
      // Attempt to load Objects.jpg as a sprite sheet overlay
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

    // ── 3c. Home entrance — logo first, then button ─────────────────────────
    function _animateHomeEntrance() {
      if (reducedMotion) return;

      const tl = gsap.timeline();

      // Floating shards fade in
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

      // Logo is immediately visible — fade in from nearly-full opacity
      tl.fromTo(".home-logo",
        { opacity: 0, y: 16, scale: 0.96 },
        { opacity: 1, y: 0,  scale: 1, duration: 0.55, ease: "expo.out" },
        0.1  // slight delay after flash clears
      );

      // Start button appears after logo is settled
      tl.fromTo(".home-start-btn",
        { opacity: 0, y: 10, scale: 0.92 },
        { opacity: 1, y: 0,  scale: 1, duration: 0.45, ease: "back.out(1.8)" },
        0.55  // 0.45 s after logo starts = logo is 82% done
      );
    }

    // First-load entrance
    _animateHomeEntrance();
    _startFloating();


    /* ───────────────────────────────────────────────────────────────────────
     * 4. PAGE 3 — THUMBNAIL PATH FIX
     *
     * app.js sets frameThumb src at bottom. We override them here to point at
     * the correct nested folder so the images actually load.
     * ─────────────────────────────────────────────────────────────────────── */
    const thumb2x6 = document.getElementById("frameThumb2x6");
    const thumb4x6 = document.getElementById("frameThumb4x6");
    // Correct paths — update only if app.js used the old flat path
    if (thumb2x6 && !thumb2x6.src.includes("/thumbnail/")) {
      thumb2x6.src = "assets/designs/thumbnail/2x6_Strip_Thumbnail.png";
    }
    if (thumb4x6 && !thumb4x6.src.includes("/thumbnail/")) {
      thumb4x6.src = "assets/designs/thumbnail/4x6_Strip_Thumbnail.png";
    }


    /* ───────────────────────────────────────────────────────────────────────
     * 5. PAGE 4 — PHOTO SELECTION
     *    a) Cards animate in on page activation
     *    b) Selected state: animated border only (no fill overlay)
     *    c) Badge shows selection ORDER NUMBER, not a checkmark
     * ─────────────────────────────────────────────────────────────────────── */
    const selectionPage = document.getElementById("page-selection");
    const selectionGrid = document.getElementById("selectionGrid");

    // Track selection order: photoCard el → order number (1-based)
    const selectionOrder = new Map();
    let   selectionSeq   = 0;

    // Called by patch below when a card is clicked; mirrors logic in selection.js
    function _handlePhotoCardToggle(card) {
      const isNowSelected = card.classList.contains("selected");
      const badge = card.querySelector(".photo-card-order-badge");

      if (isNowSelected) {
        // Newly selected — assign next order number
        selectionSeq++;
        selectionOrder.set(card, selectionSeq);
        if (badge) badge.textContent = selectionSeq;

        // Animated border pulse
        if (!reducedMotion) {
          gsap.fromTo(card,
            { boxShadow: "0 0 0 0px rgba(245,166,35,0)" },
            {
              boxShadow: "0 0 0 0px rgba(245,166,35,0)",
              keyframes: [
                { boxShadow: "0 0 0 5px rgba(245,166,35,0.55)", duration: 0.15 },
                { boxShadow: "0 0 0 3px rgba(245,166,35,0.25)", duration: 0.25 },
              ],
              ease: "power2.out",
            }
          );
          // Scale pop
          gsap.fromTo(card,
            { scale: 1 },
            { scale: 1.03, duration: 0.12, yoyo: true, repeat: 1, ease: "power2.out" }
          );
          // Badge pop
          if (badge) {
            gsap.fromTo(badge,
              { scale: 0, opacity: 0 },
              { scale: 1, opacity: 1, duration: 0.2, ease: "back.out(2.5)" }
            );
          }
        }
      } else {
        // Deselected — remove from order map and renumber remaining
        selectionOrder.delete(card);
        if (badge) {
          if (!reducedMotion) {
            gsap.to(badge, {
              scale: 0, opacity: 0, duration: 0.15, ease: "power2.in",
              onComplete: () => { badge.textContent = ""; },
            });
          } else {
            badge.textContent = "";
          }
        }
        // Renumber all remaining selected cards in insertion order
        let n = 0;
        selectionOrder.forEach((_, c) => {
          n++;
          selectionOrder.set(c, n);
          const b = c.querySelector(".photo-card-order-badge");
          if (b) b.textContent = n;
        });
        selectionSeq = n;
        // Border pulse off
        if (!reducedMotion) {
          gsap.to(card, { boxShadow: "0 0 0 0px rgba(245,166,35,0)", duration: 0.2 });
        }
      }
    }

    // Inject order badge + wire toggle onto each .photo-card
    // Cards are injected dynamically by selection.js; observe the grid
    function _upgradePhotoCards() {
      selectionGrid.querySelectorAll(".photo-card").forEach((card) => {
        if (card.dataset.animUpgraded) return; // skip already upgraded
        card.dataset.animUpgraded = "1";

        // Replace the checkmark badge with an order badge
        let check = card.querySelector(".photo-card-check");
        if (check) check.remove();

        const badge = document.createElement("div");
        badge.className = "photo-card-order-badge";
        Object.assign(badge.style, {
          position:     "absolute",
          top:          "0.5vh",
          right:        "0.5vh",
          width:        "2.4vh",
          height:       "2.4vh",
          borderRadius: "50%",
          background:   "var(--anim-amber, #F5A623)",
          color:        "#fff",
          fontSize:     "1.3vh",
          fontWeight:   "800",
          display:      "flex",
          alignItems:   "center",
          justifyContent: "center",
          opacity:      "0",
          transform:    "scale(0)",
          zIndex:       "3",
          pointerEvents:"none",
          lineHeight:   "1",
        });
        card.appendChild(badge);

        // Hook into click — fires after selection.js has already toggled the class
        card.addEventListener("click", () => {
          // Use rAF so selection.js class toggle has applied first
          requestAnimationFrame(() => _handlePhotoCardToggle(card));
        });
      });
    }

    // Cards animate in when the page becomes active
    if (selectionPage && !reducedMotion) {
      const selPageObs = new MutationObserver(() => {
        if (!selectionPage.classList.contains("active")) return;
        const cards = [...selectionGrid.querySelectorAll(".photo-card")];
        if (!cards.length) return;
        _upgradePhotoCards();
        gsap.fromTo(cards,
          { opacity: 0, scale: 0.86, y: 12 },
          { opacity: 1, scale: 1, y: 0, stagger: 0.045, duration: 0.4, ease: "expo.out" }
        );
      });
      selPageObs.observe(selectionPage, { attributes: true, attributeFilter: ["class"] });

      // Also watch for new cards injected into the grid
      const gridObs = new MutationObserver(() => {
        _upgradePhotoCards();
        if (!selectionPage.classList.contains("active")) return;
        const newCards = [...selectionGrid.querySelectorAll(".photo-card:not([data-anim-visible])")];
        if (!newCards.length) return;
        newCards.forEach((c) => c.setAttribute("data-anim-visible", "1"));
        gsap.fromTo(newCards,
          { opacity: 0, scale: 0.86, y: 12 },
          { opacity: 1, scale: 1, y: 0, stagger: 0.045, duration: 0.4, ease: "expo.out" }
        );
      });
      gridObs.observe(selectionGrid, { childList: true });
    }

    // Reset selection tracking when a session resets
    // (app.js calls goToPage("home") → resetSessionAndRestart clears the grid)
    const origReset = window.resetSessionAndRestart;
    if (typeof origReset === "function") {
      window.resetSessionAndRestart = async function () {
        selectionOrder.clear();
        selectionSeq = 0;
        return origReset.apply(this, arguments);
      };
    }


    /* ───────────────────────────────────────────────────────────────────────
     * 6. PAGE 6 — PRINTING SEQUENCE
     *
     * Correct order:
     *   a) Page title fades in
     *   b) Video strip animates in via printer-feed (mechanical steps)
     *   c) Once strip is settled → status column slides in from left
     *   d) QR card slides in from right
     *
     * #printingStatusCol and .printing-qr-col start invisible (set by CSS:
     *   opacity:0 in animations.css) and are revealed by the sequence.
     * ─────────────────────────────────────────────────────────────────────── */
    const printingFrame = document.getElementById("printingVideoFrame");

    // Hide the side columns immediately; they reveal after the strip feeds
    const printingStatusCol = document.getElementById("printingStatusCol");
    const printingQrCol     = document.querySelector(".printing-qr-col");

    if (printingStatusCol) gsap.set(printingStatusCol, { opacity: 0, x: -20 });
    if (printingQrCol)     gsap.set(printingQrCol,     { opacity: 0, x:  20 });

    // Watch for the page becoming active so we can reset side-col visibility
    const printPage = document.getElementById("page-printing");
    if (printPage) {
      const printPageObs = new MutationObserver(() => {
        if (!printPage.classList.contains("active")) return;
        // Reset side cols every time this page is entered
        if (printingStatusCol) gsap.set(printingStatusCol, { opacity: 0, x: -20 });
        if (printingQrCol)     gsap.set(printingQrCol,     { opacity: 0, x:  20 });
      });
      printPageObs.observe(printPage, { attributes: true, attributeFilter: ["class"] });
    }

    if (printingFrame) {
      const feedObserver = new MutationObserver((mutations) => {
        mutations.forEach((m) => {
          m.addedNodes.forEach((node) => {
            if (node.nodeType !== 1) return;
            _animatePrinterFeed(node);
          });
        });
      });
      feedObserver.observe(printingFrame, { childList: true });
    }

    function _animatePrinterFeed(el) {
      if (reducedMotion) {
        // In reduced-motion mode, just reveal the side cols immediately
        if (printingStatusCol) gsap.set(printingStatusCol, { opacity: 1, x: 0 });
        if (printingQrCol)     gsap.set(printingQrCol,     { opacity: 1, x: 0 });
        return;
      }

      gsap.set(el, { y: "-110%", opacity: 1 });

      const tl = gsap.timeline();

      // Mechanical feed steps
      const STEPS = [
        { y: "-80%", dur: 0.20 },
        { y: "-58%", dur: 0.15 },
        { y: "-36%", dur: 0.18 },
        { y: "-18%", dur: 0.14 },
        { y: "-5%",  dur: 0.20 },
        { y: "0%",   dur: 0.24 },
      ];

      STEPS.forEach(({ y, dur }, i) => {
        tl.to(el, {
          y,
          duration: dur,
          ease: i === STEPS.length - 1 ? "expo.out" : "power2.out",
        });
        if (i < STEPS.length - 1) {
          tl.to(el, { y: `+=${1.2}`, duration: 0.04, ease: "power1.in" });
          tl.to(el, { y: `-=${1.2}`, duration: 0.04, ease: "power1.out" });
        }
      });

      // Elastic settle
      tl.to(el, { y: "-1.5%", duration: 0.1,  ease: "power1.in" });
      tl.to(el, { y:   "0%",  duration: 0.22, ease: "expo.out" });

      // Strip done → reveal side columns with a 0.1 s gap between them
      tl.to(printingStatusCol, {
        opacity: 1, x: 0,
        duration: 0.42, ease: "expo.out",
      }, "+=0.12");

      tl.to(printingQrCol, {
        opacity: 1, x: 0,
        duration: 0.42, ease: "expo.out",
      }, "-=0.28");
    }


    /* ───────────────────────────────────────────────────────────────────────
     * 7. PAGE-SPECIFIC ENTRANCE STAGGER
     * ─────────────────────────────────────────────────────────────────────── */
    const PAGE_ENTRANCES = {
      "page-lock":   [".lock-logo", ".lock-subtitle", ".lock-field", ".lock-submit-btn"],
      "page-setup":  [".setup-header", ".preview-panel", ".status-box", ".zoom-controls", ".nav-row"],
      "page-frame":  [".page-title", ".frame-card", ".quantity-panel"],
      "page-design": [".page-title", ".design-swatch", ".design-preview-panel"],
    };

    Object.entries(PAGE_ENTRANCES).forEach(([pageId, selectors]) => {
      const page = document.getElementById(pageId);
      if (!page) return;
      const obs = new MutationObserver(() => {
        if (!page.classList.contains("active") || reducedMotion) return;
        const els = selectors.flatMap((s) => [...page.querySelectorAll(s)]);
        if (!els.length) return;
        gsap.fromTo(els,
          { opacity: 0, y: 12 },
          { opacity: 1, y: 0, stagger: 0.05, duration: 0.38, ease: "expo.out", delay: 0.06 }
        );
      });
      obs.observe(page, { attributes: true, attributeFilter: ["class"] });
    });


    /* ───────────────────────────────────────────────────────────────────────
     * 8. QUANTITY TICK
     * ─────────────────────────────────────────────────────────────────────── */
    const qtyNumber = document.getElementById("qtyValue");
    function tickQty(dir) {
      if (reducedMotion || !qtyNumber) return;
      const from = dir === "up" ? 14 : -14;
      const tl = gsap.timeline();
      tl.to(qtyNumber, { y: -from, opacity: 0, duration: 0.09, ease: "power2.in" });
      tl.set(qtyNumber, { y: from });
      tl.to(qtyNumber, { y: 0, opacity: 1, duration: 0.18, ease: "expo.out" });
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
