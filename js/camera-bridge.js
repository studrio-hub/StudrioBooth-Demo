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
  // NOTE: zoom is handled entirely client-side now (digital zoom only —
  // see camera-controller.js setZoom/_cropToZoom), so there is no
  // zoom endpoint here anymore.
  startVideoEndpoint: "/camera/video/start",
  stopVideoEndpoint: "/camera/video/stop",
  statusEndpoint: "/camera/status"
};

/* Prefer MP4/H.264 when the browser can record it directly — plays back
   natively on iOS/Android/most phones, unlike WebM which many mobile
   browsers (notably Safari/iOS) can't play at all. Falls back to WebM
   only when MP4 recording isn't supported. */
function pickSupportedVideoMimeType() {
  const candidates = [
    "video/mp4;codecs=h264",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return ""; // let the browser pick its own default
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  _recordCanvas: null,
  _recordCtx: null,
  _recordRafId: null,
  _freezeImage: null,
  _recording: false,

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

  /*
   * Records the live preview onto an off-screen canvas (instead of the
   * raw camera stream directly) so stopVideoRecording() below can swap
   * in the actual captured still photo for the last moment of the clip —
   * this makes the cut from "live video" to "photo just taken" read as
   * one continuous shot instead of an abrupt jump.
   */
  async startVideoRecording() {
    if (!this._stream) return;
    const videoEl = this._videoEl;

    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth || 1280;
    canvas.height = videoEl.videoHeight || 720;
    this._recordCanvas = canvas;
    this._recordCtx = canvas.getContext("2d");
    this._freezeImage = null;
    this._recording = true;

    const drawFrame = () => {
      if (!this._recording) return;
      const ctx = this._recordCtx;
      if (this._freezeImage) {
        ctx.drawImage(this._freezeImage, 0, 0, canvas.width, canvas.height);
      } else if (videoEl.readyState >= 2) {
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      }
      this._recordRafId = requestAnimationFrame(drawFrame);
    };
    drawFrame();

    this._recordedChunks = [];
    const mimeType = pickSupportedVideoMimeType();
    this._recorder = new MediaRecorder(canvas.captureStream(30), mimeType ? { mimeType } : undefined);
    this._recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this._recordedChunks.push(e.data);
    };
    this._recorder.start();
  },

  /*
   * freezeBlob (optional) — the still photo just captured. When provided,
   * the last ~600ms of the clip holds on that exact photo instead of
   * cutting off mid-motion, so the handoff into the between-shots preview
   * (which shows that same photo) feels seamless rather than abrupt.
   */
  async stopVideoRecording(freezeBlob) {
    if (!this._recorder) return null;

    if (freezeBlob) {
      try {
        this._freezeImage = await blobToImage(freezeBlob);
        await wait(600);
      } catch (e) {
        console.warn("Could not blend captured photo into video ending:", e);
      }
    }

    return new Promise((resolve) => {
      this._recorder.onstop = () => {
        this._recording = false;
        if (this._recordRafId) cancelAnimationFrame(this._recordRafId);
        const type = this._recorder.mimeType || "video/webm";
        resolve(new Blob(this._recordedChunks, { type }));
      };
      this._recorder.stop();
    });
  },

  async disconnect() {
    this._recording = false;
    if (this._recordRafId) cancelAnimationFrame(this._recordRafId);
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
  }
};