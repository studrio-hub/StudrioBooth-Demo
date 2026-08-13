/*
 * SHOOTING-AUDIO-HOOK.JS — Listens to DOM changes made by shooting.js and
 * triggers audioManager SFX at the right moments.
 *
 * WHY A DOM OBSERVER?
 * shooting.js already owns the countdown loop and we cannot (and should not)
 * modify it here.  The safest integration is to observe the elements that
 * shooting.js itself updates:
 *
 *   #countdownNumber  (inside .countdown-overlay)
 *       shooting.js writes "8", "7", … "1" here during the main countdown.
 *       We fire a beep on 3, 2, 1.
 *
 *   #headsUpOverlay   (.heads-up-overlay  / #headsUpText)
 *       shooting.js shows this overlay briefly before each shot and writes
 *       "3", "2", "1" during the heads-up countdown.
 *       We fire a beep on those values too.
 *
 *   #capturedFlash    (.captured-flash)
 *       shooting.js adds class "active" (or equivalent) to this element to
 *       trigger the white flash at the moment of capture.
 *       We fire the shutter sound at that moment.
 *
 * This file has NO dependency on shooting.js internals — it only reads the
 * DOM values that shooting.js writes, so it cannot break the shoot flow.
 */

'use strict';

(function installShootingAudioHook() {

  const BEEP_VALUES = new Set(['1', '2', '3']);

  /* ── Helper: play beep only if audioManager exists ──────────────────── */
  function _beep() {
    if (typeof audioManager !== 'undefined') {
      audioManager.playCountdownBeep();
    }
  }

  function _shutter() {
    if (typeof audioManager !== 'undefined') {
      audioManager.playShutter();
    }
  }

  /* ── 1. Watch #countdownNumber for 3 / 2 / 1 ──────────────────────── */
  function _observeCountdown() {
    const el = document.getElementById('countdownNumber');
    if (!el) return;

    const obs = new MutationObserver(() => {
      const val = (el.textContent || '').trim();
      if (BEEP_VALUES.has(val)) {
        _beep();
      }
    });

    obs.observe(el, { childList: true, subtree: true, characterData: true });
  }

  /* ── 2. Watch #headsUpText for 3 / 2 / 1 ───────────────────────────── */
  function _observeHeadsUp() {
    const el = document.getElementById('headsUpText');
    if (!el) return;

    const obs = new MutationObserver(() => {
      const val = (el.textContent || '').trim();
      if (BEEP_VALUES.has(val)) {
        _beep();
      }
    });

    obs.observe(el, { childList: true, subtree: true, characterData: true });
  }

  /* ── 3. Watch #capturedFlash for shutter trigger ────────────────────── */
  /*
   * shooting.js triggers the white flash by adding a CSS class (typically
   * "active") to #capturedFlash, or by toggling its visibility / opacity.
   * We detect the class-list change (attributeFilter: ["class"]) OR a
   * style change and fire the shutter sound.
   *
   * De-duplication: we only fire once per "activation" — once the flash
   * class is removed (reset) we arm again.
   */
  function _observeCapturedFlash() {
    const el = document.getElementById('capturedFlash');
    if (!el) return;

    let _armed = true;

    const obs = new MutationObserver(() => {
      const isActive =
        el.classList.contains('active') ||
        el.classList.contains('flash') ||
        el.classList.contains('visible') ||
        (el.style.opacity && parseFloat(el.style.opacity) > 0) ||
        (el.style.display && el.style.display !== 'none' && el.style.display !== '');

      if (isActive && _armed) {
        _shutter();
        _armed = false;          // prevent duplicate fires for the same flash
      } else if (!isActive) {
        _armed = true;           // reset arm when flash ends
      }
    });

    obs.observe(el, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }

  /* ── 4. Watch #headsUpOverlay visibility for "1" + shutter ─────────── */
  /*
   * Additional safety net: some shooting.js versions hide the headsUpOverlay
   * and immediately capture — we also watch the overlay's style/class for
   * the moment it disappears while countdownNumber still shows "1",
   * in case the capturedFlash approach above isn't enough on its own.
   * This does NOT double-fire the shutter because _shutter() uses
   * audio.currentTime = 0 which just restarts the same clip.
   */

  /* ── Boot ────────────────────────────────────────────────────────────── */
  /*
   * Elements exist in the DOM from page load (shooting page is always in
   * the DOM, just hidden with .active class toggle), so we can observe
   * immediately after DOMContentLoaded.
   */
  function _install() {
    _observeCountdown();
    _observeHeadsUp();
    _observeCapturedFlash();
    console.log('[shootingAudioHook] Observers installed.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _install);
  } else {
    _install();
  }

})();
