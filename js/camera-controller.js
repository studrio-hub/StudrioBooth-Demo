/*
 * CAMERA CONTROLLER
 * ----------------------------------------------------
 * Rest of the app talks ONLY to this object. It decides at
 * connect-time whether to use the real bridge or fall back
 * to the mock bridge, and exposes a single stable interface.
 */

const cameraController = {
  mode: null,
  mirrorEnabled: false, // NEW — set by the Mirror toggle in app.js
  zoomLevel: 1.0,       // Digital zoom only — see setZoom() below
  _previewEls: { video: null, img: null },
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
        zoomType: "digital"
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
        zoomType: "digital"
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
    this._previewEls = { video: videoEl, img: imgEl };

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

    this._applyPreviewTransform();
  },

  /*
   * DIGITAL ZOOM ONLY — this never touches the DSLR's optical zoom.
   * It simply scales the on-screen preview (a visual crop/enlarge),
   * and capturePhoto() below crops the captured frame to match so
   * the exported photo lines up with what the guest saw on screen.
   */
  async setZoom(level) {
    if (!this.mode) throw new Error("Camera not connected");
    this.zoomLevel = Math.max(1.0, Math.min(5.0, level));
    this._applyPreviewTransform();
    return { level: this.zoomLevel, type: "digital" };
  },

  setMirror(enabled) {
    this.mirrorEnabled = !!enabled;
    this._applyPreviewTransform();
  },

  _applyPreviewTransform() {
    const mirror = this.mirrorEnabled ? -1 : 1;
    const transform = `scale(${this.zoomLevel * mirror}, ${this.zoomLevel})`;
    if (this._previewEls.video) this._previewEls.video.style.transform = transform;
    if (this._previewEls.img) this._previewEls.img.style.transform = transform;
  },

  async capturePhoto() {
    let blob;
    if (this.mode === "real") blob = await realCameraBridge.capturePhoto();
    else if (this.mode === "mock") blob = await mockCameraBridge.capturePhoto(this.mirrorEnabled);
    else throw new Error("Camera not connected");

    if (this.zoomLevel <= 1.001) return blob;
    return this._cropToZoom(blob, this.zoomLevel);
  },

  /* Crops the captured frame to the same centered region the zoomed
     preview was showing, then scales it back up to full resolution. */
  async _cropToZoom(blob, zoom) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });

      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");

      const cropW = img.naturalWidth / zoom;
      const cropH = img.naturalHeight / zoom;
      const sx = (img.naturalWidth - cropW) / 2;
      const sy = (img.naturalHeight - cropH) / 2;

      ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    } finally {
      URL.revokeObjectURL(url);
    }
  },

  async startVideoRecording() {
    if (this.mode === "real") return realCameraBridge.startVideoRecording();
    // Pass the current zoom level and mirror state so the mock bridge bakes
    // the same crop + flip into the recorded pixels that the guest sees on screen.
    if (this.mode === "mock") return mockCameraBridge.startVideoRecording(this.zoomLevel, this.mirrorEnabled);
    throw new Error("Camera not connected");
  },

  async stopVideoRecording(freezeBlob) {
    if (this.mode === "real") return realCameraBridge.stopVideoRecording();
    if (this.mode === "mock") return mockCameraBridge.stopVideoRecording(freezeBlob);
    throw new Error("Camera not connected");
  },

  async disconnect() {
    if (this.mode === "real") return realCameraBridge.disconnect();
    if (this.mode === "mock") return mockCameraBridge.disconnect();
  }
};