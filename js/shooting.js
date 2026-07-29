/*
 * SHOOTING LOGIC — Page 3
 * Handles the 8-shot countdown loop, mid-countdown video start,
 * shutter trigger, 3-second inter-shot interval, and saving
 * image/video pairs into session state.
 *
 * Between shots, instead of dimming the screen, the photo that was
 * just captured is shown full-frame with a small countdown pill at
 * the bottom — the guest can clearly see their shot while waiting
 * for the next one.
 */

const shootingModule = {
  totalShots: 8,
  currentShot: 0,
  countdownSeconds: 8,
  videoStartsAt: 4,
  running: false,

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
    headsUpText: document.getElementById("headsUpText")
  },

  async startSession() {
    if (this.running) return;
    this.running = true;
    this.currentShot = 0;
    sessionState.shots = [];

    cameraController.attachPreview(this.els.video, this.els.img);

    await this.runHeadsUp();

    for (let i = 1; i <= this.totalShots; i++) {
      const pair = await this.runSingleShot(i);
      if (i < this.totalShots) await this.runInterval(pair);
    }

    this.running = false;
    document.dispatchEvent(new CustomEvent("shooting:complete", { detail: sessionState.shots }));
  },

  /* Static "Get Ready!" message shown for exactly 3 seconds right
     before the first shot — replaces the old 3-2-1 countdown. */
  async runHeadsUp() {
    this.els.headsUpText.textContent = "Get Ready!";
    this.els.headsUpText.classList.remove("pop");
    void this.els.headsUpText.offsetWidth;
    this.els.headsUpText.classList.add("pop");

    this.els.headsUpOverlay.classList.add("show");
    await this.wait(3000);
    this.els.headsUpOverlay.classList.remove("show");
  },

  async runSingleShot(shotNumber) {
    this.currentShot = shotNumber;
    this.els.counter.textContent = `PHOTO ${shotNumber} OF ${this.totalShots}`;
    this.els.countdownOverlay.classList.add("show");

    // Start recording immediately from the very first countdown tick (8→0),
    // not partway through — this captures the full countdown and avoids the
    // "guest is already posing" but recording hasn't started issue.
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
      imageUrl: imageBlob ? URL.createObjectURL(imageBlob) : null,
      video: videoBlob,
      videoUrl: videoBlob ? URL.createObjectURL(videoBlob) : null,
      selected: false
    };

    sessionState.shots.push(pair);
    return pair;
  },

  async runInterval(pair) {
    if (pair && pair.imageUrl) {
      this.els.intervalPreviewImg.src = pair.imageUrl;
    }
    this.els.intervalPreview.classList.add("show");

    for (let s = 3; s >= 1; s--) {
      this.els.intervalNumber.textContent = s;
      await this.wait(1000);
    }

    this.els.intervalPreview.classList.remove("show");
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