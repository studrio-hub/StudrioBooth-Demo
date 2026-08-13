/*
 * AUDIO-MANAGER.JS — Centralized sound-effects & BGM system for Studrio Booth.
 *
 * ARCHITECTURE
 * ────────────
 * A single IIFE (window.audioManager) owns every Audio instance so audio
 * never restarts, overlaps, or duplicates across page changes.
 *
 * BGM ZONES
 * ─────────
 *   "standby"  → standby_bgm.wav   (pages: ticket, frame, setup)
 *   "main"     → main_bgm.wav      (pages: selection, design, printing)
 *    null       → silence           (page: shooting — SFX only)
 *
 * BGM TRANSITIONS
 * ───────────────
 *   Any page → standby zone  : if main was playing → cross-fade (both tracks
 *                               move at once: main volumes down, standby
 *                               volumes back up); else resume/start standby
 *   setup NEXT pressed        : fade-out standby before entering shooting
 *                                (onShootingStart)
 *   8th photo captured        : main_bgm fades in — triggered directly off
 *                                the "shooting:complete" DOM event dispatched
 *                                by shooting.js, NOT off page navigation, so
 *                                it starts the instant the last shot's video
 *                                finishes saving. goToPage('selection') fires
 *                                onPageChange('selection') shortly after,
 *                                which is a safe no-op if main is already on.
 *   printing page              : main keeps playing but gently ducks down to
 *                                PRINTING_DUCK_VOLUME after a short delay, so
 *                                it's already quiet by the time the guest
 *                                taps Done — then crossfades into standby.
 *   selection/design/printing : main plays continuously, no restart
 *
 * FADE ENGINE
 * ───────────
 *   Each Audio element can have AT MOST ONE active fade running at a time.
 *   Starting any new fade on a track (duck, crossfade, fade-in, fade-out —
 *   doesn't matter which) always cancels whatever fade was previously
 *   running on THAT SAME element. This makes it impossible for two fades
 *   (e.g. the printing-page duck and a user-triggered crossfade) to fight
 *   over the same track's volume, which was the root cause of BGM getting
 *   stuck / not resuming correctly after a session ended.
 *
 * SHOOTING SFX (called directly from shooting.js)
 * ────────────
 *   playCountdownBeep()  → camera_beep.wav   at countdown ticks 3, 2, 1
 *   playShutter()        → camera_shutter.wav immediately after capture (every shot)
 *
 * PRINT & QR SFX (called from app.js on design NEXT press)
 * ──────────────
 *   playPrintSfx()  → printing.wav  fires immediately when NEXT is pressed on Frame Design
 *
 * ELECTRON / WINDOWS
 * ──────────────────
 * All paths relative to kiosk root (assets/sfx/…). Audio elements are
 * pre-loaded at boot so there is no seek latency on first play.
 */

'use strict';

const audioManager = (() => {

  /* ─────────────────────────────────────────────────────────────────────────
   * CONSTANTS
   * ───────────────────────────────────────────────────────────────────────── */

  const SFX_PATH               = 'assets/sfx/';
  const BGM_VOLUME             = 0.50;   // 50% as specified
  const FADE_STEP_MS           = 30;     // ramp interval
  const FADE_OUT_MS            = 800;    // standby fade-out when entering shooting
  const FADE_IN_MS             = 700;    // main BGM fade-in when 8th photo lands
  const CROSS_FADE_MS          = 1200;   // main ↔ standby cross-fade on session reset
  const PRINTING_DUCK_VOLUME   = 0.20;   // main_bgm ducks to 20% on the Print & QR page
  const PRINTING_DUCK_MS       = 3000;   // 3-second gradual duck on printing page
  const PRINTING_DUCK_DELAY_MS = 800;    // settle delay before the duck begins

  /* ─────────────────────────────────────────────────────────────────────────
   * AUDIO INSTANCES  (created once, reused for the lifetime of the kiosk)
   * ───────────────────────────────────────────────────────────────────────── */

  function _make(filename, loop, volume) {
    const a  = new Audio(SFX_PATH + filename);
    a.loop    = loop;
    a.volume  = volume;
    a.preload = 'auto';
    return a;
  }

  // BGM tracks — loop forever, 50% volume
  const _standby = _make('standby_bgm.wav',   true,  BGM_VOLUME);
  const _main    = _make('main_bgm.wav',       true,  BGM_VOLUME);

  // SFX — one-shot, full volume
  const _beep    = _make('camera_beep.wav',    false, 1.0);
  const _shutter = _make('camera_shutter.wav', false, 1.0);
  const _print   = _make('printing.wav',       false, 1.0);

  /* ─────────────────────────────────────────────────────────────────────────
   * STATE
   * ───────────────────────────────────────────────────────────────────────── */

  // Tracks which BGM zone is active so we never restart a track mid-play.
  //   'standby' | 'main' | null
  let _zone = null;

  /* ─────────────────────────────────────────────────────────────────────────
   * FADE ENGINE — one active fade per audio element, no exceptions.
   *
   * The interval id lives directly on the Audio object (audio.__fadeTimer).
   * Any call to _fadeTo() for a given element cancels whatever fade was
   * already running on it, regardless of which code path started it. This
   * is what prevents e.g. the printing-page duck and a crossfade-out from
   * both trying to drive _main.volume at the same time.
   * ───────────────────────────────────────────────────────────────────────── */

  function _cancelFade(audio) {
    if (audio.__fadeTimer) {
      clearInterval(audio.__fadeTimer);
      audio.__fadeTimer = null;
    }
  }

  /**
   * Linearly ramp audio.volume → target over durationMs.
   * Cancels any fade already running on this audio element.
   */
  function _fadeTo(audio, target, durationMs, onDone) {
    _cancelFade(audio);
    const steps = Math.max(1, Math.round(durationMs / FADE_STEP_MS));
    const delta = (target - audio.volume) / steps;
    let n = 0;
    audio.__fadeTimer = setInterval(() => {
      n++;
      if (n >= steps) {
        audio.volume = Math.max(0, Math.min(1, target));
        _cancelFade(audio);
        if (onDone) onDone();
      } else {
        audio.volume = Math.max(0, Math.min(1, audio.volume + delta));
      }
    }, FADE_STEP_MS);
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * BGM HELPERS
   * ───────────────────────────────────────────────────────────────────────── */

  function _play(audio) {
    if (!audio.paused) return;
    audio.play().catch(e =>
      console.warn('[audioManager] play() blocked:', e.message || e)
    );
  }

  /**
   * Fade OUT the given BGM track and pause it when silent.
   * Restores volume to BGM_VOLUME after pausing so it's ready next time.
   */
  function _fadeOut(audio, durationMs) {
    _fadeTo(audio, 0, durationMs, () => {
      audio.pause();
      audio.volume = BGM_VOLUME;
    });
  }

  /**
   * Fade IN the given BGM track from 0 to BGM_VOLUME.
   * Cancels any lingering fade on this track first.
   */
  function _fadeIn(audio, durationMs) {
    _cancelFade(audio);
    audio.volume = 0;
    _play(audio);
    _fadeTo(audio, BGM_VOLUME, durationMs);
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * PRINTING-PAGE DUCK (cancellable)
   *
   * Scheduled as a plain setTimeout so it can be cleanly cancelled if the
   * guest leaves the printing page (or the session resets) before it fires.
   * Because the fade engine above cancels-on-start per element, even if
   * this DID fire late it would simply be superseded by whatever fade
   * comes after it — it can no longer "fight" a crossfade.
   * ───────────────────────────────────────────────────────────────────────── */

  let _duckDelayTimer = null;

  function _cancelPrintingDuck() {
    if (_duckDelayTimer) {
      clearTimeout(_duckDelayTimer);
      _duckDelayTimer = null;
    }
  }

  function _schedulePrintingDuck() {
    _cancelPrintingDuck();
    _duckDelayTimer = setTimeout(() => {
      _duckDelayTimer = null;
      if (_zone === 'main') {
        _fadeTo(_main, PRINTING_DUCK_VOLUME, PRINTING_DUCK_MS);
      }
    }, PRINTING_DUCK_DELAY_MS);
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * PUBLIC BGM ZONE SWITCHER
   *
   * Rules:
   *   • Same zone → ensure track is playing, return immediately (no restart).
   *   • Different zone → fade out old track, start new one.
   *   • null zone → silence (fade out whatever is playing).
   *   • crossFade = true → both tracks move simultaneously: old fades OUT
   *     over CROSS_FADE_MS and new fades IN from 0 over CROSS_FADE_MS.
   *   • fadeIn = true → incoming track fades in from 0 (used after silence).
   * ───────────────────────────────────────────────────────────────────────── */

  function _setZone(newZone, opts) {
    const { fadeIn = false, crossFade = false } = opts || {};

    // Any explicit zone change supersedes a pending/active printing duck.
    _cancelPrintingDuck();

    if (_zone === newZone) {
      // Already correct zone — just make sure the track didn't stall.
      if (newZone === 'standby') _play(_standby);
      if (newZone === 'main')    _play(_main);
      return;
    }

    const prevZone = _zone;
    _zone = newZone;

    // ── Fade out the previous BGM ──────────────────────────────────────
    if (prevZone === 'standby') {
      _fadeOut(_standby, crossFade ? CROSS_FADE_MS : FADE_OUT_MS);
    } else if (prevZone === 'main') {
      _fadeOut(_main, crossFade ? CROSS_FADE_MS : FADE_OUT_MS);
    }

    // ── Start the new BGM ─────────────────────────────────────────────
    if (newZone === 'standby') {
      if (fadeIn || crossFade) {
        _fadeIn(_standby, crossFade ? CROSS_FADE_MS : FADE_IN_MS);
      } else {
        _cancelFade(_standby);
        _standby.volume = BGM_VOLUME;
        _play(_standby);
      }
    } else if (newZone === 'main') {
      if (fadeIn || crossFade) {
        _fadeIn(_main, crossFade ? CROSS_FADE_MS : FADE_IN_MS);
      } else {
        _cancelFade(_main);
        _main.volume = BGM_VOLUME;
        _play(_main);
      }
    }
    // newZone === null → silence, nothing to start
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * SFX HELPER
   *
   * Always resets currentTime to 0 before playing so the same clip can be
   * retriggered on every shot without waiting for it to finish naturally.
   * ───────────────────────────────────────────────────────────────────────── */

  function _sfx(audio) {
    if (!audio) return;
    try { audio.currentTime = 0; } catch (_) { /* seeking not yet ready */ }
    audio.play().catch(e =>
      console.warn('[audioManager] SFX play() failed:', e.message || e)
    );
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * DIRECT HOOK — start main_bgm the instant the 8th photo is captured.
   *
   * shooting.js dispatches "shooting:complete" on document right after the
   * final shot's video finishes saving (see shooting.js startSession()),
   * BEFORE any page navigation happens. Listening for it here — the same
   * non-invasive DOM-event pattern already used by shooting-audio-hook.js —
   * means main_bgm starts at that exact moment rather than depending on
   * goToPage('selection') to fire onPageChange(). The later onPageChange
   * ('selection') call is a safe no-op since the zone will already be 'main'.
   * ───────────────────────────────────────────────────────────────────────── */

  document.addEventListener('shooting:complete', () => {
    _setZone('main', { fadeIn: _zone === null });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * PUBLIC API
   * ───────────────────────────────────────────────────────────────────────── */

  return {

    /* ── Boot ────────────────────────────────────────────────────────────── */

    /**
     * init() — call once after DOMContentLoaded / on first user gesture.
     * Pre-loads all audio files so first playback is instant.
     */
    init() {
      [_standby, _main, _beep, _shutter, _print].forEach(a => a.load());
      console.log('[audioManager] init — audio assets queued for pre-load.');
    },

    /* ── Page routing ────────────────────────────────────────────────────── */

    /**
     * onPageChange(pageName)
     * Called from goToPage() in app.js on every navigation.
     *
     * Page → BGM zone mapping:
     *   ticket, frame, setup  →  standby
     *   shooting              →  null (silence; actual fade-out via onShootingStart)
     *   selection             →  main  (usually already on via shooting:complete hook)
     *   design                →  main  (keep playing, no restart)
     *   printing              →  main  (keep playing, then gently duck after a delay)
     */
    onPageChange(pageName) {
      switch (pageName) {

        case 'ticket':
        case 'frame':
        case 'setup':
          // Return to standby. If main was running → cross-fade (both tracks
          // move simultaneously: main volumes down, standby volumes back up).
          // If zone was null (coming back from shooting without going
          // through selection) → plain resume.
          if (_zone === 'main') {
            _setZone('standby', { crossFade: true });
          } else {
            _setZone('standby');
          }
          break;

        case 'shooting':
          // The actual fade-out happens in onShootingStart() which fires
          // before this call; here we only commit the zone tracker so
          // the next onPageChange knows the previous state correctly.
          _cancelPrintingDuck();
          _zone = null;
          break;

        case 'selection':
          // Normally a no-op — main_bgm was already started by the
          // "shooting:complete" listener above. Kept as a safety net in
          // case that event is ever missed.
          _setZone('main', { fadeIn: _zone === null });
          break;

        case 'design':
          _setZone('main');
          break;

        case 'printing':
          // Keep main playing through the Print & QR page, then gently
          // duck it down after a short settle delay so it's already quiet
          // by the time the guest taps Done — the crossfade into standby
          // then has less distance to travel.
          _setZone('main');
          _schedulePrintingDuck();
          break;

        // lock, boot — leave audio unchanged
      }
    },

    /**
     * onShootingStart()
     * Call BEFORE goToPage('shooting'), when NEXT is pressed on Camera Mode.
     * Fades out standby_bgm so the shooting page opens in silence.
     */
    onShootingStart() {
      _cancelPrintingDuck();
      if (!_standby.paused) {
        _fadeOut(_standby, FADE_OUT_MS);
      }
      _zone = null;
    },

    /**
     * onPrintingDone()
     * Call when the guest ends the session on the Print & QR page (Confirm
     * tap, or the 60s auto-advance timer) — BEFORE resetSessionAndRestart().
     * Begins the main → standby crossfade immediately.
     *
     * Defensive by design: even if _zone somehow isn't exactly 'main' when
     * this fires, it still force-starts standby so the kiosk can never be
     * left without BGM after a session ends.
     */
    onPrintingDone() {
      _cancelPrintingDuck();
      if (_zone === 'main') {
        _setZone('standby', { crossFade: true });
      } else {
        _setZone('standby');
      }
    },

    /* ── Shooting SFX ────────────────────────────────────────────────────── */

    /**
     * playCountdownBeep()
     * Fire for countdown ticks 3, 2, 1 inside shooting.js runSingleShot().
     * Resets currentTime each call so rapid retriggering always works.
     */
    playCountdownBeep() { _sfx(_beep); },

    /**
     * playShutter()
     * Fire immediately after capturePhoto() in shooting.js runSingleShot().
     * Resets currentTime so every shot gets a fresh shutter click.
     */
    playShutter() { _sfx(_shutter); },

    /* ── Print & QR SFX ──────────────────────────────────────────────────── */

    /**
     * playPrintSfx()
     * Fire when NEXT is pressed on Frame Design (in app.js, before the
     * async printingModule.init() call so it plays immediately).
     */
    playPrintSfx() { _sfx(_print); },

    /* ── Utilities ───────────────────────────────────────────────────────── */

    muteAll()   { [_standby, _main, _beep, _shutter, _print].forEach(a => { a.muted = true;  }); },
    unmuteAll() { [_standby, _main, _beep, _shutter, _print].forEach(a => { a.muted = false; }); },

    /** DevTools helper */
    _debug: {
      get zone()    { return _zone; },
      get standby() { return _standby; },
      get main()    { return _main; },
    },
  };
})();
