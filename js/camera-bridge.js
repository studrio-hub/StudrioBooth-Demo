/*
 * CAMERA BRIDGE
 * ----------------------------------------------------
 * This file is the ONLY place that should know whether we're
 * talking to a REAL DSLR bridge or a MOCK bridge.
 *
 * Real bridge: a local service (Node/Electron, digiCamControl,
 * gphoto2 HTTP wrapper, manufacturer SDK, etc.) exposing the
 * endpoints described in CAMERA_CONFIG below.
 *
 * Mock bridge: uses your laptop/kiosk webcam via getUserMedia
 * purely so you can develop and test the UI/flow without a
 * DSLR plugged in. It is CLEARLY LABELED as mock everywhere
 * in the UI (see the "mockTag" element in index.html).
 */

const CAMERA_CONFIG = {
  bridgeUrl: "http://localhost:3000",
  connectionType: "http", // "http" | "websocket"
  livePreviewEndpoint: "/camera/live-preview",
  captureEndpoint: "/camera/capture",
  zoomEndpoint: "/camera/zoom",
  startVideoEndpoint: "/camera/video/start",
  stopVideoEndpoint: "/camera/video/stop",
  statusEndpoint: "/camera/status"
};

const realCameraBridge = {
  async checkAvailable() {
    try {
      const res = await fetch(`${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.statusEndpoint}`, {
        method: "GET",
        signal: AbortSignal.timeout(1500)
      });
      if (!res.ok) return null;
      return await res.json(); // expected: { connected: bool, model: string, connection: string }
    } catch (e) {
      return null;
    }
  },

  async connect() {
    const res = await fetch(`${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.statusEndpoint}`);
    return res.json();
  },

  getLivePreviewUrl() {
    // MJPEG-style endpoint the <img> tag can point straight at,
    // or swap for a WebSocket handler depending on your bridge.
    return `${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.livePreviewEndpoint}`;
  },

  async setZoom(level) {
    const res = await fetch(`${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.zoomEndpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level })
    });
    return res.json(); // expected: { level, type: "optical"|"digital" }
  },

  async capturePhoto() {
    const res = await fetch(`${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.captureEndpoint}`, {
      method: "POST"
    });
    const blob = await res.blob();
    return blob;
  },

  async startVideoRecording() {
    await fetch(`${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.startVideoEndpoint}`, { method: "POST" });
  },

  async stopVideoRecording() {
    const res = await fetch(`${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.stopVideoEndpoint}`, { method: "POST" });
    const blob = await res.blob();
    return blob;
  },

  async disconnect() {
    // Optional: notify bridge to release the camera handle
  }
};

/* ---------------------------------------------------------
 * MOCK BRIDGE — clearly a placeholder, webcam-based, dev only
 * --------------------------------------------------------- */
const mockCameraBridge = {
  _stream: null,
  _videoEl: null,
  _recorder: null,
  _recordedChunks: [],
  _zoom: 1.0,

  async checkAvailable() {
    return null; // mock is never the "real" bridge — forces explicit mock mode
  },

  async connect() {
    this._stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    return { connected: true, model: "MOCK Webcam (dev placeholder)", connection: "Webcam" };
  },

  getStream() {
    return this._stream;
  },

  async setZoom(level) {
    this._zoom = level;
    return { level, type: "preview-only" };
  },

  async capturePhoto(mirror = false) {
    const videoEl = this._videoEl;
    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth || 1280;
    canvas.height = videoEl.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (mirror) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
  }
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  },

  async startVideoRecording() {
    if (!this._stream) return;
    this._recordedChunks = [];
    this._recorder = new MediaRecorder(this._stream, { mimeType: "video/webm" });
    this._recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this._recordedChunks.push(e.data);
    };
    this._recorder.start();
  },

  async stopVideoRecording() {
    return new Promise((resolve) => {
      if (!this._recorder) return resolve(null);
      this._recorder.onstop = () => {
        const blob = new Blob(this._recordedChunks, { type: "video/webm" });
        resolve(blob);
      };
      this._recorder.stop();
    });
  },

  async disconnect() {
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
  }
};
