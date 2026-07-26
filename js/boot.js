/*
 * BOOT.JS — Page 0 startup sequence.
 * Runs every time the app loads. Performs a REAL camera connection
 * check via cameraController.connect() (real DSLR bridge, or mock
 * webcam fallback) — not a fake animation. Only transitions to the
 * home screen ("setup" page) once the camera reports connected.
 */

const bootModule = {
  steps: [
    "Starting photobooth system",
    "Connecting to DSLR camera",
    "Checking camera connection",
    "Preparing live preview",
    "Loading camera settings",
    "Camera ready"
  ],

  els: {
    list: document.getElementById("bootStatusList"),
    spinner: document.getElementById("bootSpinner"),
    error: document.getElementById("bootError"),
    errorText: document.getElementById("bootErrorText"),
    retryBtn: document.getElementById("btnBootRetry"),
    restartBtn: document.getElementById("btnBootRestart")
  },

  renderSteps() {
    this.els.list.innerHTML = this.steps
      .map((label, i) => `
        <div class="boot-status-item" id="boot-step-${i}">
          <span class="boot-status-icon"></span>
          <span>${label}</span>
        </div>
      `).join("");
  },

  setStepState(index, state) {
    const el = document.getElementById(`boot-step-${index}`);
    if (!el) return;
    el.classList.remove("active", "done");
    if (state) el.classList.add(state);
  },

  async run() {
    this.renderSteps();
    this.els.error.hidden = true;
    this.els.spinner.hidden = false;

    // Steps 0-2: cosmetic-but-honest pacing while we actually connect
    this.setStepState(0, "active");
    await this.wait(400);
    this.setStepState(0, "done");
    this.setStepState(1, "active");

    let status;
    try {
      status = await cameraController.connect(); // REAL check — DSLR bridge or mock webcam
    } catch (e) {
      status = { connected: false };
    }

    this.setStepState(1, "done");
    this.setStepState(2, "active");
    await this.wait(300);

    if (!status || !status.connected) {
      this.setStepState(2, null);
      this.els.spinner.hidden = true;
      this.els.error.hidden = false;
      this.els.errorText.textContent = "Camera not detected";
      return;
    }

    this.setStepState(2, "done");
    this.setStepState(3, "active");
    cameraController.attachPreview(setupEls.video, setupEls.img);
    await this.wait(300);
    this.setStepState(3, "done");

    this.setStepState(4, "active");
    renderCameraStatus(status); // reuse existing function from app.js
    setupEls.placeholder.hidden = true;
    setupEls.nextBtn.disabled = false;
    await this.wait(300);
    this.setStepState(4, "done");

    this.setStepState(5, "done");
    this.els.spinner.hidden = true;
    await this.wait(400);

    goToPage("setup"); // hand off to the home screen
  },

  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
};

document.getElementById("btnBootRetry").addEventListener("click", () => bootModule.run());
document.getElementById("btnBootRestart").addEventListener("click", () => bootModule.run());

bootModule.run();
