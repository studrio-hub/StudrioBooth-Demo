/*
 * FLIPBOOK-SHOOTING.JS — Flipbook video-taking + cover-page-photo-taking page.
 *
 * Rewritten to mirror shooting.js v4's guest-triggered shutter pattern (see
 * that file's header) instead of the old fully-automatic fixed-3-take loop:
 *
 *   VIDEO TAKING:
 *     - flipbook_guide.wav plays once, then a static "Get Ready!" heads-up
 *       shows for 3 seconds (unchanged) — before the guest is handed control.
 *     - SHUTTER (#btnFlipbookShutter) triggers each video: pressing it starts
 *       a 3-second countdown (countdownSeconds — same as Photo Taking, was a
 *       fixed non-guest-triggered 8s), then RECORDING_SECONDS (4s) of actual
 *       recording once the countdown ends, then a PLAYBACK_SECONDS (4s)
 *       played-back preview of the clip just taken. Guests may take up to
 *       maxVideos (6); SHUTTER disables at that cap.
 *     - DONE (#btnFlipbookDone) stays disabled until minVideos (2) videos
 *       are taken, then becomes active — pressing it ends Video Taking
 *       immediately and moves on to Cover Page Photo Taking.
 *     - A VIDEO_SESSION_SECONDS (90s) timer (kioskTimer, the same shared
 *       countdown widget shooting.js uses) runs for the whole phase. If it
 *       expires with fewer than minVideos taken, the phase keeps
 *       auto-capturing (same countdown/record/playback flow, just without
 *       a guest press) until minVideos is reached, then proceeds. If
 *       minVideos is already met when the timer fires, the phase ends
 *       immediately — same logic as shooting.js's
 *       _autoCaptureToMinimumThenFinish().
 *
 *   COVER PAGE PHOTO TAKING:
 *     - static "Cover Page Photo Taking" heads-up (3s, unchanged) once Video
 *       Taking ends.
 *     - Exactly the same guest-triggered pattern as above, but for still
 *       photos: SHUTTER trigger → 3-second countdown → capture → the
 *       captured photo shown for COVER_PHOTO_SHOW_SECONDS (3s, unchanged).
 *       minCoverPhotos (2) / maxCoverPhotos (6) / COVER_SESSION_SECONDS (60s)
 *       timer, same min-gated DONE + timer-expiry auto-capture-to-minimum
 *       behavior as Video Taking above.
 *
 *   Both phases share one SHUTTER/DONE button pair (#btnFlipbookShutter /
 *   #btnFlipbookDone, see index.html) and the existing countdown overlay /
 *   captured-flash — only `phase` ('video' | 'cover') and its handler
 *   branch changes. If the timer expires (or DONE is pressed) while a take
 *   is mid-capture, that take is allowed to finish first (see
 *   _pendingFinish / _timerExpired), same guard shooting.js uses.
 *
 * Results still land in:
 *   sessionState.flipbookVideos      = [{ id, video, videoUrl }, ...] (2–6)
 *   sessionState.flipbookCoverPhotos = [{ id, image, imageUrl }, ...] (2–6)
 * and "flipbook-shooting:complete" still fires once both phases finish —
 * same event name flipbook-selection.js already listens for.
 */

const flipbookShootingModule = {
  minVideos: 2,           // DONE stays disabled below this count (Video Taking)
  maxVideos: 6,           // SHUTTER disables at this count (Video Taking)
  VIDEO_SESSION_SECONDS: 90, // whole-phase timer (kioskTimer)

  minCoverPhotos: 2,      // DONE stays disabled below this count (Cover Page Photo Taking)
  maxCoverPhotos: 6,      // SHUTTER disables at this count (Cover Page Photo Taking)
  COVER_SESSION_SECONDS: 60, // whole-phase timer (kioskTimer)

  countdownSeconds: 3,       // per-take countdown, starts on shutter press (was a fixed, non-guest-triggered 8s)
  RECORDING_SECONDS: 4,      // actual recording duration once a video's countdown ends — unchanged
  RECORDING_FLASH_INTERVAL_MS: 700, // cadence of the continuous flash strobe while recording — unchanged
  PLAYBACK_SECONDS: 4,       // how long each just-recorded clip plays back — unchanged
  COVER_PHOTO_SHOW_SECONDS: 3, // how long each just-captured cover photo is shown — unchanged

  phase: null,            // 'video' | 'cover' | null — which phase SHUTTER/DONE currently act on
  running: false,
  capturing: false,
  _pendingFinish: false,  // DONE pressed mid-take → finish this phase once it wraps up
  _timerExpired: false,   // phase timer fired mid-take → resume the expiry flow once it wraps up
  _autoFinishing: false,  // timer-expiry auto-capture-to-minimum loop running — SHUTTER/DONE ignored meanwhile
  _controlsBound: false,
  _phaseResolve: null,    // resolves the current _runVideoPhase()/_runCoverPhotoPhase() promise

  els: {
    video:              document.getElementById("flipbookVideo"),
    img:                document.getElementById("flipbookImg"),
    countdownOverlay:   document.getElementById("flipbookCountdownOverlay"),
    countdownNumber:    document.getElementById("flipbookCountdownNumber"),
    recordingBadge:     document.getElementById("flipbookRecordingBadge"),
    playbackOverlay:    document.getElementById("flipbookPlaybackOverlay"),
    playbackVideo:      document.getElementById("flipbookPlaybackVideo"),
    // "NEXT VIDEO IN" bottom pill, shown during playback.
    playbackIntervalNumber: document.getElementById("flipbookPlaybackIntervalNumber"),
    flash:              document.getElementById("flipbookCapturedFlash"),
    // Cover photo just captured — shown for COVER_PHOTO_SHOW_SECONDS.
    coverPhotoPreviewOverlay: document.getElementById("flipbookCoverPhotoPreview"),
    coverPhotoPreviewImg:     document.getElementById("flipbookCoverPhotoPreviewImg"),
    // "NEXT PHOTO IN" bottom pill, shown during the cover photo preview.
    coverPhotoIntervalNumber: document.getElementById("flipbookCoverPhotoIntervalNumber"),
    // Heads-up message shown before each phase begins.
    coverHeadsUpOverlay: document.getElementById("flipbookCoverHeadsUpOverlay"),
    coverHeadsUpText:    document.getElementById("flipbookCoverHeadsUpText"),
    // Guest-triggered controls — shared by both phases.
    shutterBtn:         document.getElementById("btnFlipbookShutter"),
    doneBtn:            document.getElementById("btnFlipbookDone")
  },

  async startSession() {
    if (this.running) return;
    this.running = true;
    this.capturing = false;
    this._pendingFinish = false;
    this._timerExpired = false;
    this._autoFinishing = false;
    this.phase = null;
    sessionState.flipbookVideos = [];
    sessionState.flipbookCoverPhotos = [];

    cameraController.attachPreview(this.els.video, this.els.img);

    this._bindControls();
    this._setShutterEnabled(false);
    if (this.els.doneBtn) this.els.doneBtn.disabled = true;

    // flipbook_guide.wav plays once, before the guest gets control of the shutter.
    if (typeof audioManager !== "undefined") {
      await audioManager.playFlipbookGuide();
    }

    // Static "Get Ready!" heads-up, shown once right after the guide
    // voiceover finishes — same beat as Photo Taking's runHeadsUp().
    await this.runGetReadyHeadsUp();

    if (!this.running) return; // guard: session could theoretically have ended already

    await this._runVideoPhase();

    if (!this.running) return;

    await this.runCoverPhotoHeadsUp();

    if (!this.running) return;

    await this._runCoverPhotoPhase();

    if (!this.running) return;

    this.running = false;
    document.dispatchEvent(new CustomEvent("flipbook-shooting:complete", {
      detail: {
        videos: sessionState.flipbookVideos,
        coverPhotos: sessionState.flipbookCoverPhotos
      }
    }));
  },

  /* Wires the shared SHUTTER and DONE buttons — only once per page load.
     Behavior branches on `this.phase` since both phases reuse the same
     two buttons. */
  _bindControls() {
    if (this._controlsBound) return;
    this._controlsBound = true;

    if (this.els.shutterBtn) {
      this.els.shutterBtn.addEventListener("click", () => {
        if (!this.running || this.capturing || this._autoFinishing) return;
        if (this.phase === "video") {
          if (sessionState.flipbookVideos.length >= this.maxVideos) return;
          this._takeVideoShot();
        } else if (this.phase === "cover") {
          if (sessionState.flipbookCoverPhotos.length >= this.maxCoverPhotos) return;
          this._takeCoverPhotoShot();
        }
      });
    }

    if (this.els.doneBtn) {
      this.els.doneBtn.addEventListener("click", () => {
        if (!this.running || this._autoFinishing) return;
        if (this.phase === "video") {
          if (sessionState.flipbookVideos.length < this.minVideos) return;
          this._finishPhase();
        } else if (this.phase === "cover") {
          if (sessionState.flipbookCoverPhotos.length < this.minCoverPhotos) return;
          this._finishPhase();
        }
      });
    }
  },

  /* Runs the Video Taking phase to completion (DONE pressed, timer expiry,
     or maxVideos-triggered eventual finish) and resolves once it's over. */
  _runVideoPhase() {
    return new Promise((resolve) => {
      this.phase = "video";
      this._phaseResolve = resolve;
      if (this.els.shutterBtn) this.els.shutterBtn.setAttribute("aria-label", "Take video");
      this._updateVideoCounter();
      this._updateDoneButtonState();
      this._setShutterEnabled(true);
      kioskTimer.start(this.VIDEO_SESSION_SECONDS, () => this._onPhaseTimerExpired());
    });
  },

  /* Runs the Cover Page Photo Taking phase to completion, same shape as
     _runVideoPhase() above. */
  _runCoverPhotoPhase() {
    return new Promise((resolve) => {
      this.phase = "cover";
      this._phaseResolve = resolve;
      if (this.els.shutterBtn) this.els.shutterBtn.setAttribute("aria-label", "Take photo");
      this._updateCoverPhotoCounter();
      this._updateDoneButtonState();
      this._setShutterEnabled(true);
      kioskTimer.start(this.COVER_SESSION_SECONDS, () => this._onPhaseTimerExpired());
    });
  },

  /* Right-side counter: "Video 0/6" .. "Video 6/6" — completed-count over
     the phase's max cap, same convention as Photo Taking's
     #photosTakenCount (count/maxPhotos), not a "current take" indicator. */
  _updateVideoCounter() {
    this._updateSideCounter("Video", sessionState.flipbookVideos.length, this.maxVideos);
  },

  /* Right-side counter, cover photo phase: "Cover Photo 0/6", etc. */
  _updateCoverPhotoCounter() {
    this._updateSideCounter("Cover Photo", sessionState.flipbookCoverPhotos.length, this.maxCoverPhotos);
  },

  _updateSideCounter(prefix, taken, max) {
    const labelEl = document.querySelector("#page-flipbook-shoot .photos-taken-label");
    if (labelEl) labelEl.textContent = prefix;
    const takenEl = document.getElementById("flipbookVideosTakenCount");
    if (takenEl) {
      takenEl.innerHTML = `${taken}<span class="photos-taken-slash">/</span><span class="photos-taken-total">${max}</span>`;
    }
  },

  _setShutterEnabled(enabled) {
    if (!this.els.shutterBtn) return;
    this.els.shutterBtn.disabled = !enabled;
  },

  /* DONE enables once the ACTIVE phase's minimum is reached — mirrors
     shooting.js's _updateDoneButtonState(), branched on `this.phase`. */
  _updateDoneButtonState() {
    if (!this.els.doneBtn) return;
    if (this.phase === "video") {
      this.els.doneBtn.disabled = sessionState.flipbookVideos.length < this.minVideos;
    } else if (this.phase === "cover") {
      this.els.doneBtn.disabled = sessionState.flipbookCoverPhotos.length < this.minCoverPhotos;
    } else {
      this.els.doneBtn.disabled = true;
    }
  },

  /* Ends the active phase immediately — used only by the DONE button,
     which is already disabled below that phase's minimum. If a take is
     mid-capture, defers until it safely finishes (see _pendingFinish,
     checked at the end of _takeVideoShot/_takeCoverPhotoShot). */
  _finishPhase() {
    if (!this.running) return;
    if (this.capturing) {
      this._pendingFinish = true;
      return;
    }
    this._doFinishPhase();
  },

  _doFinishPhase() {
    kioskTimer.hide();
    this._setShutterEnabled(false);
    if (this.els.doneBtn) this.els.doneBtn.disabled = true;
    this.phase = null;
    const resolve = this._phaseResolve;
    this._phaseResolve = null;
    if (resolve) resolve();
  },

  /* Fired when the active phase's session timer runs out. If a take is
     mid-capture, defer via _timerExpired (checked at the end of
     _takeVideoShot/_takeCoverPhotoShot) rather than cutting off a
     capture/recording in progress. Otherwise, hand off to
     _autoCaptureToMinimumThenFinish() right away. */
  async _onPhaseTimerExpired() {
    if (!this.running) return;
    if (this.capturing) {
      this._timerExpired = true;
      return;
    }
    await this._autoCaptureToMinimumThenFinish();
  },

  /* If the phase timer expires before the guest has reached that phase's
     minimum, keep running the normal per-take flow (same countdown/
     capture/playback as a guest-triggered take) until the minimum is met,
     with SHUTTER/DONE disabled for the duration (_autoFinishing) so the
     guest can't interfere mid-loop. Finishes the phase once done. If the
     guest had already reached the minimum by the time the timer fired,
     the loop is a no-op and this finishes immediately — same shape as
     shooting.js's _autoCaptureToMinimumThenFinish(). */
  async _autoCaptureToMinimumThenFinish() {
    if (!this.running) return;
    this._autoFinishing = true;
    this._setShutterEnabled(false);
    if (this.els.doneBtn) this.els.doneBtn.disabled = true;

    if (this.phase === "video") {
      while (this.running && sessionState.flipbookVideos.length < this.minVideos) {
        await this._takeVideoShot();
        // _takeVideoShot()'s own state-update calls may have just
        // re-enabled these — force them back off for the remainder of
        // the auto-capture loop.
        this._setShutterEnabled(false);
        if (this.els.doneBtn) this.els.doneBtn.disabled = true;
      }
    } else if (this.phase === "cover") {
      while (this.running && sessionState.flipbookCoverPhotos.length < this.minCoverPhotos) {
        await this._takeCoverPhotoShot();
        this._setShutterEnabled(false);
        if (this.els.doneBtn) this.els.doneBtn.disabled = true;
      }
    }

    this._autoFinishing = false;
    this._doFinishPhase();
  },

  /* One guest-triggered (or auto-captured) video: 3-second countdown →
     recording starts → RECORDING_SECONDS of recording → playback of the
     clip just taken. Mirrors shooting.js's _takeShot() shape. */
  async _takeVideoShot() {
    this.capturing = true;
    this._setShutterEnabled(false);

    const overlay = this.els.countdownOverlay;
    const numEl   = this.els.countdownNumber;
    if (overlay) overlay.classList.add("show");

    for (let s = this.countdownSeconds; s >= 1; s--) {
      if (numEl) numEl.textContent = s;
      if (typeof audioManager !== "undefined") audioManager.playCountdownBeep();
      await this.wait(1000);
    }

    if (overlay) overlay.classList.remove("show");

    // Flash + shutter mark the moment recording actually begins.
    this.flashEffect();
    if (typeof audioManager !== "undefined") audioManager.playShutter();

    let videoStarted = false;
    if (this.els.recordingBadge) this.els.recordingBadge.hidden = false;
    try {
      await cameraController.startVideoRecording();
      videoStarted = true;
    } catch (e) {
      console.warn("[flipbook-shooting] Failed to start recording:", e.message || e);
      if (this.els.recordingBadge) this.els.recordingBadge.hidden = true;
    }

    // Continuous flash strobe for the duration of the recording (distinct
    // from the single flashEffect() call above that marks the start).
    let recordingFlashInterval = null;
    if (videoStarted) {
      recordingFlashInterval = setInterval(() => this.flashEffect(), this.RECORDING_FLASH_INTERVAL_MS);
    }

    if (videoStarted) await this.wait(this.RECORDING_SECONDS * 1000);

    if (recordingFlashInterval) clearInterval(recordingFlashInterval);

    let videoBlob = null;
    if (videoStarted) {
      if (this.els.recordingBadge) this.els.recordingBadge.hidden = true;
      try {
        // No still-photo freeze frame for flipbook clips — pass no freezeBlob
        // so the recorder just stops cleanly on the raw clip.
        videoBlob = await cameraController.stopVideoRecording(null);
      } catch (e) {
        console.warn("[flipbook-shooting] Failed to stop recording:", e.message || e);
      }
    }

    const clip = {
      id: sessionState.flipbookVideos.length + 1,
      video: videoBlob,
      videoUrl: videoBlob ? URL.createObjectURL(videoBlob) : null,
      selected: false
    };
    sessionState.flipbookVideos.push(clip);
    this._updateVideoCounter();
    this._updateDoneButtonState();

    await this.runPlayback(clip);

    this.capturing = false;

    // DONE was pressed while this take was in flight — finish the phase now.
    if (this._pendingFinish) {
      this._pendingFinish = false;
      this._doFinishPhase();
      return;
    }

    // The phase timer expired while this take was in flight — resume the
    // timer-expiry flow now that this take is safely wrapped up.
    if (this._timerExpired) {
      this._timerExpired = false;
      await this._autoCaptureToMinimumThenFinish();
      return;
    }

    if (!this.running || this.phase !== "video") return;

    this._setShutterEnabled(sessionState.flipbookVideos.length < this.maxVideos);
  },

  /* Plays the clip that was just captured so the guest can see it.
     The bottom "NEXT VIDEO IN" pill ticks down from PLAYBACK_SECONDS to 1
     across this same window. Unchanged from the previous version. */
  async runPlayback(clip) {
    const overlay = this.els.playbackOverlay;
    const vid = this.els.playbackVideo;
    const numEl = this.els.playbackIntervalNumber;

    if (!overlay || !vid || !clip.videoUrl) {
      await this.wait(this.PLAYBACK_SECONDS * 1000);
      return;
    }
    vid.src = clip.videoUrl;
    overlay.classList.add("show");
    try {
      vid.currentTime = 0;
      await vid.play();
    } catch (e) {
      console.warn("[flipbook-shooting] Playback failed:", e.message || e);
    }

    for (let s = this.PLAYBACK_SECONDS; s >= 1; s--) {
      if (numEl) numEl.textContent = s;
      await this.wait(1000);
    }

    vid.pause();
    overlay.classList.remove("show");
  },

  /* Static "Get Ready!" heads-up shown once, right after the flipbook
     guide voiceover finishes and before the guest gets control of the
     shutter — reuses the same overlay/pop-in pattern as
     runCoverPhotoHeadsUp() below and shooting.js's runHeadsUp().
     Unchanged from the previous version. */
  async runGetReadyHeadsUp() {
    const overlay = this.els.coverHeadsUpOverlay;
    const textEl  = this.els.coverHeadsUpText;
    if (!overlay || !textEl) {
      await this.wait(3000);
      return;
    }
    textEl.textContent = "Get Ready!";
    textEl.classList.remove("pop");
    void textEl.offsetWidth;
    textEl.classList.add("pop");

    overlay.classList.add("show");
    await this.wait(3000);
    overlay.classList.remove("show");
  },

  /* Static heads-up message shown for 3 seconds before Cover Page Photo
     Taking begins — same pop-in pattern as shooting.js's runHeadsUp().
     Unchanged from the previous version. */
  async runCoverPhotoHeadsUp() {
    const overlay = this.els.coverHeadsUpOverlay;
    const textEl  = this.els.coverHeadsUpText;
    if (!overlay || !textEl) {
      await this.wait(3000);
      return;
    }
    textEl.textContent = "Cover Page Photo Taking";
    textEl.classList.remove("pop");
    void textEl.offsetWidth;
    textEl.classList.add("pop");

    overlay.classList.add("show");
    await this.wait(3000);
    overlay.classList.remove("show");
  },

  /* One guest-triggered (or auto-captured) cover photo: 3-second countdown
     → still photo capture → the captured photo shown for
     COVER_PHOTO_SHOW_SECONDS. Mirrors _takeVideoShot() above/
     shooting.js's _takeShot() shape. */
  async _takeCoverPhotoShot() {
    this.capturing = true;
    this._setShutterEnabled(false);

    const overlay = this.els.countdownOverlay;
    const numEl   = this.els.countdownNumber;
    if (overlay) overlay.classList.add("show");

    for (let s = this.countdownSeconds; s >= 1; s--) {
      if (numEl) numEl.textContent = s;
      if (typeof audioManager !== "undefined") audioManager.playCountdownBeep();
      await this.wait(1000);
    }

    if (overlay) overlay.classList.remove("show");

    let imageBlob = null;
    try {
      // cameraController.capturePhoto() is the exact same real-camera call
      // Photo Taking's shooting.js uses (EDSDK shutter in 'real' mode, or
      // the mock webcam bridge's own capture in 'mock' mode) — never a
      // canvas screenshot of the live preview element. It also already
      // bakes in the active photobooth.cube filter internally (see
      // camera-controller.js's capturePhoto()/_applyFilterToBlob()), so no
      // separate filter step is needed here — matches Photo Taking exactly.
      imageBlob = await cameraController.capturePhoto();
    } catch (e) {
      console.error("[flipbook-shooting] Cover photo capture failed:", e);
    }

    this.flashEffect();
    if (typeof audioManager !== "undefined") audioManager.playShutter();

    const photo = {
      id: sessionState.flipbookCoverPhotos.length + 1,
      image: imageBlob,
      imageUrl: imageBlob ? URL.createObjectURL(imageBlob) : null,
      selected: false
    };
    sessionState.flipbookCoverPhotos.push(photo);
    this._updateCoverPhotoCounter();
    this._updateDoneButtonState();

    await this.showCoverPhotoPreview(photo);

    this.capturing = false;

    if (this._pendingFinish) {
      this._pendingFinish = false;
      this._doFinishPhase();
      return;
    }

    if (this._timerExpired) {
      this._timerExpired = false;
      await this._autoCaptureToMinimumThenFinish();
      return;
    }

    if (!this.running || this.phase !== "cover") return;

    this._setShutterEnabled(sessionState.flipbookCoverPhotos.length < this.maxCoverPhotos);
  },

  /* Shows the cover photo just captured, full-frame, for
     COVER_PHOTO_SHOW_SECONDS — same "show what was just taken" beat as
     runPlayback() does for videos. The bottom "NEXT PHOTO IN" pill ticks
     down over this window. Unchanged from the previous version. */
  async showCoverPhotoPreview(photo) {
    const overlay = this.els.coverPhotoPreviewOverlay;
    const img = this.els.coverPhotoPreviewImg;
    const numEl = this.els.coverPhotoIntervalNumber;

    if (!overlay || !img || !photo.imageUrl) {
      await this.wait(this.COVER_PHOTO_SHOW_SECONDS * 1000);
      return;
    }
    img.src = photo.imageUrl;
    overlay.classList.add("show");

    for (let s = this.COVER_PHOTO_SHOW_SECONDS; s >= 1; s--) {
      if (numEl) numEl.textContent = s;
      await this.wait(1000);
    }

    overlay.classList.remove("show");
  },

  flashEffect() {
    if (!this.els.flash) return;
    this.els.flash.classList.remove("flash");
    void this.els.flash.offsetWidth;
    this.els.flash.classList.add("flash");
  },

  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
};
