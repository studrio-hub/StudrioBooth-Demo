/*
 * CAMERA BRIDGE (Canon EDSDK & Real-time Live View Stream)
 */

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function remuxToMp4(inputBlob) {
  if (typeof VideoDecoder === "undefined" || typeof Muxer === "undefined") {
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
    const width  = Math.floor(video.videoWidth  / 2) * 2;
    const height = Math.floor(video.videoHeight / 2) * 2;
    const fps    = 30;
    const muxer  = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: "avc", width, height, frameRate: fps },
      fastStart: "in-memory"
    });
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error:  (e) => console.error(e)
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

/* ── Canon EDSDK camera bridge (Electron IPC) ─────────────────────────────── */

const realCameraBridge = {
  _recording:      false,
  _recorder:       null,
  _recordedChunks: [],
  _recordCanvas:   null,
  _recordCtx:      null,
  _recordRafId:    null,
  _previewActive:   false,
  _previewTimeoutId: null,
  _imgEl:          null,

  async checkAvailable() {
    if (!window.electronAPI) return null;
    try {
      const status = await window.electronAPI.statusCamera();
      return status && status.connected ? { connected: true, model: status.model || 'Canon DSLR' } : null;
    } catch (e) {
      return null;
    }
  },

  async connect() {
    if (!window.electronAPI) throw new Error('Electron API not available');
    const res = await window.electronAPI.connectCamera();
    if (!res || !res.connected) throw new Error('Canon EDSDK camera not connected');
    return { connected: true, model: res.model, connection: 'Canon EDSDK (Native FFI)' };
  },

  async startPreviewStream(imgEl) {
    this._imgEl = imgEl;
    if (window.electronAPI) {
      try {
        await window.electronAPI.startPreview();
      } catch (_) {}
    }

    // Poll live view frames from Canon EDSDK via Electron IPC. Self-
    // scheduling (fetch → wait → schedule next) rather than a fixed
    // setInterval: each EdsDownloadEvfImage round-trip can take longer than
    // the ~66ms target on real hardware (see the retry warnings in the main
    // process log), and a plain setInterval doesn't wait for the previous
    // call to finish — calls pile up and frames arrive out of order, which
    // is what made both the live preview and the recorded video look laggy.
    this._previewActive = true;
    const TARGET_FRAME_MS = 66; // ~15 fps target
    const pollFrame = async () => {
      if (!this._previewActive) return;
      const t0 = performance.now();
      if (imgEl && !imgEl.hidden && window.electronAPI && window.electronAPI.getFrame) {
        try {
          const res = await window.electronAPI.getFrame();
          if (res) {
            // edsdk-ffi now returns raw JPEG bytes (Buffer/Uint8Array) rather
            // than a base64 data URL — keep the data: URL branch only as a
            // fallback for older/alternate bridges that still send one.
            const blob = (typeof res === 'string' && res.startsWith('data:'))
              ? await (await fetch(res)).blob()
              : new Blob([res], { type: 'image/jpeg' });
            const newUrl = URL.createObjectURL(blob);
            const old = imgEl.src;
            imgEl.src = newUrl;
            try {
              // Wait for the browser to fully decode the new frame before
              // treating it as "current". Without this, a fast poll cycle
              // could revoke the previous blob URL (or the recording loop's
              // rAF could call drawImage) while the new <img> is still
              // mid-decode — on a slow/torn frame that reads as a dropped
              // or glitched frame in both the live preview and the
              // recorded video.
              if (imgEl.decode) await imgEl.decode();
            } catch (_) {
              // Decode can reject (e.g. the frame got replaced again before
              // it finished) — harmless, just fall through and let the next
              // poll cycle catch up.
            }
            if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
          }
        } catch (_) {}
      }
      if (this._previewActive) {
        // Self-pace off actual elapsed time rather than always waiting a
        // flat 66ms after whatever the round-trip took. On real hardware
        // EdsDownloadEvfImage can occasionally run long; padding a fixed
        // delay on top of that compounds the backlog and frames arrive in
        // bursts (which is exactly what showed up as stutter). Targeting a
        // consistent ~66ms cycle keeps frame arrival evenly spaced instead.
        const elapsed = performance.now() - t0;
        const delay = Math.max(16, TARGET_FRAME_MS - elapsed);
        this._previewTimeoutId = setTimeout(pollFrame, delay);
      }
    };
    pollFrame();
  },

  stopPreviewStream(imgEl) {
    this._previewActive = false;
    if (this._previewTimeoutId) {
      clearTimeout(this._previewTimeoutId);
      this._previewTimeoutId = null;
    }
    if (window.electronAPI) {
      try { window.electronAPI.stopPreview(); } catch (_) {}
    }
    if (imgEl) imgEl.src = '';
  },

  async capturePhoto(mirror = false) {
    if (!window.electronAPI) throw new Error('Electron API not available');
    const result = await window.electronAPI.capturePhoto();
    let blob;
    if (result && result.buffer) {
      blob = new Blob([result.buffer], { type: 'image/jpeg' });
    } else if (result instanceof ArrayBuffer || ArrayBuffer.isView(result)) {
      blob = new Blob([result], { type: 'image/jpeg' });
    } else {
      blob = new Blob([result], { type: 'image/jpeg' });
    }

    // Live preview is mirrored client-side via CSS transform only — the
    // JPEG that comes back from the camera is always unflipped, so we have
    // to mirror the actual pixels here to match what the guest saw.
    if (!mirror) return blob;
    return this._mirrorBlob(blob);
  },

  async _mirrorBlob(blob) {
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
      const ctx = canvas.getContext('2d');
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0);
      return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    } finally {
      URL.revokeObjectURL(url);
    }
  },

  async startVideoRecording(zoom = 1.0, mirror = false) {
    if (window.electronAPI) {
      try { await window.electronAPI.startPreview(); } catch (_) {}
    }

    this._recording = true;
    const canvas = document.createElement('canvas');
    canvas.width  = 1280;
    canvas.height = 720;
    this._recordCanvas = canvas;
    this._recordCtx    = canvas.getContext('2d');
    this._recordedChunks = [];

    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', '']
      .find(m => !m || MediaRecorder.isTypeSupported(m)) || '';
    // Explicit bitrate (rather than leaving it to the browser's default
    // heuristic) so guests moving around in the frame don't push the
    // encoder into starving/quantizing hard mid-clip, which shows up as
    // blocky, stuttery playback in the final strip.
    const recorderOpts = { videoBitsPerSecond: 4_000_000 };
    if (mimeType) recorderOpts.mimeType = mimeType;
    this._recorder = new MediaRecorder(canvas.captureStream(30), recorderOpts);
    this._recorder.ondataavailable = e => { if (e.data.size > 0) this._recordedChunks.push(e.data); };
    this._recorder.start();

    // The live-view <img> (updated ~15fps by startPreviewStream's polling)
    // is the only source of frames for the real camera — unlike the mock
    // webcam bridge there's no <video> element with a live MediaStream, so
    // this loop just keeps re-drawing whatever frame is currently in the
    // <img> onto the recording canvas.
    //
    // Crop-to-fill, not stretch-to-fill: first crop by zoom (this keeps the
    // live-view frame's own aspect ratio), then crop THAT rect again down to
    // the canvas's 16:9 target aspect before blitting. Previously the
    // zoom-cropped rect (still in the camera's native aspect ratio, which on
    // the M50 isn't 16:9) was drawn straight into the fixed 1280x720 box,
    // stretching every frame to fit.
    const canvasAspect = canvas.width / canvas.height;
    const draw = () => {
      if (!this._recording) return;
      const imgEl = this._imgEl;
      if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
        // Step 1: zoom crop (unchanged) — still in the frame's native aspect.
        let sw = imgEl.naturalWidth  / zoom;
        let sh = imgEl.naturalHeight / zoom;
        let sx = (imgEl.naturalWidth  - sw) / 2;
        let sy = (imgEl.naturalHeight - sh) / 2;

        // Step 2: crop-to-fill the canvas's aspect ratio out of that rect.
        const srcAspect = sw / sh;
        if (srcAspect > canvasAspect) {
          // Source is relatively wider than the canvas — trim the sides.
          const newSw = sh * canvasAspect;
          sx += (sw - newSw) / 2;
          sw = newSw;
        } else if (srcAspect < canvasAspect) {
          // Source is relatively taller than the canvas — trim top/bottom.
          const newSh = sw / canvasAspect;
          sy += (sh - newSh) / 2;
          sh = newSh;
        }

        this._recordCtx.save();
        if (mirror) {
          this._recordCtx.translate(canvas.width, 0);
          this._recordCtx.scale(-1, 1);
        }
        this._recordCtx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        this._recordCtx.restore();
      }
      this._recordRafId = requestAnimationFrame(draw);
    };
    draw();
  },

  async stopVideoRecording(freezeBlob) {
    if (!this._recorder) return null;

    // Hold on the just-captured still for a beat before ending, same as
    // the mock bridge, so the clip doesn't cut off mid-motion.
    if (freezeBlob && this._recordCtx && this._recordCanvas) {
      try {
        const freezeImg = await blobToImage(freezeBlob);
        const start = Date.now();
        while (Date.now() - start < 600) {
          this._recordCtx.drawImage(freezeImg, 0, 0, this._recordCanvas.width, this._recordCanvas.height);
          await wait(30);
        }
      } catch (_) {}
    }

    this._recording = false;
    if (this._recordRafId) { cancelAnimationFrame(this._recordRafId); this._recordRafId = null; }

    const rawBlob = await new Promise(resolve => {
      this._recorder.onstop = () => {
        resolve(new Blob(this._recordedChunks, { type: this._recorder.mimeType }));
      };
      this._recorder.stop();
    });
    return remuxToMp4(rawBlob);
  },

  async disconnect() {
    this._recording = false;
    if (this._recordRafId) { cancelAnimationFrame(this._recordRafId); this._recordRafId = null; }
    this.stopPreviewStream();
    console.log('[Bridge] Canon EDSDK bridge disconnected');
  }
};

/* ── Webcam fallback bridge (development / demo only) ────────────────────── */
const mockCameraBridge = {
  _stream:         null,
  _videoEl:        null,
  _recorder:       null,
  _recordedChunks: [],
  _recordCanvas:   null,
  _recordCtx:      null,
  _recordRafId:    null,
  _freezeImage:    null,
  _recording:      false,

  async checkAvailable() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.some(d => d.kind === 'videoinput') ? { connected: true, model: 'System Webcam' } : null;
    } catch (_) { return null; }
  },

  async connect() {
    console.log('[Bridge/Mock] Connecting to system webcam...');
    let devices = [];
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      probe.getTracks().forEach(t => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (e) {
      console.warn('[Bridge/Mock] Permission probe failed:', e.message);
    }

    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    this._stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });

    const label = videoDevices[0]?.label || 'System Webcam';
    return { connected: true, model: label, connection: 'System Webcam (fallback)' };
  },

  getStream() { return this._stream; },

  async capturePhoto(mirror = false) {
    const videoEl = this._videoEl;
    const canvas  = document.createElement('canvas');
    canvas.width  = videoEl.videoWidth  || 1280;
    canvas.height = videoEl.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  },

  async startVideoRecording(zoom = 1.0, mirror = false) {
    if (!this._ranking) {
      // recording start
    }
    this._recording    = true;
    this._recordedChunks = [];

    const videoEl = this._videoEl;
    const canvas = document.createElement('canvas');
    canvas.width  = videoEl?.videoWidth  || 1280;
    canvas.height = videoEl?.videoHeight || 720;
    this._recordCanvas = canvas;
    this._recordCtx    = canvas.getContext('2d');

    const stream = canvas.captureStream(30);
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', '']
      .find(m => !m || MediaRecorder.isTypeSupported(m)) || '';
    const recorderOpts = { videoBitsPerSecond: 4_000_000 };
    if (mimeType) recorderOpts.mimeType = mimeType;
    this._recorder = new MediaRecorder(stream, recorderOpts);
    this._recorder.ondataavailable = e => { if (e.data.size > 0) this._recordedChunks.push(e.data); };
    this._recorder.start();

    const draw = () => {
      if (!this._recording) return;
      if (videoEl && videoEl.readyState >= videoEl.HAVE_CURRENT_DATA) {
        const sw = videoEl.videoWidth  / zoom;
        const sh = videoEl.videoHeight / zoom;
        const sx = (videoEl.videoWidth  - sw) / 2;
        const sy = (videoEl.videoHeight - sh) / 2;
        this._recordCtx.save();
        if (mirror) {
          this._recordCtx.translate(canvas.width, 0);
          this._recordCtx.scale(-1, 1);
        }
        this._recordCtx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        this._recordCtx.restore();
      }
      this._recordRafId = requestAnimationFrame(draw);
    };
    draw();
  },

  async stopVideoRecording(freezeBlob) {
    if (!this._recorder) return null;
    this._recording = false;
    if (this._recordRafId) cancelAnimationFrame(this._recordRafId);

    if (freezeBlob) {
      this._freezeImage = await blobToImage(freezeBlob);
      const start = Date.now();
      while (Date.now() - start < 600) {
        this._recordCtx.drawImage(this._freezeImage, 0, 0, this._recordCanvas.width, this._recordCanvas.height);
        await wait(30);
      }
    }

    const rawBlob = await new Promise(resolve => {
      this._recorder.onstop = () => {
        resolve(new Blob(this._recordedChunks, { type: this._recorder.mimeType }));
      };
      this._recorder.stop();
    });

    return remuxToMp4(rawBlob);
  },

  async disconnect() {
    this._recording = false;
    if (this._recordRafId) cancelAnimationFrame(this._recordRafId);
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
  }
};
