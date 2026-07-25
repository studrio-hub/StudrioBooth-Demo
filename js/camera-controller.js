/*
 * CAMERA CONTROLLER
 * ----------------------------------------------------
 * Rest of the app talks ONLY to this object. It decides at
 * connect-time whether to use the real bridge or fall back
 * to the mock bridge, and exposes a single stable interface.
 */

const cameraController = {
  mode: null, // "real" | "mock" | null
  status: {
    connected: false,
    model: "—",
    connection: "—",
    previewAvailable: false,
    zoomType: "—"
  },

  async connect() {
    const realStatus = await realCameraBridge.checkAvailable();

    if (realStatus && realStatus.connected) {
      this.mode = "real";
      const info = await realCameraBridge.connect();
      this.status = {
        connected: true,
        model: info.model || realStatus.model || "DSLR",
        connection: info.connection || "USB / Tethered",
        previewAvailable: true,
        zoomType: "optical"
      };
      return this.status;
    }

    // Fall back to mock bridge (dev/testing only)
    try {
      this.mode = "mock";
      const info = await mockCameraBridge.connect();
      this.status = {
        connected: true,
        model: info.model,
        connection: info.connection,
        previewAvailable: true,
        zoomType: "preview-only"
      };
      return this.status;
    } catch (e) {
      this.mode = null;
      this.status = {
        connected: false,
        model: "—",
        connection: "—",
        previewAvailable: false,
        zoomType: "—"
      };
      throw e;
    }
  },

  isMock() {
    return this.mode === "mock";
  },

  attachPreview(videoEl, imgEl) {
    if (this.mode === "mock") {
      mockCameraBridge._videoEl = videoEl;
      videoEl.srcObject = mockCameraBridge.getStream();
      videoEl.hidden = false;
      imgEl.hidden = true;
    } else if (this.mode === "real") {
      videoEl.hidden = true;
      imgEl.src = realCameraBridge.getLivePreviewUrl();
      imgEl.hidden = false;
    }
  },

  async setZoom(level) {
    if (this.mode === "real") return realCameraBridge.setZoom(level);
    if (this.mode === "mock") return mockCameraBridge.setZoom(level);
    throw new Error("Camera not connected");
  },

  async capturePhoto() {
    if (this.mode === "real") return realCameraBridge.capturePhoto();
    if (this.mode === "mock") return mockCameraBridge.capturePhoto();
    throw new Error("Camera not connected");
  },

  async startVideoRecording() {
    if (this.mode === "real") return realCameraBridge.startVideoRecording();
    if (this.mode === "mock") return mockCameraBridge.startVideoRecording();
    throw new Error("Camera not connected");
  },

  async stopVideoRecording() {
    if (this.mode === "real") return realCameraBridge.stopVideoRecording();
    if (this.mode === "mock") return mockCameraBridge.stopVideoRecording();
    throw new Error("Camera not connected");
  },

  async disconnect() {
    if (this.mode === "real") return realCameraBridge.disconnect();
    if (this.mode === "mock") return mockCameraBridge.disconnect();
  }
};