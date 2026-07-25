/*
 * SHOOTING LOGIC — Page 3
 * Handles the 8-shot countdown loop, mid-countdown video start,
 * shutter trigger, and saving image/video pairs into session state.
 */

const shootingModule = {
  totalShots: 8,
  currentShot: 0,
  countdownSeconds: 8,
  videoStartsAt: 4, // begin recording when countdown hits this number
  running: false,

  els: {
    counter: document.getElementById("shotCounter"),
    countdownOverlay: document.getElementById("countdownOverlay"),
    countdownNumber: document.getElementById("countdownNumber"),
    recordingBadge: document.getElementById("recordingBadge"),
    flash: document.getElementById("capturedFlash"),
    thumbnails: document.getElementById("shotThumbnails"),
    startBtn: document.getElementById("btnStartShooting"),
    hint: document.getElementById("shootingHint"),
    video: document.getElementById("shootingVideo"),
    img: document.getElementById("shootingImg")
  },

  initThumbnails() {
    this.els.thumbnails.innerHTML = "";
    for (let i = 1; i <= this.totalShots; i++) {
      const slot = document.createElement("div");
      slot.className = "shot-thumb";
      slot.id = `thumb-${i}`;
      slot.innerHTML = `<span class="thumb-num">${i}</span>`;
      this.els.thumbnails.appendChild(slot);
    }
  },

  async startSession() {
    if (this.running) return;
    this.running = true;
    this.currentShot = 0;
    sessionState.shots = [];
    this.initThumbnails();
    this.els.startBtn.disabled = true;
    this.els.hint.textContent = "Session in progress...";

    cameraController.attachPreview(this.els.video, this.els.img);

    for (let i = 1; i <= this.totalShots; i++) {
      await this.runSingleShot(i);
    }

    this.running = false;
    this.els.hint.textContent = "All 8 photos captured!";
    document.dispatchEvent(new CustomEvent("shooting:complete", { detail: sessionState.shots }));
  },

  async runSingleShot(shotNumber) {
    this.currentShot = shotNumber;
    this.els.counter.textContent = `PHOTO ${shotNumber} OF ${this.totalShots}`;
    this.els.countdownOverlay.classList.add("show");

    let videoStarted = false;

    for (let s = this.countdownSeconds; s >= 1; s--) {
      this.els.countdownNumber.textContent = s;

      if (s === this.videoStartsAt && !videoStarted) {
        videoStarted = true;
        this.els.recordingBadge.hidden = false;
        try {
          await cameraController.startVideoRecording();
        } catch (e) {
          console.warn("Video recording failed to start:", e);
        }
      }

      await this.wait(1000);
    }

    this.els.countdownOverlay.classList.remove("show");

    // Trigger shutter
    let imageBlob = null;
    try {
      imageBlob = await cameraController.capturePhoto();
    } catch (e) {
      console.error("Capture failed:", e);
    }

    this.flashEffect();

    let videoBlob = null;
    if (videoStarted) {
      this.els.recordingBadge.hidden = true;
      try {
        videoBlob = await cameraController.stopVideoRecording();
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
    this.updateThumbnail(shotNumber, pair);
  },

  updateThumbnail(shotNumber, pair) {
    const slot = document.getElementById(`thumb-${shotNumber}`);
    if (!slot) return;
    slot.classList.add("filled");
    if (pair.imageUrl) {
      slot.innerHTML = `<img src="${pair.imageUrl}" alt="Shot ${shotNumber}">`;
    }
  },

  flashEffect() {
    this.els.flash.classList.remove("flash");
    void this.els.flash.offsetWidth; // restart animation
    this.els.flash.classList.add("flash");
  },

  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
};

document.getElementById("btnStartShooting").addEventListener("click", () => {
  shootingModule.startSession();
});