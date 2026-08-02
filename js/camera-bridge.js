/*
 * CAMERA BRIDGE
 * ----------------------------------------------------
 * This file is the ONLY place that should know whether we're
 * talking to a REAL DSLR bridge or a MOCK bridge.
 *
 * Real bridge: a local Node.js camera agent (camera-agent/server.js)
 * running on localhost:3000, controlling the DSLR via gphoto2.
 * Live preview is an MJPEG stream the <img> tag reads natively.
 * Still capture is a POST that returns a JPEG blob.
 * Video recording is done entirely browser-side by capturing frames
 * from the MJPEG <img> onto a canvas and running MediaRecorder —
 * the agent's video endpoints are no-ops.
 *
 * Mock bridge: uses your laptop/kiosk webcam via getUserMedia
 * purely so you can develop and test the UI/flow without a
 * DSLR plugged in. It is CLEARLY LABELED as mock everywhere
 * in the UI (see the "mockTag" element in index.html).
 */

const CAMERA_CONFIG = {
  bridgeUrl: "https://localhost:3000",
  connectionType: "http", // "http" | "websocket"
  livePreviewEndpoint: "/camera/live-preview",
  captureEndpoint: "/camera/capture",
  // NOTE: zoom is handled entirely client-side now (digital zoom only —
  // see camera-controller.js setZoom/_cropToZoom), so there is no
  // zoom endpoint here anymore.
  startVideoEndpoint: "/camera/video/start",
  stopVideoEndpoint: "/camera/video/stop",
  statusEndpoint: "/camera/status",
  // Single-shot JPEG endpoint (not multipart) polled via fetch() during
  // video recording only — see startVideoRecording() below for why this
  // exists separately from the MJPEG live-preview stream.
  frameEndpoint: "/camera/frame"
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

/*
 * remuxToMp4 — re-encodes a raw MediaRecorder blob into a properly
 * finalized, social-media-compatible MP4.
 *
 * WHY: MediaRecorder produces fragmented WebM or fragmented MP4 — both
 * lack the required "moov" atom at the start of the file (fast-start /
 * web-optimized). Instagram, TikTok, and most social apps reject these
 * files with "Can't access media" or "Unsupported format". The fix is
 * to decode every frame from the raw blob and re-encode them into a
 * proper MP4 container using the browser's native WebCodecs API + the
 * mp4-muxer library (loaded in index.html — tiny, zero server deps).
 *
 * Falls back to returning the original blob if WebCodecs isn't available
 * (older browsers) — the video still plays in the browser gallery, just
 * may not be uploadable to every social platform.
 */
async function remuxToMp4(inputBlob) {
  // WebCodecs + mp4-muxer are required. Fall back gracefully.
  if (typeof VideoDecoder === "undefined" || typeof Muxer === "undefined") {
    console.warn("[remux] WebCodecs or mp4-muxer not available — returning original blob");
    return inputBlob;
  }

  const url = URL.createObjectURL(inputBlob);
  try {
    // Decode every frame from the source blob using a hidden <video> +
    // ImageCapture approach, then re-encode through VideoEncoder.
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
    });

    const width  = Math.floor(video.videoWidth  / 2) * 2; // must be even
    const height = Math.floor(video.videoHeight / 2) * 2;
    const fps    = 30;

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: {
        codec: "avc",          // H.264 — universally supported
        width,
        height,
        frameRate: fps
      },
      fastStart: "in-memory"  // puts moov at start — required for social apps
    });

    const encoder = new VideoEncoder({
      output: (chunk, meta) => { muxer.addVideoChunk(chunk, meta); },
      error:  (e) => console.error("[remux] VideoEncoder error:", e)
    });

    encoder.configure({
      codec:                  "avc1.42001f", // H.264 Baseline Profile, Level 3.1
      width,
      height,
      bitrate:                2_500_000,     // 2.5 Mbps — good quality for social
      framerate:              fps,
      latencyMode:            "quality",
      hardwareAcceleration:   "prefer-hardware"
    });

    // Seek through the video frame by frame via canvas capture.
    const canvas = document.createElement("canvas");
    canvas.width  = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    const totalFrames = Math.round(video.duration * fps);
    for (let i = 0; i < totalFrames; i++) {
      const timestamp = i / fps;
      video.currentTime = timestamp;
      await new Promise((resolve) => { video.onseeked = resolve; });

      ctx.drawImage(video, 0, 0, width, height);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(timestamp * 1_000_000) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 }); // keyframe every 2s
      frame.close();

      // Yield to the browser every 10 frames to avoid blocking the UI
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    await encoder.flush();
    muxer.finalize();

    const { buffer } = muxer.target;
    return new Blob([buffer], { type: "video/mp4" });
  } catch (e) {
    console.error("[remux] Failed — returning original blob:", e);
    return inputBlob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * REAL BRIDGE — talks to the local camera agent (localhost:3000 / gphoto2)
 *
 * Video recording mirrors the mock bridge exactly:
 *   - An off-screen canvas is fed frames from the MJPEG <img> element via RAF
 *   - MediaRecorder records the canvas stream
 *   - stopVideoRecording() optionally holds the last frame on the captured
 *     still photo for 600ms before stopping, so the cut to the between-shots
 *     preview feels seamless
 *   - The raw MediaRecorder blob is remuxed to a proper MP4 via WebCodecs
 *
 * camera-controller.js must call:
 *   realCameraBridge._imgEl = imgEl   (in attachPreview, real mode)
 * so this bridge knows which <img> to read frames from.
 * ───────────────────────────────────────────────────────────────────────────*/
const realCameraBridge = {
  // Set by cameraController.attachPreview() when mode === "real".
  // Used only for the always-visible guest-facing MJPEG preview display —
  // video recording polls GET /camera/frame instead (see
  // startVideoRecording() for why), so this is no longer read during
  // recording.
  _imgEl: null,

  // Video recording state — mirrors mock bridge fields 1:1, except
  // _recordPollId (a setTimeout id for frame polling) replaces the RAF id
  // the mock bridge uses, since recording now pulls frames via fetch()
  // rather than reading from a live <video>/<img> element each animation
  // frame.
  _recorder:        null,
  _recordedChunks:  [],
  _recordCanvas:    null,
  _recordCtx:       null,
  _recordPollId:    null,
  _freezeImage:     null,
  _recording:       false,
  _recordZoom:      1.0,
  _recordMirror:    false,
  // Store the MIME type chosen at start time so stopVideoRecording can use
  // it reliably — Android strips recorder.mimeType to "" after stop.
  _chosenMimeType:  "",

  async checkAvailable() {
    try {
      const res = await fetch(`${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.statusEndpoint}`, {
        method: "GET",
        signal: AbortSignal.timeout(1500)
      });
      if (!res.ok) return null;
      return await res.json(); // { connected: bool, model: string, connection: string }
    } catch (e) {
      return null;
    }
  },

  async connect() {
    const res = await fetch(`${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.statusEndpoint}`);
    return res.json();
  },

  getLivePreviewUrl() {
    // MJPEG stream — the <img> tag reads this natively.
    //
    // CACHE-BUSTING FIX (canvas origin-clean bug): Chrome's image cache is
    // keyed on the exact URL string. If this URL was EVER fetched by this
    // browser profile without a clean CORS pass (e.g. during earlier
    // debugging, before crossOrigin/CORS headers were both in place),
    // Chrome can memoize that fetch — including its tainted status — and
    // silently reuse it on later loads, even once crossOrigin="anonymous"
    // and the server's Access-Control-Allow-Origin header are both correct.
    // Setting crossOrigin correctly going forward does NOT retroactively
    // clear an already-poisoned cache entry for that literal URL string.
    //
    // Appending a unique query param forces Chrome to treat every attach
    // as a brand-new resource, guaranteeing a fresh CORS-checked fetch.
    // server.js already strips the query string before routing
    // (`req.url.split("?")[0]`), so this has no server-side effect.
    return `${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.livePreviewEndpoint}?t=${Date.now()}`;
  },

  async capturePhoto() {
    const res = await fetch(`${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.captureEndpoint}`, {
      method: "POST"
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `Capture failed (HTTP ${res.status})`);
    }
    return res.blob();
  },

  /*
   * startVideoRecording(zoom, mirror)
   *
   * Sets up an off-screen canvas fed by individually polled JPEG frames
   * (NOT the MJPEG live-preview <img>), then starts a MediaRecorder on the
   * canvas's capture stream.
   *
   * WHY POLLING INSTEAD OF READING FROM THE <img>: Chrome does not reliably
   * apply crossOrigin/CORS tainting rules to multipart/x-mixed-replace
   * (MJPEG) <img> streams — drawImage() from an MJPEG <img> stays
   * permanently tainted ("Canvas is not origin-clean" on captureStream())
   * no matter what crossOrigin attribute or Access-Control-Allow-Origin
   * headers are set. This is a limitation of MJPEG-in-<img>, not a config
   * mistake. fetch() of a single, ordinary JPEG response is a normal,
   * well-defined CORS request with none of that ambiguity, so we poll
   * GET /camera/frame (a single-shot endpoint, separate from
   * /camera/live-preview) at roughly the server's own broadcast rate and
   * draw each decoded frame onto the canvas instead.
   *
   * The guest-facing live preview <img> is completely unaffected — it
   * keeps using the MJPEG stream exactly as before. Only this recording
   * path changed.
   *
   * Black-screen/lag fix (unchanged from before): MediaRecorder.start() is
   * deferred until the first real frame has been drawn, eliminating the
   * race on Windows where start() fires before any frame is ready.
   */
  async startVideoRecording(zoom = 1.0, mirror = false) {
    // Notify the agent (no-op on its side, but keeps the API symmetric)
    await fetch(`${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.startVideoEndpoint}`, {
      method: "POST"
    }).catch(() => {}); // don't let a network hiccup abort recording setup

    // Default canvas size until the first polled frame reports real
    // dimensions; the canvas is resized once we know them.
    let srcW = 1280;
    let srcH = 720;

    const canvas = document.createElement("canvas");
    canvas.width  = srcW;
    canvas.height = srcH;
    this._recordCanvas   = canvas;
    this._recordCtx      = canvas.getContext("2d");
    this._freezeImage    = null;
    this._recording      = true;
    this._recordZoom     = Math.max(1.0, zoom);
    this._recordMirror   = !!mirror;
    this._recordedChunks = [];
    this._recorder       = null; // will be set after first frame
    this._recordPollId   = null;

    const mimeType = pickSupportedVideoMimeType();
    this._chosenMimeType = mimeType;

    let recorderStarted = false;
    let sizedForFirstFrame = false;
    const frameUrl = `${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.frameEndpoint}`;
    const POLL_MS = 66; // ~15fps — matches the agent's own MAX_BROADCAST_FPS

    const pollFrame = async () => {
      if (!this._recording) return;

      try {
        const res = await fetch(`${frameUrl}?t=${Date.now()}`, {
          method: "GET",
          mode: "cors",
          cache: "no-store"
        });
        if (res.ok) {
          const blob   = await res.blob();
          const bitmap = await createImageBitmap(blob);

          if (!sizedForFirstFrame) {
            sizedForFirstFrame = true;
            srcW = bitmap.width  || srcW;
            srcH = bitmap.height || srcH;
            canvas.width  = srcW;
            canvas.height = srcH;
          }

          const ctx    = this._recordCtx;
          const source = this._freezeImage || bitmap;
          this._drawZoomedMirrored(ctx, source, srcW, srcH, this._recordZoom, this._recordMirror);
          bitmap.close();

          // ── Black-screen/lag fix ──────────────────────────────────────
          // Start MediaRecorder only after the first real frame is painted.
          if (!recorderStarted) {
            recorderStarted = true;
            this._recorder = new MediaRecorder(
              canvas.captureStream(30),
              mimeType ? { mimeType } : undefined
            );
            this._recorder.ondataavailable = (e) => {
              if (e.data.size > 0) this._recordedChunks.push(e.data);
            };
            this._recorder.start();
          }
        }
      } catch (e) {
        console.warn("[real-bridge] Frame poll failed:", e);
      }

      if (this._recording) {
        this._recordPollId = setTimeout(pollFrame, POLL_MS);
      }
    };

    pollFrame();
  },

  /*
   * _drawZoomedMirrored — identical logic to mock bridge.
   *
   * For <img> elements (MJPEG source), naturalWidth/naturalHeight give
   * the source dimensions. The same crop-then-scale math as _cropToZoom()
   * applies so the recorded video matches what the guest saw on screen.
   */
  _drawZoomedMirrored(ctx, source, outW, outH, zoom, mirror) {
    // Pre-rendered freeze frames have zoom+mirror already baked in —
    // draw them 1:1 so they match the preceding live frames exactly.
    if (source._isPreRendered) {
      ctx.drawImage(source, 0, 0, outW, outH);
      return;
    }

    // For <img>: naturalWidth/naturalHeight. For <video>: videoWidth/videoHeight.
    // For ImageBitmap (polled JPEG frames): width/height.
    const srcW = source.naturalWidth || source.videoWidth || source.width  || outW;
    const srcH = source.naturalHeight || source.videoHeight || source.height || outH;

    // Centered crop region — same math as cameraController._cropToZoom()
    const cropW = srcW / zoom;
    const cropH = srcH / zoom;
    const sx    = (srcW - cropW) / 2;
    const sy    = (srcH - cropH) / 2;

    ctx.save();
    if (mirror) {
      ctx.translate(outW, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, sx, sy, cropW, cropH, 0, 0, outW, outH);
    ctx.restore();
  },

  /*
   * stopVideoRecording(freezeBlob)
   *
   * Mirrors mock bridge exactly:
   *   1. If a freeze blob is provided, pre-render it to a canvas and hold
   *      that frame for 600ms so the clip ends on the captured still.
   *   2. Stop the MediaRecorder and collect chunks into a blob.
   *   3. Remux to a proper MP4 via WebCodecs + mp4-muxer.
   *
   * Android MIME type fix: use this._chosenMimeType (stored at start time)
   * rather than recorder.mimeType, which Android strips to "" after stop().
   */
  async stopVideoRecording(freezeBlob) {
    // Notify the agent (no-op, kept for API symmetry)
    await fetch(`${CAMERA_CONFIG.bridgeUrl}${CAMERA_CONFIG.stopVideoEndpoint}`, {
      method: "POST"
    }).catch(() => {});

    if (!this._recorder) {
      // Recording never started (e.g. agent was unavailable at start time)
      this._recording = false;
      return null;
    }

    if (freezeBlob) {
      try {
        // freezeBlob has already had zoom + mirror applied by capturePhoto().
        // Pre-render it onto a canvas the same size as the record canvas so
        // _drawZoomedMirrored draws it 1:1 without re-applying transforms.
        const rawImg      = await blobToImage(freezeBlob);
        const w           = this._recordCanvas.width;
        const h           = this._recordCanvas.height;
        const preRendered = document.createElement("canvas");
        preRendered.width  = w;
        preRendered.height = h;
        preRendered.getContext("2d").drawImage(rawImg, 0, 0, w, h);
        // Tag it so _drawZoomedMirrored skips zoom+mirror for this source
        preRendered._isPreRendered = true;
        this._freezeImage = preRendered;
        await wait(600);
      } catch (e) {
        console.warn("[real-bridge] Could not blend captured photo into video ending:", e);
      }
    }

    const chosenMimeType = this._chosenMimeType; // capture before stop clears state

    const rawBlob = await new Promise((resolve) => {
      this._recorder.onstop = () => {
        this._recording = false;
        if (this._recordPollId) clearTimeout(this._recordPollId);
        // Android fix: use the MIME type we chose at start time, not
        // recorder.mimeType which Android may have stripped to "".
        const type = chosenMimeType || this._recorder.mimeType || "video/webm";
        resolve(new Blob(this._recordedChunks, { type }));
      };
      this._recorder.stop();
    });

    return remuxToMp4(rawBlob);
  },

  async disconnect() {
    this._recording = false;
    if (this._recordPollId) clearTimeout(this._recordPollId);
    // Nothing else to release — the MJPEG stream is managed by the <img> src
  }
};

/* ─────────────────────────────────────────────────────────────────────────────
 * MOCK BRIDGE — clearly a placeholder, webcam-based, dev only
 * ───────────────────────────────────────────────────────────────────────────*/
const mockCameraBridge = {
  _stream:          null,
  _videoEl:         null,
  _recorder:        null,
  _recordedChunks:  [],
  _recordCanvas:    null,
  _recordCtx:       null,
  _recordRafId:     null,
  _freezeImage:     null,
  _recording:       false,
  // Store the MIME type chosen at start time — Android strips recorder.mimeType
  // to "" after stop(), so we can't rely on it in stopVideoRecording().
  _chosenMimeType:  "",

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
    const canvas  = document.createElement("canvas");
    canvas.width  = videoEl.videoWidth  || 1280;
    canvas.height = videoEl.videoHeight || 720;
    const ctx     = canvas.getContext("2d");
    if (mirror) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  },

  /*
   * startVideoRecording(zoom, mirror)
   *
   * Records the live preview onto an off-screen canvas (instead of the raw
   * camera stream directly) so stopVideoRecording() below can swap in the
   * actual captured still photo for the last moment of the clip.
   *
   * zoom   — digital zoom level (1.0 = no crop, 2.0 = 2× crop, etc.)
   * mirror — whether to horizontally flip the frame, matching the preview
   *
   * Black-screen/lag fix: MediaRecorder.start() is deferred until the RAF
   * loop has successfully drawn at least one frame from the video element.
   * This eliminates the race on Windows PC where start() fires before the
   * first frame is ready.
   */
  async startVideoRecording(zoom = 1.0, mirror = false) {
    if (!this._stream) return;
    const videoEl = this._videoEl;

    const srcW = videoEl.videoWidth  || 1280;
    const srcH = videoEl.videoHeight || 720;

    const canvas = document.createElement("canvas");
    canvas.width  = srcW;
    canvas.height = srcH;
    this._recordCanvas   = canvas;
    this._recordCtx      = canvas.getContext("2d");
    this._freezeImage    = null;
    this._recording      = true;
    this._recordZoom     = Math.max(1.0, zoom);
    this._recordMirror   = !!mirror;
    this._recordedChunks = [];
    this._recorder       = null; // set after first frame

    const mimeType = pickSupportedVideoMimeType();
    this._chosenMimeType = mimeType;

    let recorderStarted = false;

    const drawFrame = () => {
      if (!this._recording) return;

      const ctx    = this._recordCtx;
      const source = this._freezeImage || (videoEl.readyState >= 2 ? videoEl : null);

      if (source) {
        this._drawZoomedMirrored(ctx, source, srcW, srcH, this._recordZoom, this._recordMirror);

        // ── Black-screen/lag fix ──────────────────────────────────────────
        // Start MediaRecorder only after the first real frame is drawn so we
        // never capture a blank canvas at the beginning of the clip.
        if (!recorderStarted) {
          recorderStarted = true;
          this._recorder = new MediaRecorder(
            canvas.captureStream(30),
            mimeType ? { mimeType } : undefined
          );
          this._recorder.ondataavailable = (e) => {
            if (e.data.size > 0) this._recordedChunks.push(e.data);
          };
          this._recorder.start();
        }
      }

      this._recordRafId = requestAnimationFrame(drawFrame);
    };

    drawFrame();
  },

  /*
   * _drawZoomedMirrored — draws `source` into `ctx` with the same
   * crop-then-scale logic that _cropToZoom() uses for still photos,
   * plus an optional horizontal mirror baked into the canvas transform.
   */
  _drawZoomedMirrored(ctx, source, outW, outH, zoom, mirror) {
    // Pre-rendered freeze frames have zoom+mirror already baked in.
    if (source._isPreRendered) {
      ctx.drawImage(source, 0, 0, outW, outH);
      return;
    }

    const srcW = source.videoWidth  || source.naturalWidth  || outW;
    const srcH = source.videoHeight || source.naturalHeight || outH;

    const cropW = srcW / zoom;
    const cropH = srcH / zoom;
    const sx    = (srcW - cropW) / 2;
    const sy    = (srcH - cropH) / 2;

    ctx.save();
    if (mirror) {
      ctx.translate(outW, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, sx, sy, cropW, cropH, 0, 0, outW, outH);
    ctx.restore();
  },

  /*
   * stopVideoRecording(freezeBlob)
   *
   * freezeBlob (optional) — the still photo just captured. The last ~600ms
   * of the clip holds on that frame so the handoff to the between-shots
   * preview (which shows that same photo) feels seamless.
   */
  async stopVideoRecording(freezeBlob) {
    if (!this._recorder) return null;

    if (freezeBlob) {
      try {
        const rawImg      = await blobToImage(freezeBlob);
        const w           = this._recordCanvas.width;
        const h           = this._recordCanvas.height;
        const preRendered = document.createElement("canvas");
        preRendered.width  = w;
        preRendered.height = h;
        preRendered.getContext("2d").drawImage(rawImg, 0, 0, w, h);
        preRendered._isPreRendered = true;
        this._freezeImage = preRendered;
        await wait(600);
      } catch (e) {
        console.warn("[mock-bridge] Could not blend captured photo into video ending:", e);
      }
    }

    const chosenMimeType = this._chosenMimeType; // capture before stop clears state

    const rawBlob = await new Promise((resolve) => {
      this._recorder.onstop = () => {
        this._recording = false;
        if (this._recordRafId) cancelAnimationFrame(this._recordRafId);
        // Android fix: use the MIME type chosen at start time, not
        // recorder.mimeType which Android may strip to "".
        const type = chosenMimeType || this._recorder.mimeType || "video/webm";
        resolve(new Blob(this._recordedChunks, { type }));
      };
      this._recorder.stop();
    });

    return remuxToMp4(rawBlob);
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
