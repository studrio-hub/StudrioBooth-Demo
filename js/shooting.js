/*
 * SHOOTING LOGIC — Page 3  (v4 — guest-triggered shutter)
 *
 * Changes from v3 (automatic 8-shot countdown loop):
 *
 *  The session is no longer a fully automatic 8-shot loop. After the intro
 *  (prep voiceover + "Get Ready!" heads-up, unchanged from before), the
 *  guest is in control:
 *
 *    - A SHUTTER button (in the right-hand side panel, see index.html)
 *      triggers each photo. The 3-second countdown only starts when the
 *      guest presses it — nothing happens automatically between shots.
 *    - Guests may take up to maxPhotos (20) photos; the shutter button is
 *      disabled once that cap is reached.
 *    - A DONE button (same side panel) stays disabled/gray until minPhotos
 *      (8) photos have been taken, then becomes active — pressing it ends
 *      the session immediately and moves on to Photo Selection.
 *    - A 150-second session timer (kioskTimer, the same shared countdown
 *      widget used on other pages — Minor Fix: was 120s) runs for the
 *      whole guest-triggered phase. When it expires, and the guest has
 *      taken MIN_REQUIRED_FOR_SELECTION (4) photos or more, the session
 *      ends immediately, same as before. Minor Fix: if fewer than 4 have
 *      been taken, the session now keeps auto-capturing (same countdown/
 *      capture/flash flow as a normal guest-triggered shot, just without
 *      the guest pressing SHUTTER) until that 4-photo minimum is reached,
 *      THEN proceeds to Photo Selection — since Photo Selection requires
 *      picking exactly 4 photos and can't function with fewer on hand.
 *
 *  If the timer expires (or DONE is pressed) while a shot is mid-capture
 *  (countdown/capture/video-stop in flight), we let that shot finish
 *  first — see _pendingFinish / _timerExpired — rather than cutting off a
 *  capture or an in-progress video recording.
 *
 *  Per-shot mechanics (video recording start/stop, flash, captured-photo
 *  preview, beep-on-countdown) are unchanged from v3 — only how/when a
 *  shot is triggered has changed. The captured photo is shown full-frame
 *  for a brief ~1.5s flash, with the "NEXT PHOTO IN" pill counting down
 *  3→1 across that window (Minor Fix: this previously stayed frozen at
 *  its static "3" the whole time — see _runCapturedIntervalCountdown()).
 *  This is the same code path for both 2×6 and 4×6 Photo Taking, so the
 *  fix applies to both frame types.
 */

const shootingModule = {
  minPhotos: 8,        // DONE stays disabled below this count
  maxPhotos: 20,        // SHUTTER disables at this count
  SESSION_SECONDS: 150,  // whole-session timer (kioskTimer) — Minor Fix: was 120
  MIN_REQUIRED_FOR_SELECTION: 4, // timer-expiry auto-capture floor (Photo Selection needs 4 to pick from)
  countdownSeconds: 3,   // per-shot countdown, starts on shutter press
  PREP_SECONDS: 10,      // preparation countdown before the first shot
  CAPTURED_FLASH_MS: 1500, // how long the captured photo stays on screen

  currentShot: 0,
  running: false,
  capturing: false,
  _pendingFinish: false,  // DONE pressed mid-shot → finish once it wraps up
  _timerExpired: false,   // session timer fired mid-shot → re-run the timer-expiry flow once it wraps up
  _autoFinishing: false,  // timer-expiry auto-capture-to-minimum loop is running — SHUTTER/DONE ignored meanwhile
  _controlsBound: false,

  els: {
    counter: document.getElementById("shotCounter"),
    countdownOverlay: document.getElementById("countdownOverlay"),
    countdownNumber: document.getElementById("countdownNumber"),
    recordingBadge: document.getElementById("recordingBadge"),
    flash: document.getElementById("capturedFlash"),
    video: document.getElementById("shootingVideo"),
    img: document.getElementById("shootingImg"),
    intervalPreview: document.getElementById("intervalPreview"),
    intervalPreviewImg: document.getElementById("intervalPreviewImg"),
    intervalNumber: document.getElementById("intervalNumber"),
    headsUpOverlay: document.getElementById("headsUpOverlay"),
    headsUpText: document.getElementById("headsUpText"),
    prepCountdownOverlay: document.getElementById("prepCountdownOverlay"),
    prepCountdownNumber: document.getElementById("prepCountdownNumber"),
    shutterBtn: document.getElementById("btnShutter"),
    doneBtn: document.getElementById("btnShootingDone"),
    photosTakenLabel: document.getElementById("photosTakenLabel"),
    photosTakenCount: document.getElementById("photosTakenCount")
  },

  async startSession() {
    if (this.running) return;
    this.running = true;
    this.currentShot = 0;
    this.capturing = false;
    this._pendingFinish = false;
    this._timerExpired = false;
    this._autoFinishing = false;
    sessionState.shots = [];

    cameraController.attachPreview(this.els.video, this.els.img);

    this._bindControls();
    this._updatePhotosTakenUI();
    this._updateDoneButtonState();
    this._setShutterEnabled(false);

    // 10-second preparation countdown before the first shot
    await this.runPrepCountdown();

    await this.runHeadsUp();

    if (!this.running) return; // guard: session could theoretically have ended already

    // Guest is now in control of pacing: enable the shutter and start the
    // whole-session 150s timer. Nothing auto-advances from here on except
    // the timer expiring (see _onSessionTimerExpired).
    this._setShutterEnabled(true);
    kioskTimer.start(this.SESSION_SECONDS, () => this._onSessionTimerExpired());
  },

  /* Wires the SHUTTER and DONE buttons — only once per page load. */
  _bindControls() {
    if (this._controlsBound) return;
    this._controlsBound = true;

    if (this.els.shutterBtn) {
      this.els.shutterBtn.addEventListener("click", () => {
        if (!this.running || this.capturing || this._autoFinishing) return;
        if (sessionState.shots.length >= this.maxPhotos) return;
        this._takeShot();
      });
    }

    if (this.els.doneBtn) {
      this.els.doneBtn.addEventListener("click", () => {
        if (!this.running || this._autoFinishing) return;
        if (sessionState.shots.length < this.minPhotos) return;
        this._finishSession();
      });
    }
  },

  /*
   * Preparation beat shown right when the shooting page loads, before the
   * guest can use the shutter.
   *
   * Previously this was a numeric 10-second ticking countdown (with a beep
   * on 3/2/1). It's now replaced by the photo_taking_guide.wav voiceover:
   * we await its playback. The old prepCountdownOverlay/Number elements
   * have nothing to display without a numeric tick, so they're left
   * unused here rather than shown empty — this.els still references them
   * in case a future visual cue is wanted during the voiceover.
   */
  async runPrepCountdown() {
    if (typeof audioManager !== "undefined") {
      await audioManager.playPhotoTakingGuide();
    } else {
      // Fallback if audioManager isn't available: preserve original timing.
      await this.wait(this.PREP_SECONDS * 1000);
    }
  },

  /* Static "Get Ready!" message shown for exactly 3 seconds right
     before the shutter becomes available — unchanged from v3. */
  async runHeadsUp() {
    this.els.headsUpText.textContent = "Get Ready!";
    this.els.headsUpText.classList.remove("pop");
    void this.els.headsUpText.offsetWidth;
    this.els.headsUpText.classList.add("pop");

    this.els.headsUpOverlay.classList.add("show");
    await this.wait(3000);
    this.els.headsUpOverlay.classList.remove("show");
  },

  /* One guest-triggered shot: 3-second countdown → capture → ~1.5s
     captured-photo flash → back to live view, ready for the next press. */
  async _takeShot() {
    this.capturing = true;
    this._setShutterEnabled(false);

    const shotNumber = sessionState.shots.length + 1;
    this.currentShot = shotNumber;
    this.els.countdownOverlay.classList.add("show");

    // Start recording immediately from the very first countdown tick
    // (3→0), not partway through — this captures the full countdown and
    // avoids the "guest is already posing" but recording hasn't started
    // issue.
    let videoStarted = false;
    this.els.recordingBadge.hidden = false;
    try {
      await cameraController.startVideoRecording();
      videoStarted = true;
    } catch (e) {
      console.warn("Video recording failed to start:", e);
      this.els.recordingBadge.hidden = true;
    }

    for (let s = this.countdownSeconds; s >= 1; s--) {
      this.els.countdownNumber.textContent = s;
      // Play beep on every tick of the (now 3-second) countdown.
      if (typeof audioManager !== "undefined") {
        audioManager.playCountdownBeep();
      }
      await this.wait(1000);
    }

    this.els.countdownOverlay.classList.remove("show");

    let imageBlob = null;
    try {
      imageBlob = await cameraController.capturePhoto();
    } catch (e) {
      console.error("Capture failed:", e);
    }

    this.flashEffect();
    // Play shutter click on every shot capture
    if (typeof audioManager !== "undefined") {
      audioManager.playShutter();
    }

    // Show the captured photo full-frame the instant it's available, rather
    // than waiting for stopVideoRecording() below (its freeze-hold + video
    // remux can take a couple of seconds) before the guest sees anything.
    // Without this, the live camera feed kept refreshing underneath for
    // that entire wait, so guests would briefly see live view again right
    // after the shutter before their photo ever appeared.
    const imageUrl = imageBlob ? URL.createObjectURL(imageBlob) : null;
    if (imageUrl) {
      this.els.intervalPreviewImg.src = imageUrl;
      this.els.intervalPreview.classList.add("show");
    }

    let videoBlob = null;
    if (videoStarted) {
      this.els.recordingBadge.hidden = true; // hide RECORDING badge after capture
      try {
        videoBlob = await cameraController.stopVideoRecording(imageBlob);
      } catch (e) {
        console.warn("Video recording failed to stop:", e);
      }
    }

    const pair = {
      id: shotNumber,
      image: imageBlob,
      imageUrl,
      video: videoBlob,
      videoUrl: videoBlob ? URL.createObjectURL(videoBlob) : null,
      selected: false
    };

    sessionState.shots.push(pair);
    this._updatePhotosTakenUI();
    this._updateDoneButtonState();

    // Brief flash of the captured photo — the "NEXT PHOTO IN" pill actually
    // ticks down now (see _runCapturedIntervalCountdown) — then back to
    // live view, ready for the next SHUTTER press (or the next
    // auto-captured shot, if the session timer already expired).
    await this._runCapturedIntervalCountdown();

    this.capturing = false;

    // DONE was pressed while this shot was in flight — finish immediately.
    if (this._pendingFinish) {
      this._pendingFinish = false;
      this._doFinish();
      return;
    }

    // The session timer expired while this shot was in flight — resume
    // the timer-expiry flow now that this shot is safely wrapped up
    // (keeps auto-capturing if still under the 4-photo minimum, otherwise
    // finishes right away).
    if (this._timerExpired) {
      this._timerExpired = false;
      await this._autoCaptureToMinimumThenFinish();
      return;
    }

    if (!this.running) return;

    this._setShutterEnabled(sessionState.shots.length < this.maxPhotos);
  },

  /* Ticks the "NEXT PHOTO IN" pill (#intervalNumber) down from 3 to 1
     across CAPTURED_FLASH_MS, then hides the interval-preview overlay.
     Minor Fix: intervalNumber previously stayed frozen at its static
     HTML value ("3") for the whole flash — never actually counted down.
     3 steps (matching that starting value) spaced evenly across
     CAPTURED_FLASH_MS keeps the total on-screen time unchanged. Same
     code path for 2×6 and 4×6 Photo Taking, so both get the fix. */
  async _runCapturedIntervalCountdown() {
    const numEl = this.els.intervalNumber;
    const ticks = 3;
    const stepMs = this.CAPTURED_FLASH_MS / ticks;
    for (let s = ticks; s >= 1; s--) {
      if (numEl) numEl.textContent = s;
      await this.wait(stepMs);
    }
    this.els.intervalPreview.classList.remove("show");
  },

  _setShutterEnabled(enabled) {
    if (!this.els.shutterBtn) return;
    this.els.shutterBtn.disabled = !enabled;
  },

  _updateDoneButtonState() {
    if (!this.els.doneBtn) return;
    this.els.doneBtn.disabled = sessionState.shots.length < this.minPhotos;
  },

  _updatePhotosTakenUI() {
    const count = sessionState.shots.length;
    if (this.els.photosTakenCount) {
      this.els.photosTakenCount.innerHTML =
        `${count}<span class="photos-taken-slash">/</span><span class="photos-taken-total">${this.maxPhotos}</span>`;
    }
    if (this.els.photosTakenLabel) {
      this.els.photosTakenLabel.textContent = "Photos Taken";
    }
  },

  /* Ends the Photo Taking phase immediately and moves on to Photo
     Selection — used only by the DONE button, which is already disabled
     below minPhotos (8), so the 4-photo minimum is always satisfied here.
     If a shot is mid-capture, defers until it safely finishes (see
     _pendingFinish, checked in _takeShot). */
  _finishSession() {
    if (!this.running) return;
    if (this.capturing) {
      this._pendingFinish = true;
      return;
    }
    this._doFinish();
  },

  /* Fired when the 150s session timer runs out. If a shot is mid-capture,
     defer via _timerExpired (checked at the end of _takeShot) rather than
     cutting off a capture/recording in progress. Otherwise, hand off to
     _autoCaptureToMinimumThenFinish() right away. */
  async _onSessionTimerExpired() {
    if (!this.running) return;
    if (this.capturing) {
      this._timerExpired = true;
      return;
    }
    await this._autoCaptureToMinimumThenFinish();
  },

  /* Minor Fix: if the session timer expires before the guest has taken
     MIN_REQUIRED_FOR_SELECTION (4) photos, Photo Selection would have too
     few photos to let the guest pick 4 — so instead of ending right away,
     keep running the normal per-shot flow (same countdown/capture/flash
     as a guest-triggered shot via _takeShot) until the minimum is met,
     with SHUTTER/DONE disabled for the duration (_autoFinishing) so the
     guest can't interfere mid-loop. Finishes the session once done. If
     the guest had already reached 4+ photos by the time the timer fired,
     the while loop is a no-op and this finishes immediately, same as
     before. */
  async _autoCaptureToMinimumThenFinish() {
    if (!this.running) return;
    this._autoFinishing = true;
    this._setShutterEnabled(false);
    if (this.els.doneBtn) this.els.doneBtn.disabled = true;

    while (this.running && sessionState.shots.length < this.MIN_REQUIRED_FOR_SELECTION) {
      await this._takeShot();
      // _takeShot()'s own _updateDoneButtonState()/_setShutterEnabled calls
      // may have just re-enabled these (e.g. minPhotos reached mid-loop) —
      // force them back off for the remainder of the auto-capture loop.
      this._setShutterEnabled(false);
      if (this.els.doneBtn) this.els.doneBtn.disabled = true;
    }

    this._autoFinishing = false;
    this._doFinish();
  },

  _doFinish() {
    this.running = false;
    kioskTimer.hide();
    this._setShutterEnabled(false);
    if (this.els.doneBtn) this.els.doneBtn.disabled = true;
    this.els.intervalPreview.classList.remove("show");
    document.dispatchEvent(new CustomEvent("shooting:complete", { detail: sessionState.shots }));
  },

  flashEffect() {
    this.els.flash.classList.remove("flash");
    void this.els.flash.offsetWidth;
    this.els.flash.classList.add("flash");
  },

  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
};
