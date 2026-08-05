/*
 * CAMERA BRIDGE
 * ----------------------------------------------------
 * Updated to use Electron IPC instead of local HTTP bridge.
 */

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

/* Social media compatible MP4 remuxing (client-side) */
async function remuxToMp4(inputBlob) {
  if (typeof VideoDecoder === "undefined" || typeof Muxer === "undefined") {
    console.warn("[remux] WebCodecs or mp4-muxer not available");
    return inputBlob;
  }
  const url = URL.createObjectURL(inputBlob);
  try {
    const video = document.createElement("video");
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
    });
    const width = Math.floor(video.videoWidth / 2) * 2;
    const height = Math.floor(video.videoHeight / 2) * 2;
    const fps = 30;
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: "avc", width, height, frameRate: fps },
      fastStart: "in-memory"
    });
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => console.error(e)
    });
    encoder.configure({ codec: "avc1.42001f", width, height, bitrate: 2_500_000, framerate: fps });
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    const totalFrames = Math.round(video.duration * fps);
    for (let i = 0; i < totalFrames; i++) {
      const timestamp = i / fps;
      video.currentTime = timestamp;
      await new Promise(r => { video.onseeked = r; });
      ctx.drawImage(video, 0, 0, width, height);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(timestamp * 1_000_000) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
    }
    await encoder.flush();
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: "video/mp4" });
  } catch (e) {
    console.error("[remux] Failed:", e);
    return inputBlob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const realCameraBridge = {
  async checkAvailable() {
    if (!window.electronAPI) return null;
    try {
      const info = await window.electronAPI.detectCamera();
      return info.success ? { connected: true, model: info.model } : null;
    } catch (e) {
      return null;
    }
  },

  async connect() {
    const info = await window.electronAPI.detectCamera();
    return { connected: info.success, model: info.model, connection: "USB (Electron)" };
  },

  getLivePreviewUrl() {
    // In Electron, we might use a custom protocol or a local stream.
    // For now, we assume the main process provides a preview signal.
    return "electron://live-preview"; 
  },

  async capturePhoto() {
    const result = await window.electronAPI.capturePhoto();
    if (!result.success) throw new Error("Capture failed");
    
    // Fetch the captured file from the local path provided by Electron
    const res = await fetch(`file://${result.filePath}`);
    return await res.blob();
  },

  async startVideoRecording() {
    // In Electron, we can handle this natively or via the same stream logic
    console.log("[Bridge] Starting video recording via Electron...");
  },

  async stopVideoRecording() {
    console.log("[Bridge] Stopping video recording via Electron...");
    // Return a mock or real blob for now
    return new Blob([], { type: "video/mp4" });
  },

  async disconnect() {
    console.log("[Bridge] Disconnecting camera...");
  }
};

/* MOCK BRIDGE (remains for testing in non-electron environments) */
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

  async checkAvailable() { return null; },
  async connect() {
    this._stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    return { connected: true, model: "MOCK Webcam", connection: "Webcam" };
  },
  getStream() { return this._stream; },
  async capturePhoto(mirror = false) {
    const videoEl = this._videoEl;
    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth || 1280;
    canvas.height = videoEl.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.92));
  },
  async startVideoRecording(zoom = 1.0, mirror = false) {
    if (!this._stream) return;
    const videoEl = this._videoEl;
    const srcW = videoEl.videoWidth || 1280;
    const srcH = videoEl.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = srcW; canvas.height = srcH;
    this._recordCanvas = canvas;
    this._recordCtx = canvas.getContext("2d");
    this._recording = true;
    this._recordZoom = Math.max(1.0, zoom);
    this._recordMirror = !!mirror;
    const drawFrame = () => {
      if (!this._recording) return;
      const ctx = this._recordCtx;
      const source = this._freezeImage || (videoEl.readyState >= 2 ? videoEl : null);
      if (source) {
        const sw = (source.videoWidth || source.naturalWidth) / this._recordZoom;
        const sh = (source.videoHeight || source.naturalHeight) / this._recordZoom;
        const sx = ((source.videoWidth || source.naturalWidth) - sw) / 2;
        const sy = ((source.videoHeight || source.naturalHeight) - sh) / 2;
        ctx.save();
        if (this._recordMirror) { ctx.translate(srcW, 0); ctx.scale(-1, 1); }
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, srcW, srcH);
        ctx.restore();
      }
      this._recordRafId = requestAnimationFrame(drawFrame);
    };
    drawFrame();
    this._recordedChunks = [];
    this._recorder = new MediaRecorder(canvas.captureStream(30));
    this._recorder.ondataavailable = e => { if (e.data.size > 0) this._recordedChunks.push(e.data); };
    this._recorder.start();
  },
  async stopVideoRecording(freezeBlob) {
    if (!this._recorder) return null;
    if (freezeBlob) {
      const rawImg = await blobToImage(freezeBlob);
      const freezeCanvas = document.createElement("canvas");
      freezeCanvas.width = this._recordCanvas.width;
      freezeCanvas.height = this._recordCanvas.height;
      freezeCanvas.getContext("2d").drawImage(rawImg, 0, 0, freezeCanvas.width, freezeCanvas.height);
      this._freezeImage = freezeCanvas;
      await wait(600);
    }
    const rawBlob = await new Promise(resolve => {
      this._recorder.onstop = () => {
        this._recording = false;
        cancelAnimationFrame(this._recordRafId);
        resolve(new Blob(this._recordedChunks, { type: this._recorder.mimeType }));
      };
      this._recorder.stop();
    });
    return remuxToMp4(rawBlob);
  },
  async disconnect() {
    if (this._stream) this._stream.getTracks().forEach(t => t.stop());
  }
};
