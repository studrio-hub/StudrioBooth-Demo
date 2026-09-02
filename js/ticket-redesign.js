/*
 * TICKET-REDESIGN.JS — Page 1 (QR Ticket) visual redesign layer.
 *
 * Purely additive — does NOT modify queue-ticket-kiosk.js or queue-ticket.js.
 * All scanning, validation, and queue logic there is untouched.
 *
 * What this file does:
 *   1. Renders "Welcome to studrio!" as per-letter <span>s and animates each
 *      letter's color (black → yellow → black) on a staggered delay.
 *   2. Watches #ticketInfoPanel's state classes (idle/loading/validated/error
 *      — set by queue-ticket-kiosk.js exactly as before) and mirrors that
 *      state into the new #ticketScanCtaLabel text:
 *        idle       → "Scan your QR Ticket below"
 *        loading    → "Loading…"
 *        validated  → keeps "Loading…" on screen until a full 3s have
 *                      elapsed since loading started, then auto-clicks the
 *                      (visually hidden) #btnNextFromTicket to advance —
 *                      reusing queue-ticket-kiosk.js's own navigation path
 *                      rather than duplicating it.
 *        error      → shows the exact validation message queue-ticket-kiosk.js
 *                      already wrote into #ticketErrorMsg (e.g. "Your ticket
 *                      has not been called yet. Please wait.", "This ticket
 *                      has already been used."). queue-ticket-kiosk.js already
 *                      reverts the panel to "idle" after 3s on its own, which
 *                      this file picks up and mirrors back to the default label.
 */

(function () {
  "use strict";

  const WELCOME_TEXT     = "Welcome to studrio!";
  const LETTER_STAGGER_S = 0.06;   // seconds between each letter's animation start
  const MIN_LOADING_MS   = 3000;   // "Loading…" must be visible at least this long

  const DEFAULT_LABEL = "Scan your QR Ticket below";
  const LOADING_LABEL = "Loading…";

  /* ── 1. Welcome message: per-letter color animation ─────────────────────── */
  function _renderWelcomeMessage() {
    const el = document.getElementById("ticketWelcomeMsg");
    if (!el || el.dataset.rendered) return;
    el.dataset.rendered = "1";

    const frag = document.createDocumentFragment();
    let letterIndex = 0;

    for (const ch of WELCOME_TEXT) {
      const span = document.createElement("span");
      if (ch === " ") {
        span.className = "tw-letter tw-space";
        span.textContent = "\u00A0";
      } else {
        span.className = "tw-letter";
        span.textContent = ch;
        span.style.animationDelay = (letterIndex * LETTER_STAGGER_S) + "s";
        letterIndex++;
      }
      frag.appendChild(span);
    }
    el.appendChild(frag);
  }

  /* ── 2. Status label ↔ #ticketInfoPanel state mirroring ─────────────────── */
  function _initStatusMirror() {
    const panel   = document.getElementById("ticketInfoPanel");
    const label   = document.getElementById("ticketScanCtaLabel");
    const nextBtn = document.getElementById("btnNextFromTicket");
    if (!panel || !label) return;

    let _loadingStartedAt = null;
    let _token = 0; // guards stale auto-click timeouts across repeated scans

    function _currentState() {
      if (panel.classList.contains("loading"))   return "loading";
      if (panel.classList.contains("validated")) return "validated";
      if (panel.classList.contains("error"))     return "error";
      return "idle";
    }

    function _scheduleAutoAdvance() {
      const myToken = ++_token;
      const elapsed   = _loadingStartedAt ? (Date.now() - _loadingStartedAt) : 0;
      const remaining = Math.max(0, MIN_LOADING_MS - elapsed);
      setTimeout(() => {
        if (myToken !== _token) return; // a newer scan cycle superseded this one
        if (nextBtn && !nextBtn.disabled) nextBtn.click();
      }, remaining);
    }

    function _sync() {
      const state = _currentState();

      if (state === "loading") {
        _loadingStartedAt = Date.now();
        _token++; // invalidate any pending auto-advance from a prior cycle
        label.textContent = LOADING_LABEL;
        return;
      }

      if (state === "validated") {
        label.textContent = LOADING_LABEL; // keep "Loading…" visible per spec
        _scheduleAutoAdvance();
        return;
      }

      if (state === "error") {
        const errEl = document.getElementById("ticketErrorMsg");
        label.textContent = (errEl && errEl.textContent) || "Something went wrong. Please try again.";
        return;
      }

      // idle
      _loadingStartedAt = null;
      label.textContent = DEFAULT_LABEL;
    }

    new MutationObserver(_sync).observe(panel, {
      attributes: true,
      attributeFilter: ["class"]
    });

    // Sync once immediately in case the panel isn't in its default "idle"
    // state when this script runs (e.g. hot-reload during development).
    _sync();
  }

  /* ── Init ─────────────────────────────────────────────────────────────── */
  function init() {
    _renderWelcomeMessage();
    _initStatusMirror();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
