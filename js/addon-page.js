/*
 * ADDON-PAGE.JS — Print Preview / Add-On Page
 *
 * Sits between Page 4 (Photo Selection) and Page 6 (Printing).
 * Replaces the old keychain pop-up modal that keychainAddon.js injected
 * via a capturing listener on #btnNextFromSelection.
 *
 * WHAT THIS FILE DOES
 * ───────────────────
 * 1. Intercepts the "Next ›" button on Page 4 (capturing phase, same as
 *    keychain-addon.js) and redirects to the new "addon" page instead of
 *    proceeding directly to printing.
 *
 * 2. On the addon page, renders a LIVE PREVIEW using the actual composited
 *    strip canvas (via stripModule.compositeLayoutPreview) for each of the
 *    three option cards:
 *
 *    Option A — No Add-On
 *      Prints the standard package.
 *      For 2×6: 2 copies of the selected strip (the default 2-up sheet).
 *      For 4×6: 1 copy (the standard 4×6 sheet).
 *      Preview: strip shown once (× 2 for 2×6, × 1 for 4×6).
 *
 *    Option B — Replace Second Frame as Keychain  [2×6 only]
 *      Prints 1× 2×6 strip + 2× Mini-Strip Keychain frames.
 *      No extra charge (replaces the second standard strip).
 *      Preview: 1 strip + 2 mini-strip thumbnails.
 *
 *    Option C — Add a Keychain Print  [2×6 only]
 *      Prints the full standard package PLUS a keychain add-on sheet.
 *      Adds +₱25 to the session total.
 *      Preview: 2 strips + 2 mini-strip thumbnails.
 *
 * 3. Sets sessionState.addonChoice: "none" | "replace" | "add"
 *    and sessionState.keychainAddonSelected: false | "replace" | "add"
 *    for printing.js to read.
 *
 * 4. For 4×6 sessions, Options B and C are hidden (keychain is 2×6 only).
 *    The page auto-selects Option A and advances immediately.
 *    (This matches the original behavior where keychainAddon only fires
 *    when frameType === "2×6".)
 *
 * INTEGRATION
 * ───────────
 * • Loaded AFTER strip.js, keychain-addon.js, selection.js, app.js.
 * • keychain-addon.js is still loaded (for exportPrintPNG) but its
 *   _wireIntercept() is superseded by addonPage._wireIntercept() below.
 *   Both attach DOMContentLoaded listeners; the one that runs last wins
 *   for the capturing click — they both call the same btn, but this
 *   module's handler runs FIRST in the capture chain because it is
 *   registered last at the same event target, and capture listeners
 *   on the same element fire in registration order.
 *   → To avoid conflicts, this module sets btn._addonPageWired = true and
 *     keychainAddon's _wireIntercept() is a no-op when that flag is set.
 *
 * PRINTING.JS CHANGES REQUIRED
 * ─────────────────────────────
 * printing.js._autoPrint() must read sessionState.addonChoice and branch:
 *   "none"    → standard print (quantity copies of the main sheet)
 *   "replace" → 1 copy of keychain export sheet (left strip + 2 mini)
 *   "add"     → standard print (quantity copies) + 1 keychain sheet
 */

"use strict";

const addonPage = (() => {

  // ── State ─────────────────────────────────────────────────────────────────
  let _stripCanvas    = null;  // Promise<HTMLCanvasElement> — single strip canvas
  let _stripDataUrl   = null;  // resolved data URL for fast re-use in cards

  // ── DOM refs ──────────────────────────────────────────────────────────────
  function _page()   { return document.getElementById("page-addon"); }
  function _cardA()  { return document.getElementById("addonCardNone"); }
  function _cardB()  { return document.getElementById("addonCardReplace"); }
  function _cardC()  { return document.getElementById("addonCardAdd"); }
  function _btnNext(){ return document.getElementById("btnAddonNext"); }

  // ── Init: called when we arrive on the addon page ─────────────────────────
  async function init() {
    const page = _page();
    if (!page) { console.warn("[addonPage] #page-addon not found"); return; }

    // Reset previous selection
    sessionState.addonChoice = "none";
    _selectCard("none", /* silent */ true);

    // For 4×6: skip the page entirely — auto-proceed with no add-on.
    if (sessionState.frameType !== "2x6") {
      sessionState.addonChoice         = "none";
      sessionState.keychainAddonSelected = false;
      _proceed();
      return;
    }

    // Start the kiosk timer (60s → auto-select No Add-On and proceed)
    kioskTimer.start(60, () => {
      sessionState.addonChoice         = "none";
      sessionState.keychainAddonSelected = false;
      _proceed();
    });

    // Build/render the strip preview in all cards
    await _renderAllPreviews();
  }

  // ── Render strip previews into each option card ───────────────────────────
  async function _renderAllPreviews() {
    // Render a true single-strip preview canvas using the same method as Page 4.
    const previewCanvas = await stripModule.compositeLayoutPreview({
      frameType:     sessionState.frameType,
      selectedShots: sessionState.selectedShots,
      designId:      sessionState.design
    });

    // Cache as data URL so we can clone it into multiple <img> elements
    // without re-compositing. toDataURL on a modest canvas is cheap.
    _stripDataUrl = previewCanvas ? previewCanvas.toDataURL("image/jpeg", 0.88) : null;

    if (!_stripDataUrl) return;

    // Option A — No Add-On: show strip × 2 (the 2-up print sheet)
    _populatePreviewA();

    // Option B — Replace: show 1 strip + 2 mini-strip thumbnails
    _populatePreviewB();

    // Option C — Add: show 2 strips + 2 mini-strip thumbnails
    _populatePreviewC();
  }

  function _stripImg(extraClass) {
    const img = document.createElement("img");
    img.src = _stripDataUrl;
    img.alt = "Strip preview";
    img.className = "addon-strip-img" + (extraClass ? " " + extraClass : "");
    return img;
  }

  function _miniImg(extraClass) {
    // Mini-strip is the same strip image displayed at 2:3 aspect (narrower).
    // The template overlay is not shown here — just the photo content — which
    // gives a clear visual of the keychain size versus the standard strip.
    const img = document.createElement("img");
    img.src = _stripDataUrl;
    img.alt = "Mini-strip keychain";
    img.className = "addon-mini-img" + (extraClass ? " " + extraClass : "");
    return img;
  }

  function _populatePreviewA() {
    const el = document.getElementById("addonPreviewA");
    if (!el) return;
    el.innerHTML = "";
    // For 2×6 standard print: 2 copies of the strip side by side
    el.appendChild(_stripImg());
    el.appendChild(_stripImg());
  }

  function _populatePreviewB() {
    const el = document.getElementById("addonPreviewB");
    if (!el) return;
    el.innerHTML = "";
    // Left column: 1 standard 2×6 strip
    const stripWrap = document.createElement("div");
    stripWrap.className = "addon-preview-strip-col";
    stripWrap.appendChild(_stripImg());
    // Right column: 2 mini-strip keychains stacked
    const miniWrap = document.createElement("div");
    miniWrap.className = "addon-preview-mini-col";
    miniWrap.appendChild(_miniImg());
    miniWrap.appendChild(_miniImg());
    el.appendChild(stripWrap);
    el.appendChild(miniWrap);
  }

  function _populatePreviewC() {
    const el = document.getElementById("addonPreviewC");
    if (!el) return;
    el.innerHTML = "";
    // Left column: 2 standard 2×6 strips
    const stripWrap = document.createElement("div");
    stripWrap.className = "addon-preview-strip-col";
    stripWrap.appendChild(_stripImg());
    stripWrap.appendChild(_stripImg());
    // Right column: 2 mini-strip keychains
    const miniWrap = document.createElement("div");
    miniWrap.className = "addon-preview-mini-col";
    miniWrap.appendChild(_miniImg());
    miniWrap.appendChild(_miniImg());
    el.appendChild(stripWrap);
    el.appendChild(miniWrap);
  }

  // ── Card selection ─────────────────────────────────────────────────────────
  function _selectCard(choice, silent) {
    sessionState.addonChoice = choice;

    const cards = { none: _cardA(), replace: _cardB(), add: _cardC() };
    Object.entries(cards).forEach(([key, card]) => {
      if (!card) return;
      card.classList.toggle("addon-card--selected", key === choice);
      const radio = card.querySelector("input[type=radio]");
      if (radio) radio.checked = (key === choice);
    });

    // Enable the Next button once a choice is made
    const btn = _btnNext();
    if (btn) btn.disabled = false;
  }

  // ── Proceed to printing ────────────────────────────────────────────────────
  function _proceed() {
    kioskTimer.hide();

    // Map addonChoice → keychainAddonSelected (for printing.js backward compat)
    const choice = sessionState.addonChoice || "none";
    if (choice === "none") {
      sessionState.keychainAddonSelected = false;
    } else if (choice === "replace") {
      // "replace" — keychainAddon.exportPrintPNG prints 1 strip + 2 mini frames.
      // printing.js sends 1 keychain sheet instead of the standard 2-up sheet.
      sessionState.keychainAddonSelected = "replace";
    } else if (choice === "add") {
      // "add" — standard 2-up sheet + 1 extra keychain sheet.
      sessionState.keychainAddonSelected = "add";
    }

    // Audio: fire printing SFX (same as selection.js "Next" button)
    if (typeof audioManager !== "undefined") {
      audioManager.playPrintSfx();
    }

    // Reset + start progress bar immediately
    if (typeof uploadProgress !== "undefined") uploadProgress.start();
    // Fire QR generation
    if (typeof qrModule !== "undefined") qrModule.generateAndRender();
    // Set the video frame's aspect ratio
    if (typeof _setPrintingFrameAspectRatio === "function") _setPrintingFrameAspectRatio();
    // Init printing module
    if (typeof printingModule !== "undefined") {
      printingModule.init().catch((e) => {
        console.warn("[addonPage] printingModule.init error:", e && e.message || e);
      });
    }

    // Link ticket to session (fire-and-forget)
    if (sessionState.ticketId && sessionState.id && typeof queueTickets !== "undefined") {
      queueTickets.linkSession(sessionState.ticketId, sessionState.id).catch((e) => {
        console.warn("[addonPage] Could not link ticket:", e.message || e);
      });
    }

    goToPage("printing");
  }

  // ── Wire the Next button on the addon page ────────────────────────────────
  function _wireAddonNext() {
    const btn = _btnNext();
    if (!btn) return;
    btn.addEventListener("click", () => {
      _proceed();
    });
  }

  // ── Wire the selection-page Next button intercept ─────────────────────────
  // Runs in capture phase so it fires before selection.js's bubble listener.
  // Sets btn._addonPageWired = true so keychain-addon.js is a no-op.
  function _wireIntercept() {
    const btn = document.getElementById("btnNextFromSelection");
    if (!btn) {
      console.warn("[addonPage] #btnNextFromSelection not found — addon page will not appear.");
      return;
    }

    // Signal keychain-addon.js to skip its own intercept
    btn._addonPageWired = true;

    btn.addEventListener("click", async function addonCapture(e) {
      // If the bypass flag is set, this is a synthetic re-dispatch — let it through.
      if (btn._bypassKeychain) {
        btn._bypassKeychain = false;
        return;
      }

      // Only intercept when 4 photos are ready and button is active.
      if (btn.disabled) return;

      // Suppress the original event — we handle the flow from here.
      e.stopImmediatePropagation();
      e.preventDefault();

      // Ensure the selection module finalises its output (updateCountAndNav)
      // before we read sessionState.selectedShots.
      if (typeof selectionModule !== "undefined") {
        selectionModule.updateCountAndNav();
      }

      // Sync the design module if it exists
      if (typeof designModule !== "undefined") {
        designModule._activeFilter = "none";
        if (!sessionState.design && typeof STRIP_DESIGNS !== "undefined" && STRIP_DESIGNS.length) {
          sessionState.design = STRIP_DESIGNS[0].id;
        }
      }

      // Navigate to the addon page and initialise it
      goToPage("addon");
      await addonPage.init();

    }, true /* capture phase */);
  }

  // ── Wire card click handlers on DOMContentLoaded ──────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    _wireIntercept();
    _wireAddonNext();

    // Card click → select that option
    const cardMap = [
      { id: "addonCardNone",    choice: "none"    },
      { id: "addonCardReplace", choice: "replace" },
      { id: "addonCardAdd",     choice: "add"     }
    ];
    cardMap.forEach(({ id, choice }) => {
      const card = document.getElementById(id);
      if (!card) return;
      card.addEventListener("click", () => {
        _selectCard(choice);
      });
    });
  });

  // ── Reset add-on state on new session ─────────────────────────────────────
  document.addEventListener("shooting:complete", () => {
    sessionState.addonChoice          = "none";
    sessionState.keychainAddonSelected = false;
    _stripDataUrl = null;
    _stripCanvas  = null;
  });

  // Public API
  return { init };

})();
