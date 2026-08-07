/*
 * CAMERA CONTROLLER
 * ----------------------------------------------------
 * The rest of the app talks ONLY to this object — never directly to a bridge.
 *
 * Connection priority:
 *   1. realCameraBridge  — Canon EDSDK via Electron IPC (native Windows main process)
 *                          Canon DSLR over USB. Used in production kiosk mode.
 *   2. mockCameraBridge  — navigator.mediaDevices system webcam.
 *                          Fallback for UI development without a DSLR attached.
 *
 * The camera name (via Electron IPC camera:detect) is used for display.
 */

const cameraController = {
  mode: null,          // 'real' | 'mock' | null
  mirrorEnabled: false,
  zoomLevel: 1.0,
  _previewEls: { video: null, img: null },
  status: {
    connected: false,
    model: '—',
    connection: '—',
    previewAvailable: false,
    zoomType: '—'
  },

  async connect() {
    // ── 1. Try Canon EDSDK (real DSLR via Electron IPC) ─────────────────────
    try {
      const info = await realCameraBridge.connect();
      this.mode = 'real';

      let displayModel = info.model;
      if (window.electronAPI) {
        try {
          const pnp = await window.electronAPI.detectCamera();
          if (pnp.success && pnp.model) displayModel = pnp.model;
        } catch (_) {}
      }

      this.status = {
        connected: true,
        model: displayModel,
        connection: info.connection,
        previewAvailable: true,
        zoomType: 'digital'
      };
      console.log(`[Controller] Connected via Canon EDSDK: ${displayModel}`);
      return this.status;
    } catch (e) {
      console.warn('[Controller] Canon EDSDK camera not available:', e.message);
    }

    // ── 2. Fall back to system webcam (development / demo only) ───────────
    try {
      const webcamStatus = await mockCameraBridge.checkAvailable();
      if (!webcamStatus) throw new Error('No video input devices found');

      const info = await mockCameraBridge.connect();
      this.mode = 'mock';
      this.status = {
        connected: true,
        model: info.model,
        connection: info.connection,
        previewAvailable: true,
        zoomType: 'digital'
      };
      console.log(`[Controller] Connected via system webcam fallback: ${info.model}`);
      return this.status;
    } catch (e) {
      console.error('[Controller] All camera connection attempts failed:', e.message);
    }

    // ── Nothing worked ─────────────────────────────────────────────────────
    this.mode = null;
    this.status = {
      connected: false,
      model: '—',
      connection: '—',
      previewAvailable: false,
      zoomType: '—'
    };
    throw new Error(
      'No camera found. Please check that your Canon camera is connected via USB and turned on.'
    );
  },

  isMock() {
    return this.mode === 'mock';
  },

  attachPreview(videoEl, imgEl) {
    this._previewEls = { video: videoEl, img: imgEl };

    if (this.mode === 'real') {
      videoEl.hidden = true;
      imgEl.hidden   = false;
      realCameraBridge.startPreviewStream(imgEl);
    } else if (this.mode === 'mock') {
      mockCameraBridge._videoEl = videoEl;
      videoEl.srcObject = mockCameraBridge.getStream();
      videoEl.hidden    = false;
      imgEl.hidden      = true;
    }

    this._applyPreviewTransform();
  },

  async setZoom(level) {
    if (!this.mode) throw new Error('Camera not connected');
    this.zoomLevel = Math.max(1.0, Math.min(5.0, level));
    this._applyPreviewTransform();
    return { level: this.zoomLevel, type: 'digital' };
  },

  setMirror(enabled) {
    this.mirrorEnabled = !!enabled;
    this._applyPreviewTransform();
  },

  _applyPreviewTransform() {
    const mirror    = this.mirrorEnabled ? -1 : 1;
    const transform = `scale(${this.zoomLevel * mirror}, ${this.zoomLevel})`;
    if (this._previewEls.video) this._previewEls.video.style.transform = transform;
    if (this._previewEls.img)   this._previewEls.img.style.transform   = transform;
  },

  async capturePhoto() {
    let blob;
    if      (this.mode === 'real') blob = await realCameraBridge.capturePhoto(this.mirrorEnabled);
    else if (this.mode === 'mock') blob = await mockCameraBridge.capturePhoto(this.mirrorEnabled);
    else throw new Error('Camera not connected');

    if (this.zoomLevel <= 1.001) return blob;
    return this._cropToZoom(blob, this.zoomLevel);
  },

  async _cropToZoom(blob, zoom) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload  = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx  = canvas.getContext('2d');
      const cropW = img.naturalWidth  / zoom;
      const cropH = img.naturalHeight / zoom;
      const sx    = (img.naturalWidth  - cropW) / 2;
      const sy    = (img.naturalHeight - cropH) / 2;
      ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);
      return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    } finally {
      URL.revokeObjectURL(url);
    }
  },

  async startVideoRecording() {
    if (this.mode === 'real') return realCameraBridge.startVideoRecording(this.zoomLevel, this.mirrorEnabled);
    if (this.mode === 'mock') return mockCameraBridge.startVideoRecording(this.zoomLevel, this.mirrorEnabled);
    throw new Error('Camera not connected');
  },

  async stopVideoRecording(freezeBlob) {
    if (this.mode === 'real') return realCameraBridge.stopVideoRecording(freezeBlob);
    if (this.mode === 'mock') return mockCameraBridge.stopVideoRecording(freezeBlob);
    throw new Error('Camera not connected');
  },

  async disconnect() {
    if (this.mode === 'real') await realCameraBridge.disconnect();
    if (this.mode === 'mock') await mockCameraBridge.disconnect();
    this.mode = null;
    this.status.connected = false;
  }
};
