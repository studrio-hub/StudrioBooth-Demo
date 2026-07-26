/*
 * SHOOTING LOGIC — Page 3
 * Handles the 8-shot countdown loop, mid-countdown video start,
 * shutter trigger, 3-second inter-shot interval, and saving
 * image/video pairs into session state.
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
    thumbnails: document.getElementById("shotThumbnails"),
    startBtn: document.getElementById("btnStartShooting"),
    hint: document.getElementById("shootingHint"),
    video: document.getElementById("shootingVideo"),
    img: document.getElementById("shootingImg")
  },

  initThumbnails() {
    this.els.thumbnails.innerHTML = "";
    for (let i = 1; i <= this.totalShots; i++) {
      const row = document.createElement("div");
      row.className = "shot-thumb-row";
      row.id = `thumb-${i}`;
      row.innerHTML = `
        <div class="thumb-img-wrap"></div>
        <span class="thumb-label">${i} / ${this.totalShots}</span>
      `;
      this.els.thumbnails.appendChild(row);
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
    this.els.video.classList.toggle("mirrored", cameraController.mirrorEnabled);
    this.els.img.classList.toggle("mirrored", cameraController.mirrorEnabled);

    for (let i = 1; i <= this.totalShots; i++) {
      await this.runSingleShot(i);
      if (i < this.totalShots) await this.runInterval();
    }

    this.running = false;
    this.els.startBtn.disabled = false;
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

  async runInterval() {
    const overlay = document.getElementById("intervalOverlay");
    const numberEl = document.getElementById("intervalNumber");
    overlay.classList.add("show");
    for (let s = 3; s >= 1; s--) {
      numberEl.textContent = s;
      await this.wait(1000);
    }
    overlay.classList.remove("show");
  },

  updateThumbnail(shotNumber, pair) {
    const row = document.getElementById(`thumb-${shotNumber}`);
    if (!row) return;
    row.classList.add("filled");
    const wrap = row.querySelector(".thumb-img-wrap");
    if (pair.imageUrl && wrap) {
      wrap.innerHTML = `<img src="${pair.imageUrl}" alt="Shot ${shotNumber}">`;
    }
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

document.getElementById("btnStartShooting").addEventListener("click", () => {
  shootingModule.startSession();
});