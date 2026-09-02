/*
 * APP.JS — global session state + page navigation + wiring for
 * Page 1 (setup) and Page 2 (frame/quantity).
 *
 * Kiosk lives at /kiosk/ — all asset paths are relative to that folder.
 */

const sessionState = {
  id: Date.now().toString(36),
  frameType: null,   // "2x6" | "4x6"
  quantity: 1,
  shots: [],
  selectedShots: [],
  design: null,
  galleryUrl: null,
  galleryUrlPromise: null,
  uploadPromise: null,

  // ── QR Ticket fields (populated after successful QR scan) ──
  ticketId:       null,   // e.g. "T-LQ0ABC-XY12"
  ticketNumber:   null,   // queue number (integer)
  ticketLine:     null,   // queue line name
  ticketCopies:   null,   // number of copies from ticket (overrides qty selector)
  ticketFrame:    null,   // frame_addon quantity
  ticketKeychain: null,   // keychain_addon quantity

  // ── Flipbook product fields ──
  _isFlipbook:            false,
  flipbookVideos:         [],   // { id, video, videoUrl, selected } × 3
  selectedFlipbookVideo:  null, // the one chosen clip
  flipbookFrames:         []    // 19 extracted frame Blobs, generated after selection
};

/* ---------------- Navigation ---------------- */
// Tracks whether the camera-check page has been visited at least once.
// boot.js calls goToPage("ticket") after boot succeeds — on the very first
// call we intercept it and route to camera-check so staff can verify the
// live preview before the guest flow starts.  Subsequent resets skip it.
let _cameraCheckShown = false;

function goToPage(pageName) {
  // Queue system is active: "home" routes to the QR ticket / queue page.
  if (pageName === "home") pageName = "ticket";

  // One-shot camera check: intercept the first post-boot navigation to
  // "ticket" so staff can verify the live preview before guests start.
  if (pageName === "ticket" && !_cameraCheckShown) {
    const bootPage = document.getElementById("page-boot");
    if (bootPage && bootPage.classList.contains("active")) {
      _cameraCheckShown = true;
      pageName = "camera-check";
    }
  }

  // Voiceover: Queue System starts. Fires each time the kiosk genuinely
  // reaches the ticket/home page for a new guest (not on the one-shot
  // camera-check diversion above). Placed before the QUEUE BYPASS below so
  // it still fires even while that bypass is active.
  if (pageName === "ticket" && typeof audioManager !== "undefined") {
    audioManager.playWelcomeIntro();
  }

  // ── QUEUE BYPASS (temporary — re-enable by removing this block) ─────────
  // The QR ticket / queue system is disabled for testing: any remaining
  // navigation to "ticket" skips straight to Template Selection instead.
  // (The one-shot camera-check above still runs first on initial boot.)
  // To re-enable the queue, delete the line below.
  if (pageName === "ticket") pageName = "template";
  // ── END QUEUE BYPASS ──────────────────────────────────────────────────────

  // Old page-frame and page-setup are replaced by page-template.
  if (pageName === "frame" || pageName === "setup") pageName = "template";
  // Old page-design is removed from flow; selection goes directly to printing.
  // (btnNextFromDesign on the hidden design page still fires, which is fine —
  //  but any code that calls goToPage("design") is redirected here.)
  // NOTE: we do NOT redirect "design" → "printing" here because designModule
  // auto-selects a design + btnNextFromDesign fires the printing transition.
  // Instead, selection.js now routes directly to printing (see below).

  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  const target = document.querySelector(`.page[data-page="${pageName}"]`);
  if (target) target.classList.add("active");

  // Keep the kiosk timer data attribute in sync for CSS targeting
  const timer = document.getElementById("kioskTimer");
  if (timer) timer.dataset.activePage = pageName;
  const progress = document.getElementById("kiosk-progress");
  if (progress) progress.dataset.activePage = pageName;

  // When arriving at the camera-check page, attach the live preview
  if (pageName === "camera-check") {
    const ccVideo = document.getElementById("cameraCheckVideo");
    const ccImg   = document.getElementById("cameraCheckImg");
    if (ccVideo && ccImg && cameraController.mode) {
      try {
        cameraController.attachPreview(ccVideo, ccImg);
      } catch (e) {
        console.warn("[camera-check] attachPreview failed:", e.message || e);
      }
    }
    // Populate the camera model / connection labels
    const modelEl = document.getElementById("cameraCheckModel");
    const connEl  = document.getElementById("cameraCheckConn");
    if (modelEl) modelEl.textContent = cameraController.status.model || "—";
    if (connEl)  connEl.textContent  = cameraController.status.connection || "—";
  }

  // When arriving at the ticket page, refocus the hidden QR input
  if (pageName === "ticket" && typeof kioskQrScanner !== "undefined") {
    kioskQrScanner.focus();
  }

  // When arriving at the template page, initialise the template carousel
  if (pageName === "template" && typeof templateModule !== "undefined") {
    // Small delay so the page transition completes before layout is measured
    setTimeout(() => templateModule.init(), 80);
  }

  // ── Audio: update BGM zone whenever the page changes ──────────────────
  if (typeof audioManager !== "undefined") {
    audioManager.onPageChange(pageName);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * CAMERA CONTROLS — wired to the controls now living on page-shooting
 * (btnZoomWide, btnZoomNormal, btnMirrorToggle are defined in shooting HTML)
 * ────────────────────────────────────────────────────────────────────────── */

let currentZoom = 1.0;
let mirrorEnabled = false;

/* Stubs kept so boot.js / any other script that calls renderCameraStatus
   doesn't throw. The camera status is no longer displayed visually. */
const setupEls = {
  video:         document.getElementById("livePreviewVideo"),
  img:           document.getElementById("livePreviewImg"),
  placeholder:   document.getElementById("previewPlaceholder"),
  zoomLevelLabel:document.getElementById("zoomLevelLabel"),
  zoomTypeLabel: document.getElementById("zoomTypeLabel"),
  nextBtn:       document.getElementById("btnNextFromSetup")
};

function renderCameraStatus(status) {
  // Camera status no longer displayed — function kept for boot.js compatibility.
  // Enable the hidden setup next btn so boot.js's camera-connected callback works.
  if (setupEls.nextBtn) setupEls.nextBtn.disabled = !(status && status.connected);
}

async function setFixedZoom(level) {
  await updateZoom(level);
  ["btnZoomWide", "btnFlipbookZoomWide"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("active", level === 1.0);
  });
  ["btnZoomNormal", "btnFlipbookZoomNormal"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("active", level === 1.5);
  });
}

async function updateZoom(level) {
  level = Math.max(1.0, Math.min(5.0, level));
  try {
    const result = await cameraController.setZoom(level);
    currentZoom = result.level;
    const ll = document.getElementById("zoomLevelLabel");
    const lt = document.getElementById("zoomTypeLabel");
    if (ll) ll.textContent = `${currentZoom.toFixed(1)}x`;
    if (lt) lt.textContent = `(${result.type})`;
  } catch (e) {
    console.warn("Zoom adjustment failed:", e.message);
  }
}

/* Wire zoom + mirror buttons — they live on page-shooting in the new layout */
document.addEventListener("DOMContentLoaded", () => {
  const btnZoomWide    = document.getElementById("btnZoomWide");
  const btnZoomNormal  = document.getElementById("btnZoomNormal");
  const btnMirrorToggle = document.getElementById("btnMirrorToggle");

  if (btnZoomWide)    btnZoomWide.addEventListener("click",    () => setFixedZoom(1.0));
  if (btnZoomNormal)  btnZoomNormal.addEventListener("click",  () => setFixedZoom(1.5));
  if (btnMirrorToggle) {
    btnMirrorToggle.addEventListener("click", () => {
      mirrorEnabled = !mirrorEnabled;
      btnMirrorToggle.classList.toggle("active", mirrorEnabled);
      cameraController.setMirror(mirrorEnabled);
    });
  }

  // Same zoom/mirror controls, mirrored onto the flipbook video-taking page
  const btnFlipbookZoomWide     = document.getElementById("btnFlipbookZoomWide");
  const btnFlipbookZoomNormal   = document.getElementById("btnFlipbookZoomNormal");
  const btnFlipbookMirrorToggle = document.getElementById("btnFlipbookMirrorToggle");

  if (btnFlipbookZoomWide)   btnFlipbookZoomWide.addEventListener("click",   () => setFixedZoom(1.0));
  if (btnFlipbookZoomNormal) btnFlipbookZoomNormal.addEventListener("click", () => setFixedZoom(1.5));
  if (btnFlipbookMirrorToggle) {
    btnFlipbookMirrorToggle.addEventListener("click", () => {
      mirrorEnabled = !mirrorEnabled;
      btnFlipbookMirrorToggle.classList.toggle("active", mirrorEnabled);
      cameraController.setMirror(mirrorEnabled);
    });
  }

  // Camera Check page: "Camera Working" button → advance to ticket page
  const btnCameraWorking = document.getElementById("btnCameraWorking");
  if (btnCameraWorking) {
    btnCameraWorking.addEventListener("click", () => {
      goToPage("ticket");
    });
  }

  // Wire the camera filter toggle — button lives on page-shooting
  // assetSync may not be initialised yet at DOMContentLoaded; init() is
  // safe to call early because it guards against missing assetSync data.
  if (typeof cameraFilterManager !== "undefined") {
    cameraFilterManager.init();
  }
});

/* Kept for any legacy callers */
function proceedFromFrame() {}

/* Hidden stubs — old frame page compatibility */
const FRAME_NAMES = {
  "2x6":      "Long Frame",
  "4x6":      "Wide Frame",
  "long-duo": "Long Duo",
  "long-mini":"Long Mini",
  "film-duo": "Film Duo",
  "wide-mini":"Wide Mini"
};
function calcPrice(qty) { return 50 + Math.max(0, qty - 1) * 25; }
function selectFrame(type) { sessionState.frameType = type; }
function setQuantity(qty) { sessionState.quantity = Math.max(1, Math.min(20, qty)); }
function updateFramePricing() {}

/* btnBackFromSetup / btnBackFromFrame stubs */
(function() {
  const bbs = document.getElementById("btnBackFromSetup");
  const bbf = document.getElementById("btnBackFromFrame");
  if (bbs) bbs.addEventListener("click", () => { kioskTimer.hide(); goToPage("template"); });
  if (bbf) bbf.addEventListener("click", () => { kioskTimer.hide(); goToPage("ticket"); });
})();

/* btnNextFromSetup stub — shouldn't be clicked but guard it */
(function() {
  const btn = document.getElementById("btnNextFromSetup");
  if (btn) btn.addEventListener("click", () => _startShooting());
})();

/* ──────────────────────────────────────────────────────────────────────────
 * CAMERA FILTER MANAGER
 *
 * Loads the active XMP/LUT filter from the Admin configuration
 * (via assetSync.getFilters()) and applies it to:
 *   1. Live view (#shootingVideo / #shootingImg) — via a WebGL canvas
 *      overlay that applies the CUBE LUT in real-time every animation frame.
 *   2. Photo taking — applyLutToCanvas(srcCtx, w, h) reads back pixel data
 *      and runs the CUBE LUT in software before the final composite.
 *   3. Video recording — same applyLutToCanvas path, called per-frame in
 *      the recording RAF loop.
 *
 * CUBE LUT (assets/filter/photobooth.cube):
 *   Standard Adobe/DaVinci 3D LUT (.cube) format. Loaded once on init(),
 *   parsed into a Uint8Array lookup table, then applied via:
 *     • WebGL (live view) — renders source video texture through the LUT
 *       using a GLSL fragment shader with trilinear interpolation.
 *     • Software (capture/record) — trilinear interpolation on ImageData
 *       for pixel-accurate output baked into the final strip canvas.
 *
 * XMP fallback (assets/filter/Photobooth.xmp):
 *   If assetSync provides no filter AND the .cube file cannot be loaded,
 *   the XMP is converted to a CSS filter string as a best-effort
 *   approximation (same as before).
 *
 * Only one filter can be active at a time. The toggle button on Page 3
 * bypasses both the WebGL overlay and the canvas LUT simultaneously.
 *
 * If assetSync is not yet initialised or no filters are configured, the
 * manager silently stays in the "no filter" state without throwing.
 * ────────────────────────────────────────────────────────────────────────── */
const cameraFilterManager = (() => {
  // Current state
  let _activeFilter = null;   // filter object from assetSync.getFilters()
  let _filterOn     = false;  // whether the filter is currently applied
  let _cssFilter    = "";     // resolved CSS filter string (XMP path)

  // CUBE LUT state
  let _lutData      = null;   // Float32Array [r,g,b] triples, size^3 entries
  let _lutSize      = 0;      // LUT dimension (e.g. 32 → 32^3 entries)
  let _lutLoaded    = false;  // true once the .cube file parsed successfully

  // WebGL live-view overlay state
  let _glCanvas     = null;   // offscreen WebGL canvas overlaid on the video/img
  let _gl           = null;   // WebGL context
  let _glProgram    = null;   // compiled GLSL program
  let _glTexVideo   = null;   // texture for the camera frame (reused for img too)
  let _glTexLut     = null;   // 3D LUT texture
  let _glRafId      = null;   // requestAnimationFrame handle
  let _glInitOk     = false;  // true if WebGL init succeeded
  let _glSource     = null;   // current source element (<video> or <img>) for the GL loop

  // Offscreen WebGL context — used exclusively by applyLutToCanvasGL() for
  // baking the LUT into recording frames and captured photos GPU-side.
  // Kept separate from the live-view _gl so a resize of _glCanvas mid-RAF
  // never races with a readPixels call during capture.
  let _offGl        = null;   // WebGL context on the offscreen canvas
  let _offCanvas    = null;   // the hidden <canvas> that owns _offGl
  let _offProgram   = null;   // same shader program, compiled once
  let _offTexSrc    = null;   // texture unit 0: the 2D recording/capture canvas
  let _offTexLut    = null;   // texture unit 1: the packed LUT atlas
  let _offFb        = null;   // framebuffer for rendering into _offTexDst
  let _offTexDst    = null;   // RGBA texture attached to _offFb (render target)
  let _offInitOk    = false;  // true once offscreen context is ready

  // DOM refs — resolved lazily on first use (module loads before DOM is ready)
  function _els() {
    return {
      video:       document.getElementById("shootingVideo"),
      img:         document.getElementById("shootingImg"),
      chip:        document.getElementById("filterStatusChip"),
      chipName:    document.getElementById("filterStatusName"),
      toggleBtn:   document.getElementById("btnFilterToggle"),
      group:       document.getElementById("filterControlGroup")
    };
  }

  /* ── CUBE LUT parser ─────────────────────────────────────────────────────
   * Parses an Adobe-format .cube file text into a flat Float32Array.
   * Entries are stored in R-fastest order (same as .cube spec):
   *   index = r + g*size + b*size*size  (r,g,b each in [0, size-1])
   * Each entry is 3 floats (R,G,B) in [0,1].
   */
  function _parseCube(text) {
    const lines  = text.split(/\r?\n/);
    let size     = 0;
    const values = [];

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("LUT_3D_SIZE")) {
        size = parseInt(line.split(/\s+/)[1], 10);
        continue;
      }
      // Skip DOMAIN_MIN / DOMAIN_MAX / TITLE lines
      if (/^[A-Z_]/.test(line)) continue;

      const parts = line.split(/\s+/);
      if (parts.length >= 3) {
        values.push(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
      }
    }

    if (!size || values.length < size * size * size * 3) {
      throw new Error(`[cameraFilterManager] Invalid .cube: size=${size}, entries=${values.length / 3}`);
    }

    return { size, data: new Float32Array(values) };
  }

  /* ── Software trilinear LUT lookup ──────────────────────────────────────
   * Given normalised r,g,b in [0,1], returns [R,G,B] after LUT mapping.
   * Uses trilinear interpolation for smooth results.
   */
  function _lutLookup(r, g, b) {
    const sz  = _lutSize;
    const szm = sz - 1;

    const rf = r * szm,  ri = Math.min(Math.floor(rf), szm - 1),  rt = rf - ri;
    const gf = g * szm,  gi = Math.min(Math.floor(gf), szm - 1),  gt = gf - gi;
    const bf = b * szm,  bi = Math.min(Math.floor(bf), szm - 1),  bt = bf - bi;

    function idx(ri, gi, bi) { return (ri + gi * sz + bi * sz * sz) * 3; }

    // Trilinear interpolation across 8 corners
    const i000 = idx(ri,   gi,   bi  );
    const i100 = idx(ri+1, gi,   bi  );
    const i010 = idx(ri,   gi+1, bi  );
    const i110 = idx(ri+1, gi+1, bi  );
    const i001 = idx(ri,   gi,   bi+1);
    const i101 = idx(ri+1, gi,   bi+1);
    const i011 = idx(ri,   gi+1, bi+1);
    const i111 = idx(ri+1, gi+1, bi+1);

    const d = _lutData;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const v000 = d[i000+c], v100 = d[i100+c], v010 = d[i010+c], v110 = d[i110+c];
      const v001 = d[i001+c], v101 = d[i101+c], v011 = d[i011+c], v111 = d[i111+c];
      // Interpolate along R, then G, then B
      const c00 = v000 + rt * (v100 - v000);
      const c10 = v010 + rt * (v110 - v010);
      const c01 = v001 + rt * (v101 - v001);
      const c11 = v011 + rt * (v111 - v011);
      const c0  = c00  + gt * (c10  - c00 );
      const c1  = c01  + gt * (c11  - c01 );
      out[c]    = c0   + bt * (c1   - c0  );
    }
    return out;
  }

  /* ── WebGL live-view overlay ─────────────────────────────────────────────
   *
   * A <canvas> is inserted as a sibling of #shootingVideo, absolutely
   * positioned to cover it.  Every animation frame, the video frame is
   * uploaded as a 2D texture and rendered through a GLSL fragment shader
   * that samples the 3D LUT texture for colour grading.
   *
   * If WebGL is unavailable (e.g. headless or disabled GPU), we fall back
   * to the CSS filter path for live view (still accurate for captures via
   * the software LUT path).
   */

  const _vertSrc = `
    attribute vec2 a_pos;
    varying   vec2 v_uv;
    void main() {
      v_uv        = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const _fragSrc = `
    precision mediump float;
    uniform sampler2D u_video;
    uniform sampler2D u_lut;   /* packed 3D LUT as 2D texture (size×size rows, size cols) */
    uniform float     u_size;
    varying vec2      v_uv;

    vec3 applyLut(vec3 c) {
      float s  = u_size;
      float sm = s - 1.0;

      vec3 cf  = clamp(c, 0.0, 1.0) * sm;
      vec3 ci  = floor(cf);
      vec3 ct  = cf - ci;

      /* Map 3D (ri, gi, bi) to 2D atlas coords:
         atlas is arranged as size rows of (size×size) pixels wide.
         Row = bi, Column = ri + gi*size. */
      float texW = s * s;
      float texH = s;

      /* 8 corners of the trilinear cube */
      vec3 c000 = texture2D(u_lut, (vec2(ci.r + ci.g * s,       ci.b      ) + 0.5) / vec2(texW, texH)).rgb;
      vec3 c100 = texture2D(u_lut, (vec2(ci.r + 1.0 + ci.g * s, ci.b      ) + 0.5) / vec2(texW, texH)).rgb;
      vec3 c010 = texture2D(u_lut, (vec2(ci.r + (ci.g+1.0)*s,   ci.b      ) + 0.5) / vec2(texW, texH)).rgb;
      vec3 c110 = texture2D(u_lut, (vec2(ci.r+1.0+(ci.g+1.0)*s, ci.b      ) + 0.5) / vec2(texW, texH)).rgb;
      vec3 c001 = texture2D(u_lut, (vec2(ci.r + ci.g * s,       ci.b + 1.0) + 0.5) / vec2(texW, texH)).rgb;
      vec3 c101 = texture2D(u_lut, (vec2(ci.r+1.0+ci.g * s,     ci.b + 1.0) + 0.5) / vec2(texW, texH)).rgb;
      vec3 c011 = texture2D(u_lut, (vec2(ci.r + (ci.g+1.0)*s,   ci.b + 1.0) + 0.5) / vec2(texW, texH)).rgb;
      vec3 c111 = texture2D(u_lut, (vec2(ci.r+1.0+(ci.g+1.0)*s, ci.b + 1.0) + 0.5) / vec2(texW, texH)).rgb;

      vec3 r0 = mix(c000, c100, ct.r);
      vec3 r1 = mix(c010, c110, ct.r);
      vec3 r2 = mix(c001, c101, ct.r);
      vec3 r3 = mix(c011, c111, ct.r);
      vec3 g0 = mix(r0,   r1,   ct.g);
      vec3 g1 = mix(r2,   r3,   ct.g);
      return       mix(g0,   g1,   ct.b);
    }

    void main() {
      vec4 src = texture2D(u_video, v_uv);
      gl_FragColor = vec4(applyLut(src.rgb), src.a);
    }
  `;

  function _compileShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("[cameraFilterManager] Shader error:", gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  function _initWebGL(source) {
    if (_glInitOk) return true;
    if (!source) return false;

    // Create overlay canvas positioned over the source element's parent
    const canvas = document.createElement("canvas");
    canvas.style.cssText = [
      "position:absolute", "inset:0", "width:100%", "height:100%",
      "pointer-events:none", "z-index:1"
    ].join(";");
    source.parentElement.style.position = "relative";
    source.parentElement.appendChild(canvas);
    _glCanvas = canvas;

    const gl = canvas.getContext("webgl", { alpha: false, antialias: false });
    if (!gl) {
      console.warn("[cameraFilterManager] WebGL unavailable — LUT live view disabled.");
      return false;
    }
    _gl = gl;

    // Check for OES_texture_float (for 3D LUT texture precision; optional)
    gl.getExtension("OES_texture_float");

    const vert = _compileShader(gl, gl.VERTEX_SHADER,   _vertSrc);
    const frag = _compileShader(gl, gl.FRAGMENT_SHADER, _fragSrc);
    if (!vert || !frag) return false;

    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[cameraFilterManager] Program link error:", gl.getProgramInfoLog(prog));
      return false;
    }
    _glProgram = prog;
    gl.useProgram(prog);

    // Full-screen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Video texture (unit 0)
    _glTexVideo = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, _glTexVideo);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(prog, "u_video"), 0);

    // Upload the LUT as a 2D texture (size×size wide, size tall) — unit 1
    if (_lutLoaded) _uploadLutTexture(gl, prog);

    gl.uniform1f(gl.getUniformLocation(prog, "u_size"), _lutSize);

    _glInitOk = true;
    return true;
  }

  function _uploadLutTexture(gl, prog) {
    if (!_lutLoaded) return;
    const sz   = _lutSize;
    const texW = sz * sz;   // columns: r + g*sz
    const texH = sz;        // rows: b
    const pixels = new Uint8Array(texW * texH * 3);

    for (let b = 0; b < sz; b++) {
      for (let g = 0; g < sz; g++) {
        for (let r = 0; r < sz; r++) {
          const src = (r + g * sz + b * sz * sz) * 3;
          const dst = (r + g * sz + b * texW) * 3;
          pixels[dst]   = Math.round(_lutData[src]   * 255);
          pixels[dst+1] = Math.round(_lutData[src+1] * 255);
          pixels[dst+2] = Math.round(_lutData[src+2] * 255);
        }
      }
    }

    _glTexLut = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, _glTexLut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, texW, texH, 0, gl.RGB, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(prog || _glProgram, "u_lut"), 1);
    gl.uniform1f(gl.getUniformLocation(prog || _glProgram, "u_size"), sz);
  }

  /* ── Offscreen WebGL context for GPU-side LUT baking ────────────────────
   *
   * Used by applyLutToCanvasGL(canvas) to apply the LUT to a 2D canvas
   * (recording frames, captured photos) entirely on the GPU, then read the
   * result back with readPixels().  This is ~10-20× faster than the software
   * trilinear path for 1280×720 frames, keeping the recording RAF loop well
   * within its 33ms per-frame budget.
   *
   * Architecture: a hidden <canvas> owns this GL context so it never
   * conflicts with the live-view overlay (_gl / _glCanvas).  The render
   * target is a framebuffer-attached RGBA texture; after drawArrays() we
   * readPixels into the 2D canvas via putImageData().
   */
  function _initOffscreenGL() {
    if (_offInitOk) return true;
    if (!_lutLoaded) return false;

    // Hidden canvas — not appended to the DOM, just used as a GL surface.
    const canvas = document.createElement("canvas");
    canvas.width  = 1;   // will be resized per-call
    canvas.height = 1;
    _offCanvas = canvas;

    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) {
      console.warn("[cameraFilterManager] Offscreen WebGL unavailable — GL LUT baking disabled.");
      return false;
    }
    _offGl = gl;

    // Compile the same shaders used by the live-view overlay.
    const vert = _compileShader(gl, gl.VERTEX_SHADER,   _vertSrc);
    const frag = _compileShader(gl, gl.FRAGMENT_SHADER, _fragSrc);
    if (!vert || !frag) return false;

    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[cameraFilterManager] Offscreen program link error:", gl.getProgramInfoLog(prog));
      return false;
    }
    _offProgram = prog;
    gl.useProgram(prog);

    // Full-screen quad (identical to the live-view setup).
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Texture unit 0: source (the 2D canvas frame, uploaded each call).
    _offTexSrc = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, _offTexSrc);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(prog, "u_video"), 0);

    // Texture unit 1: LUT atlas (same packing as the live-view path).
    const sz   = _lutSize;
    const texW = sz * sz;
    const texH = sz;
    const pixels = new Uint8Array(texW * texH * 3);
    for (let b = 0; b < sz; b++) {
      for (let g = 0; g < sz; g++) {
        for (let r = 0; r < sz; r++) {
          const src = (r + g * sz + b * sz * sz) * 3;
          const dst = (r + g * sz + b * texW) * 3;
          pixels[dst]   = Math.round(_lutData[src]   * 255);
          pixels[dst+1] = Math.round(_lutData[src+1] * 255);
          pixels[dst+2] = Math.round(_lutData[src+2] * 255);
        }
      }
    }
    _offTexLut = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, _offTexLut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, texW, texH, 0, gl.RGB, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(prog, "u_lut"), 1);
    gl.uniform1f(gl.getUniformLocation(prog, "u_size"), sz);

    // Render target: RGBA texture + framebuffer.
    // We render into _offTexDst rather than the default framebuffer so we
    // can readPixels from a known RGBA layout regardless of the canvas format.
    _offTexDst = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, _offTexDst);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // Allocate at 1×1 initially; resized lazily in applyLutToCanvasGL.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    _offFb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, _offFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, _offTexDst, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    _offInitOk = true;
    console.log("[cameraFilterManager] Offscreen WebGL LUT context ready.");
    return true;
  }

  function _startGlLoop(source) {
    // If already running on a different source, stop first so we restart fresh.
    if (_glRafId !== null && _glSource !== source) {
      cancelAnimationFrame(_glRafId);
      _glRafId = null;
    }
    if (_glRafId !== null) return; // already running on same source
    _glSource = source;

    const isImg = source instanceof HTMLImageElement;

    function tick() {
      if (!_filterOn || !_lutLoaded || !_glInitOk) {
        _glRafId = null;
        return;
      }
      const gl = _gl;
      const canvas = _glCanvas;

      // Determine the pixel dimensions of the current source.
      // <video>: use videoWidth/videoHeight (intrinsic), fall back to clientWidth/clientHeight.
      // <img>:   use naturalWidth/naturalHeight (intrinsic), fall back to clientWidth/clientHeight.
      const vw = isImg
        ? (source.naturalWidth  || source.clientWidth)
        : (source.videoWidth    || source.clientWidth);
      const vh = isImg
        ? (source.naturalHeight || source.clientHeight)
        : (source.videoHeight   || source.clientHeight);

      if (vw > 0 && vh > 0 && (canvas.width !== vw || canvas.height !== vh)) {
        canvas.width  = vw;
        canvas.height = vh;
        gl.viewport(0, 0, vw, vh);
      }

      // Check whether the source has a decodable frame available.
      // <video>: readyState >= HAVE_CURRENT_DATA.
      // <img>:   complete && naturalWidth > 0 (blob: URLs from Electron IPC are
      //          same-origin and safe to upload to WebGL without tainting).
      const hasFrame = isImg
        ? (source.complete && source.naturalWidth > 0)
        : (source.readyState >= source.HAVE_CURRENT_DATA);

      if (hasFrame && canvas.width > 0) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, _glTexVideo);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
        } catch (_) {
          // Occasionally the img src changes mid-decode; skip this frame silently.
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, _glTexLut);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      _glRafId = requestAnimationFrame(tick);
    }

    _glRafId = requestAnimationFrame(tick);
  }

  function _stopGlLoop() {
    if (_glRafId !== null) {
      cancelAnimationFrame(_glRafId);
      _glRafId = null;
    }
    // Hide the WebGL canvas — don't call getContext("2d") on a WebGL canvas
    // as it always returns null and triggers a console warning.
    if (_glCanvas) {
      _glCanvas.style.opacity = "0";
    }
    // Restore the source element's opacity so it becomes visible again.
    if (_glSource) {
      _glSource.style.opacity = "";
      _glSource = null;
    }
  }

  /* ── Apply / remove the filter on the live view ──────────────────────────
   *
   * Two live-view modes:
   *   • Mock camera  — #shootingVideo is visible (hidden=false), #shootingImg
   *                    is hidden. WebGL overlay runs on the <video> element.
   *   • Real camera  — #shootingImg is visible (updated by polling loop),
   *                    #shootingVideo is hidden (videoWidth=0, useless for GL).
   *                    CSS filter applied directly to the <img> element.
   *
   * The WebGL path is only started when the <video> element is actually live
   * (mock mode). For real camera (img-based), we use the CSS filter string
   * as the live-view approximation; full LUT accuracy is applied at capture
   * time via applyLutToCanvas().
   */
  function _applyLiveView() {
    // Filter is intentionally NOT applied to the live camera preview.
    // photobooth.cube is baked into captured photos (via applyLutToCanvas /
    // applyLutToCanvasGL in camera-controller.js) and into the final video
    // (via remuxToMp4 in camera-bridge.js) — never during live view.
    // This prevents the preview from blacking out when WebGL is initialising
    // or when the img src is mid-decode between polling frames.
    //
    // Always ensure both source elements are fully visible and unfiltered
    // so the live feed is never accidentally hidden by a prior state change.
    const { video, img } = _els();
    _stopGlLoop();
    if (video) {
      video.style.opacity = "";
      video.style.filter  = "";
      video.classList.remove("filter-active");
    }
    if (img) {
      img.style.opacity = "";
      img.style.filter  = "";
      img.classList.remove("filter-active");
    }
  }

  /* ── Update filter UI elements ───────────────────────────────────────────── */
  function _updateUI() {
    const { chip, chipName, toggleBtn } = _els();
    const hasFilter = !!_activeFilter || _lutLoaded;

    if (chipName) chipName.textContent = _lutLoaded ? "photobooth.cube" : (_activeFilter ? _activeFilter.name : "None");

    if (chip) {
      chip.classList.toggle("no-filter", !hasFilter);
    }

    if (toggleBtn) {
      toggleBtn.disabled = !hasFilter;
      if (hasFilter) {
        toggleBtn.textContent = _filterOn ? "Filter: ON" : "Filter: OFF";
        toggleBtn.classList.toggle("filter-on", _filterOn);
      } else {
        toggleBtn.textContent = "No Filter";
        toggleBtn.classList.remove("filter-on");
      }
    }
  }

  /* ── XMP → CSS filter conversion (fallback approximation) ─────────────── */
  function _xmpToCssFilter(xmpText) {
    function _xmpVal(key, defaultVal) {
      const m = xmpText.match(new RegExp(`${key}="([\\-0-9.]+)"`));
      return m ? parseFloat(m[1]) : (xmpText.match(new RegExp(`<crs:${key}>([\\-0-9.]+)</crs:${key}>`)) ? parseFloat(xmpText.match(new RegExp(`<crs:${key}>([\\-0-9.]+)</crs:${key}>`))[1]) : defaultVal);
    }
    const exposure    = _xmpVal("Exposure2012",  0);
    const contrast    = _xmpVal("Contrast2012",  0);
    const saturation  = _xmpVal("Saturation",    0);
    const vibrance    = _xmpVal("Vibrance",       0);
    const temperature = _xmpVal("Temperature",   5500);
    const tint        = _xmpVal("Tint",           0);
    const highlights  = _xmpVal("Highlights2012", 0);
    const shadows     = _xmpVal("Shadows2012",    0);
    const expBright   = Math.pow(2, exposure);
    const hlBright    = 1 + (highlights / 100) * 0.15;
    const shBright    = 1 + (shadows    / 100) * 0.10;
    const brightness  = Math.max(0.1, expBright * hlBright * shBright);
    const contrastVal = contrast >= 0 ? 1 + (contrast / 100) : 1 + (contrast / 100) * 0.5;
    const saturateVal = Math.max(0, 1 + ((saturation + vibrance * 0.5) / 100));
    const hueRotate   = (5500 - temperature) / 2000 * 8 + tint / 150 * 5;
    const parts = [];
    if (Math.abs(brightness  - 1) > 0.01) parts.push(`brightness(${brightness.toFixed(3)})`);
    if (Math.abs(contrastVal - 1) > 0.01) parts.push(`contrast(${contrastVal.toFixed(3)})`);
    if (Math.abs(saturateVal - 1) > 0.01) parts.push(`saturate(${saturateVal.toFixed(3)})`);
    if (Math.abs(hueRotate)       > 0.5)  parts.push(`hue-rotate(${hueRotate.toFixed(1)}deg)`);
    return parts.length ? parts.join(" ") : "";
  }

  /* ── Resolve the active filter from assetSync ────────────────────────────── */
  function _loadActiveFilter() {
    if (typeof assetSync === "undefined") return;
    const filters = assetSync.getFilters();
    if (!Array.isArray(filters) || !filters.length) {
      _activeFilter = null;
      _cssFilter    = "";
      _filterOn     = _lutLoaded; // keep LUT on if loaded
      _updateUI();
      _applyLiveView();
      return;
    }
    const active = filters.find(f => f.active === true) || filters[0];
    if (!active) return;
    if (_activeFilter && _activeFilter.id === active.id) return;
    _activeFilter = active;
    if (active.cssFilter) {
      _cssFilter = active.cssFilter;
    } else if (active.fileData) {
      try {
        const xmpText = atob(active.fileData);
        _cssFilter = _xmpToCssFilter(xmpText);
      } catch (e) {
        console.warn("[cameraFilterManager] Could not decode XMP filter:", e);
        _cssFilter = "";
      }
    } else {
      _cssFilter = "";
    }
    _filterOn = _lutLoaded ? true : !!_cssFilter;
    _updateUI();
    _applyLiveView();
    console.log(`[cameraFilterManager] Active filter: ${_activeFilter.name}`);
  }

  /* ── Wire the toggle button ──────────────────────────────────────────────── */
  function _wireToggle() {
    const { toggleBtn } = _els();
    if (!toggleBtn || toggleBtn._filterWired) return;
    toggleBtn._filterWired = true;
    toggleBtn.addEventListener("click", () => {
      if (!_activeFilter && !_lutLoaded) return;
      _filterOn = !_filterOn;
      _updateUI();
      _applyLiveView();
    });
  }

  /* ── Load photobooth.cube ────────────────────────────────────────────────
   * Primary filter source. Loaded before the XMP fallback.
   * On success, the LUT overrides any XMP-derived CSS filter for captures
   * and video; the WebGL overlay handles live view.
   */
  function _loadCubeLut() {
    return fetch("assets/filter/photobooth.cube")
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then((text) => {
        const { size, data } = _parseCube(text);
        _lutSize   = size;
        _lutData   = data;
        _lutLoaded = true;

        // If WebGL is already initialised (video is live), upload the texture now
        if (_glInitOk && _gl && _glProgram) {
          _uploadLutTexture(_gl, _glProgram);
        }

        // Mark a synthetic active filter entry so the UI chip shows
        if (!_activeFilter) {
          _activeFilter = { id: "__cube__", name: "photobooth.cube" };
        }
        _filterOn = true;
        _updateUI();
        _applyLiveView();
        console.log(`[cameraFilterManager] photobooth.cube loaded (${size}³ LUT)`);
      })
      .catch((e) => {
        console.warn("[cameraFilterManager] Could not load photobooth.cube:", e.message || e);
        // Fall through to XMP fallback
      });
  }

  /* ── Local XMP fallback ──────────────────────────────────────────────────── */
  function _loadLocalXmpFallback() {
    if (_activeFilter) return; // already have a filter (LUT or assetSync)
    fetch("assets/filter/Photobooth.xmp")
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then((xmpText) => {
        if (_activeFilter) return;
        const css = _xmpToCssFilter(xmpText);
        _activeFilter = { id: "__local__", name: "Photobooth", cssFilter: css };
        _cssFilter    = css;
        _filterOn     = !!css;
        _updateUI();
        _applyLiveView();
        console.log(`[cameraFilterManager] Local XMP filter loaded → "${css}"`);
      })
      .catch((e) => {
        console.warn("[cameraFilterManager] Could not load local XMP filter:", e.message || e);
      });
  }

  /* ── Public API ──────────────────────────────────────────────────────────── */
  return {
    /*
     * init() — called by boot.js / app.js after assetSync.init() resolves.
     * Loads the CUBE LUT first, then wires the toggle button, then checks
     * assetSync, and finally falls back to the local XMP if needed.
     */
    init() {
      _wireToggle();
      _loadActiveFilter();

      // Primary: load the photobooth.cube LUT
      _loadCubeLut().then(() => {
        // Secondary fallback: local XMP (only runs if cube load failed)
        setTimeout(() => _loadLocalXmpFallback(), 200);
      });

      // Re-check when filters are updated from Supabase in the background
      document.addEventListener("studrio:filtersUpdated", () => {
        _loadActiveFilter();
      });

      // When the shooting page becomes active and the camera preview is live,
      // (re-)apply the filter to whichever element is the active live source.
      document.addEventListener("shooting:sessionStart", () => {
        if (_filterOn && _lutLoaded) _applyLiveView();
      });
    },

    /*
     * getCssFilter() — returns the CSS filter string to apply during
     * canvas operations (legacy XMP path).  When the CUBE LUT is loaded,
     * use applyLutToCanvas() instead for pixel-accurate results.
     */
    getCssFilter() {
      return (_filterOn && _cssFilter) ? _cssFilter : "";
    },

    /*
     * applyToCanvas(ctx) — legacy API: sets ctx.filter for CSS-style
     * colour grading before ctx.drawImage(). Used by existing callers in
     * shooting.js / video-recording code that weren't updated for LUT path.
     * When CUBE LUT is active this sets the CSS approximation as a baseline;
     * call applyLutToCanvas() afterwards for full LUT accuracy.
     */
    applyToCanvas(ctx) {
      if (!_filterOn) return;
      // When CUBE LUT is loaded, prefer the software LUT over CSS filter
      // (caller should also call applyLutToCanvas for pixel-level accuracy)
      const f = _cssFilter;
      if (f) ctx.filter = f;
    },

    resetCanvas(ctx) {
      ctx.filter = "none";
    },

    /*
     * applyLutToCanvas(canvas) — applies the CUBE 3D LUT to the pixel data
     * of the provided canvas element IN PLACE using software trilinear
     * interpolation.  Call this after drawing the source image to the canvas
     * (e.g. after ctx.drawImage(video, ...)) to bake the LUT into captures
     * and video recording frames with full colour accuracy.
     *
     * Returns true if the LUT was applied, false if inactive or unavailable.
     *
     * Usage (photo capture / video RAF):
     *   ctx.drawImage(sourceVideo, 0, 0, w, h);
     *   cameraFilterManager.applyLutToCanvas(canvas);
     */
    applyLutToCanvas(canvas) {
      if (!_filterOn || !_lutLoaded) return false;
      try {
        const ctx  = canvas.getContext("2d");
        const w    = canvas.width;
        const h    = canvas.height;
        const id   = ctx.getImageData(0, 0, w, h);
        const data = id.data;
        const inv255 = 1 / 255;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]   * inv255;
          const g = data[i+1] * inv255;
          const b = data[i+2] * inv255;
          const [nr, ng, nb] = _lutLookup(r, g, b);
          data[i]   = Math.round(nr * 255);
          data[i+1] = Math.round(ng * 255);
          data[i+2] = Math.round(nb * 255);
          // Alpha unchanged
        }
        ctx.putImageData(id, 0, 0);
        return true;
      } catch (e) {
        console.warn("[cameraFilterManager] applyLutToCanvas failed:", e.message || e);
        return false;
      }
    },

    /*
     * applyLutToCanvasGL(canvas) — GPU-accelerated version of applyLutToCanvas.
     *
     * Uploads the 2D canvas as a WebGL texture, runs it through the LUT
     * shader in an offscreen framebuffer, then reads the result back with
     * readPixels() and writes it into the 2D canvas via putImageData().
     *
     * ~10-20× faster than the software trilinear path on 1280×720 frames,
     * which is what makes per-frame LUT application in the video recording
     * RAF loop viable without dropping frames.
     *
     * Falls back to the software applyLutToCanvas() path if:
     *   • the LUT is not loaded / filter is off
     *   • WebGL is unavailable on this machine
     *   • the canvas dimensions exceed WebGL MAX_TEXTURE_SIZE
     *
     * Returns true if the LUT was applied (either path), false if inactive.
     *
     * Usage (video recording RAF, called after drawImage onto _recordCanvas):
     *   cameraFilterManager.applyLutToCanvasGL(canvas);
     */
    applyLutToCanvasGL(canvas) {
      if (!_filterOn || !_lutLoaded) return false;

      // Lazy-init the offscreen GL context the first time it is needed.
      if (!_offInitOk) _initOffscreenGL();

      // If GL is unavailable, fall back to the software path.
      if (!_offInitOk) return this.applyLutToCanvas(canvas);

      const gl = _offGl;
      const w  = canvas.width;
      const h  = canvas.height;

      try {
        // ── 1. Resize the offscreen canvas + render target if needed ────────
        if (_offCanvas.width !== w || _offCanvas.height !== h) {
          _offCanvas.width  = w;
          _offCanvas.height = h;
          gl.viewport(0, 0, w, h);

          // Re-allocate the render-target texture at the new size.
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, _offTexDst);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }

        // ── 2. Upload the 2D canvas as the source texture (unit 0) ──────────
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, _offTexSrc);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, canvas);

        // ── 3. Bind LUT texture (unit 1) ────────────────────────────────────
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, _offTexLut);

        // ── 4. Render through the LUT shader into the framebuffer ───────────
        gl.bindFramebuffer(gl.FRAMEBUFFER, _offFb);
        gl.useProgram(_offProgram);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // ── 5. Read pixels back from GPU → CPU ──────────────────────────────
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // ── 6. Write the LUT-graded pixels back onto the 2D canvas ──────────
        // readPixels returns rows bottom-to-top (OpenGL convention); the 2D
        // canvas ImageData expects top-to-bottom. Flip vertically here so
        // the resulting frame isn't upside-down in the recorded video.
        const ctx      = canvas.getContext("2d");
        const flipped  = new Uint8ClampedArray(w * h * 4);
        const rowBytes = w * 4;
        for (let y = 0; y < h; y++) {
          const srcRow = (h - 1 - y) * rowBytes;
          const dstRow = y * rowBytes;
          flipped.set(pixels.subarray(srcRow, srcRow + rowBytes), dstRow);
        }
        ctx.putImageData(new ImageData(flipped, w, h), 0, 0);
        return true;

      } catch (e) {
        console.warn("[cameraFilterManager] applyLutToCanvasGL failed, falling back to software:", e.message || e);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return this.applyLutToCanvas(canvas);
      }
    },

    /*
     * isActive() — returns true when a filter is loaded and enabled.
     */
    isActive() {
      return _filterOn && (_lutLoaded || !!_cssFilter);
    },

    /*
     * isLutLoaded() — true when the CUBE LUT has been parsed successfully.
     */
    isLutLoaded() {
      return _lutLoaded;
    },

    /*
     * refresh() — re-reads the filter list; call after assetSync.forceRefresh().
     */
    refresh() {
      _loadActiveFilter();
    }
  };
})();

/* ── PAGE 1 → PAGE 2: wire the ticket-page NEXT button ─────────────────────
 * btnNextFromTicket is enabled by queue-ticket-kiosk.js once a valid QR
 * ticket has been scanned and validated. This handler advances the kiosk
 * to the Template Selection page (page-template) and starts the 60-second
 * idle timer for that page.
 * ────────────────────────────────────────────────────────────────────────── */
(function() {
  const btn = document.getElementById("btnNextFromTicket");
  if (!btn) return;
  btn.addEventListener("click", () => {
    kioskTimer.hide();
    goToPage("template");
  });
})();

/* ──────────────────────────────────────────────────────────────────────────
 * PAGE 2 (NEW): TEMPLATE SELECTION MODULE
 * Replaces the old Frame + Camera Mode + Design pages for template picking.
 * ────────────────────────────────────────────────────────────────────────── */

const templateModule = (() => {
  // Currently active category filter: "all" | "originals" | "designs" | "accessories"
  let _activeCategory = "all";
  // Index of first visible card (for horizontal carousel pagination)
  let _carouselOffset = 0;
  // How many templates visible at once
  const VISIBLE_COUNT = 5;
  // Filtered template list for the current category
  let _filteredTemplates = [];

  /*
   * Map a STRIP_DESIGNS entry to its kiosk category tab key.
   *
   * strip.js initDesigns() now normalises the raw Supabase `asset_type`
   * value into a lowercase key on each entry (template.category).
   * We read that directly — no more substring-matching on template names,
   * which caused false positives (e.g. "Design Alpha" → "designs" even
   * if its admin category was "Originals").
   *
   * Falls back to "originals" for legacy entries that pre-date the
   * category field.
   */
  function _getCategory(template) {
    const cat = (template.category || "").toLowerCase().trim();
    if (cat === "originals")   return "originals";
    if (cat === "accessories") return "accessories";
    if (cat === "designs")     return "designs";
    if (cat === "flipbook")    return "flipbook";
    // Legacy fallback: try to infer from the label as a last resort
    const label = (template.label || template.name || "").toLowerCase();
    if (label.includes("accessor")) return "accessories";
    if (label.includes("flipbook")) return "flipbook";
    if (label.includes("design"))   return "designs";
    return "originals";
  }

  /* Determine frameType from a template.
   *
   * Keychain templates live under the "Accessories" category and have a
   * keychainOverlayUrl (or keychain_overlay_path) but NO standard 2×6/4×6
   * overlay. Selecting one sets frameType = "keychain" so printing.js
   * routes to keychainAddon.exportPrintPNG() instead of the standard path.
   *
   * For all other templates: prefer 2x6 if available, else 4x6.
   */
  function _getFrameType(template) {
    const has2x6      = !!(template.overlayUrl2x6  || template.overlays?.["2x6"]);
    const has4x6      = !!(template.overlayUrl4x6  || template.overlays?.["4x6"]);
    const hasKeychain = !!(template.keychainOverlayUrl || template.keychain_overlay_path);
    const hasLongDuo  = !!(template.overlayUrlLongDuo  || template.overlays?.["long-duo"]);
    const hasLongMini = !!(template.overlayUrlLongMini || template.overlays?.["long-mini"]);
    const hasFilmDuo  = !!(template.overlayUrlFilmDuo  || template.overlays?.["film-duo"]);
    const hasWideMini = !!(template.overlayUrlWideMini || template.overlays?.["wide-mini"]);
    const hasFlipbook = !!(template.flipbookCoverUrl || template.flipbookA4Page1Url || template.flipbookA4Page2Url);

    // A flipbook template has its own 3-asset set and never a standard strip.
    if (hasFlipbook) return "flipbook";

    // A keychain template: has a keychain overlay but no standard strip overlays.
    if (hasKeychain && !has2x6 && !has4x6 && !hasLongDuo && !hasLongMini && !hasFilmDuo && !hasWideMini) return "keychain";

    if (has2x6)      return "2x6";
    if (has4x6)      return "4x6";
    if (hasLongDuo)  return "long-duo";
    if (hasLongMini) return "long-mini";
    if (hasFilmDuo)  return "film-duo";
    if (hasWideMini) return "wide-mini";
    return "2x6"; // fallback
  }

  function _getFilteredTemplates() {
    const all = (typeof STRIP_DESIGNS !== "undefined" ? STRIP_DESIGNS : []);
    if (_activeCategory === "all") return all;
    return all.filter(t => _getCategory(t) === _activeCategory);
  }

  function _renderCarousel() {
    const track = document.getElementById("templateCarouselTrack");
    if (!track) return;
    track.innerHTML = "";

    _filteredTemplates = _getFilteredTemplates();

    if (!_filteredTemplates.length) {
      track.innerHTML = '<div class="template-empty-msg template-coming-soon"><span class="template-coming-soon-icon">🌟</span><span class="template-coming-soon-text">Coming Soon</span><span class="template-coming-soon-sub">New templates are on their way!</span></div>';
      _updateArrows();
      return;
    }

    // Render ALL templates — the track-outer is a touch-scrollable overflow
    // container (overflow-x: auto in style-redesign.css), so the user can
    // swipe/drag to see every template without pagination arrows.
    _carouselOffset = 0;

    _filteredTemplates.forEach((tmpl) => {
      const frameType = _getFrameType(tmpl);
      const isActive  = String(tmpl.id) === String(sessionState.design);

      const card = document.createElement("button");
      card.className = "template-card" + (isActive ? " active" : "");
      card.type = "button";
      card.dataset.templateId = tmpl.id;
      card.dataset.frameType  = frameType;

      // Size badge
      const sizeBadge = document.createElement("span");
      if (frameType === "flipbook") {
        sizeBadge.className = "template-size-badge template-size-badge--flipbook";
        sizeBadge.textContent = "Flipbook";
      } else if (frameType === "keychain") {
        sizeBadge.className = "template-size-badge template-size-badge--keychain";
        sizeBadge.textContent = "Keychain";
      } else if (frameType === "2x6") {
        sizeBadge.className = "template-size-badge template-size-badge--2-6";
        sizeBadge.textContent = "2×6";
      } else if (frameType === "4x6") {
        sizeBadge.className = "template-size-badge template-size-badge--4-6";
        sizeBadge.textContent = "4×6";
      } else {
        // New frame types — use a generic badge with the frame type as the label
        const labelMap = {
          "long-duo":  "Long Duo",
          "long-mini": "Long Mini",
          "film-duo":  "Film Duo",
          "wide-mini": "Wide Mini"
        };
        const cssKey = frameType.replace(/-/g, "-");
        sizeBadge.className = `template-size-badge template-size-badge--${cssKey}`;
        sizeBadge.textContent = labelMap[frameType] || frameType;
      }

      const thumb = document.createElement("img");
      thumb.className = "template-card-thumb";
      thumb.alt = tmpl.label || tmpl.name || "Template";
      thumb.src = tmpl.thumbnail || tmpl.thumbnailUrl || "";
      thumb.loading = "lazy";

      const label = document.createElement("span");
      label.className = "template-card-label";
      label.textContent = tmpl.label || tmpl.name || "Template";

      card.appendChild(sizeBadge);
      card.appendChild(thumb);
      card.appendChild(label);

      card.addEventListener("click", () => _selectTemplate(tmpl.id, frameType));
      track.appendChild(card);
    });

    // Trigger fade/slide-in entrance animation on every render
    // (category change, arrow navigation, initial load).
    // The CSS animation is defined on .template-carousel-track.animating
    // and fires once per class-add so we remove/re-add it.
    requestAnimationFrame(() => {
      track.classList.remove("animating");
      void track.offsetWidth; // force reflow to restart animation
      track.classList.add("animating");
    });

    _updateArrows();
    _updateSelectedBar();
  }

  function _selectTemplate(id, frameType) {
    sessionState.design    = id;
    sessionState.frameType = frameType;

    // Keep designModule in sync so the hidden page-design's CoverFlow
    // and filter state reflect the template chosen here on page-template.
    if (typeof designModule !== "undefined") {
      designModule._activeFilter = "none";
    }

    // Toggle the "active" class on the existing card elements instead of
    // calling _renderCarousel(). _renderCarousel() wipes and rebuilds the
    // entire track's innerHTML, which (a) retriggered the .animating
    // fade/slide-in entrance animation — meant only for genuinely new card
    // sets (category switch, arrow paging, initial load) — on every single
    // tap, and (b) replaced each card with a brand-new DOM node, so the
    // enlarge/glow CSS transition on .template-card-thumb had no previous
    // state to animate from/to. Updating the class in place on the same
    // nodes lets that existing transition run naturally in both directions.
    const track = document.getElementById("templateCarouselTrack");
    if (track) {
      track.querySelectorAll(".template-card").forEach(card => {
        card.classList.toggle("active", String(card.dataset.templateId) === String(id));
      });
    }

    // Enable NEXT
    const nextBtn = document.getElementById("btnNextFromTemplate");
    if (nextBtn) nextBtn.disabled = false;

    _updateSelectedBar();
  }

  function _updateSelectedBar() {
    const nameEl = document.getElementById("templateSelectedName");
    const sizeEl = document.getElementById("templateSelectedSize");
    if (!nameEl || !sizeEl) return;

    if (!sessionState.design) {
      _setSelectedName(nameEl, "No template selected");
      sizeEl.textContent = "";
      return;
    }

    const tmpl = _filteredTemplates.find(t => String(t.id) === String(sessionState.design))
      || (typeof STRIP_DESIGNS !== "undefined" ? STRIP_DESIGNS.find(t => String(t.id) === String(sessionState.design)) : null);
    if (!tmpl) return;

    _setSelectedName(nameEl, tmpl.label || tmpl.name || "Template");
    const ft = sessionState.frameType || "2x6";
    const frameSizeLabels = {
      "flipbook":  "Flipbook (20 pages)",
      "keychain":  "Mini-Strip Keychain",
      "2x6":       "Long Strip (2×6)",
      "4x6":       "Wide Frame (4×6)",
      "long-duo":  "Long Duo",
      "long-mini": "Long Mini",
      "film-duo":  "Film Duo",
      "wide-mini": "Wide Mini"
    };
    sizeEl.textContent = frameSizeLabels[ft] || ft;
  }

  /*
   * Plays a short fade/slide swap animation on the selected-template name
   * (see .template-selected-name.name-swap in style-redesign.css) whenever
   * the displayed text actually changes. No-ops on repeat calls with the
   * same text (e.g. _updateSelectedBar() re-running for other reasons)
   * so it only plays when switching between templates.
   */
  function _setSelectedName(nameEl, text) {
    if (nameEl.textContent === text) return;
    nameEl.textContent = text;
    nameEl.classList.remove("name-swap");
    void nameEl.offsetWidth; // force reflow to restart the animation
    nameEl.classList.add("name-swap");
  }

  function _updateArrows() {
    const prev = document.getElementById("templateCarouselPrev");
    const next = document.getElementById("templateCarouselNext");
    if (!prev || !next) return;
    prev.disabled = _carouselOffset <= 0;
    // Disable Next when the current page already shows the last template(s)
    next.disabled = _carouselOffset + VISIBLE_COUNT >= _filteredTemplates.length;
  }

  function _scroll(dir) {
    // Move by a full page (VISIBLE_COUNT) so the Next/Prev arrows show
    // the next/previous batch of 5 templates rather than shifting by 1.
    _carouselOffset = Math.max(0,
      Math.min(
        Math.max(0, _filteredTemplates.length - VISIBLE_COUNT),
        _carouselOffset + dir * VISIBLE_COUNT
      )
    );
    _renderCarousel();
  }

  // Guards against re-wiring events on subsequent visits to page-template
  let _wired = false;

  function init() {
    if (!_wired) {
      // Wire category tabs — done once only
      document.querySelectorAll(".template-cat-tab").forEach(tab => {
        tab.addEventListener("click", () => {
          document.querySelectorAll(".template-cat-tab").forEach(t => t.classList.remove("active"));
          tab.classList.add("active");
          _activeCategory = tab.dataset.cat;
          _carouselOffset = 0;
          _renderCarousel();
        });
      });

      // Wire carousel arrows — done once only
      const prev = document.getElementById("templateCarouselPrev");
      const next = document.getElementById("templateCarouselNext");
      if (prev) prev.addEventListener("click", () => _scroll(-1));
      if (next) next.addEventListener("click", () => _scroll(1));

      // Wire NEXT button — done once only
      const nextBtn = document.getElementById("btnNextFromTemplate");
      if (nextBtn) {
        nextBtn.addEventListener("click", () => {
          if (!sessionState.design || !sessionState.frameType) return;
          kioskTimer.hide();
          _startShooting();
        });
      }

      _wired = true;
    }

    // Always re-render on each visit; timer is disabled on this page
    _renderCarousel();
    kioskTimer.hide(); // ensure timer is hidden on page-template
  }

  /*
   * Called by strip.js initDesigns() after templates load, and by
   * resetSessionAndRestart() when returning to page-template.
   * Resets the carousel to offset 0 without changing the active category
   * (so guests returning mid-session land on the same tab they left).
   * Category tab UI is reset to "All" by resetSessionAndRestart() separately.
   */
  function refresh() {
    _carouselOffset = 0;
    _renderCarousel();
  }

  /*
   * resetCategory — called by resetSessionAndRestart() to put the
   * category tabs back to "All" when a new session starts.
   */
  function resetCategory() {
    _activeCategory  = "all";
    _carouselOffset  = 0;
    // Reset tab highlight
    document.querySelectorAll(".template-cat-tab").forEach((t, i) => {
      t.classList.toggle("active", i === 0);
    });
  }

  return { init, refresh, resetCategory, _getFrameType, _selectTemplate };
})();

/* ──────────────────────────────────────────────────────────────────────────
 * START SHOOTING — shared helper called from template NEXT and timer
 * ────────────────────────────────────────────────────────────────────────── */
function _startShooting() {
  kioskTimer.hide();

  // Sanity-check: template must have been selected on page-template.
  // If design is missing (e.g. assetSync hadn't loaded yet), fall back to
  // the first available design so the session is never started blind.
  if (!sessionState.design && typeof STRIP_DESIGNS !== "undefined" && STRIP_DESIGNS.length) {
    const first = STRIP_DESIGNS[0];
    sessionState.design    = first.id;
    sessionState.frameType = (typeof templateModule !== "undefined")
      ? templateModule._getFrameType(first)
      : (first.overlays && first.overlays["2x6"] ? "2x6" : "4x6");
    console.warn("[_startShooting] No design selected — auto-selected first available:", first.id);
  }

  // Flipbook templates route to their own video-taking flow entirely —
  // never the 8-shot photo session below.
  if (sessionState.frameType === "flipbook") {
    sessionState._isFlipbook = true;
    sessionState._isKeychain = false;
    if (typeof audioManager !== "undefined") audioManager.onShootingStart();
    goToPage("flipbook-shoot");
    flipbookShootingModule.startSession();
    return;
  }
  sessionState._isFlipbook = false;

  // Ensure frameType is always set (2x6 is safe default).
  // "keychain" uses the 2x6 photo-taking layout (8 shots, same slots).
  // The keychain-specific print layout is applied at printing time.
  if (!sessionState.frameType) sessionState.frameType = "2x6";
  // Store the keychain flag before overriding frameType for shooting
  if (sessionState.frameType === "keychain") {
    sessionState._isKeychain = true;
    sessionState.frameType   = "2x6"; // shoot in 2x6 mode
  } else {
    sessionState._isKeychain = false;
  }

  if (typeof audioManager !== "undefined") {
    audioManager.onShootingStart();
  }

  _updatePoseOverlay();
  // shootingModule.startSession() re-derives and writes both of these from
  // sessionState.shots right away (see _updatePhotosTakenUI()) — set here
  // too just so the page never flashes a stale "8" total from a previous
  // build before that runs.
  const ptEl = document.getElementById("photosTakenCount");
  if (ptEl) ptEl.innerHTML = '0<span class="photos-taken-slash">/</span><span class="photos-taken-total">20</span>';
  const ptLabelEl = document.getElementById("photosTakenLabel");
  if (ptLabelEl) ptLabelEl.textContent = "Photos Taken";

  goToPage("shooting");
  shootingModule.startSession();
}

/* Also keep _proceedFromSetup as an alias (boot.js / kiosk-timer callbacks) */
function _proceedFromSetup() { _startShooting(); }

/* ---------------- PAGE 6: PRINTING → AUTO-RETURN QR COUNTDOWN ---------------- */

/*
 * uploadProgress — public API for qr.js / printing.js.
 *
 * The visible upload progress bar has been removed from the UI.
 * These methods still update the hidden #uploadProgressWrap elements so
 * qr.js can call them without errors, and they drive the post-print flow:
 *
 *   uploadProgress.start()      — called when printing begins (no-op for UI)
 *   uploadProgress.set(0–1)     — tracks upload fraction (no-op for UI)
 *   uploadProgress.complete()   — printing started → show QR + start 30s countdown
 *   uploadProgress.error(msg)   — upload failed → still start the 30s countdown
 *
 * There is no Done button — printing is never interruptible. Once the
 * countdown in #qrCountdown reaches zero, the kiosk fades to white and
 * automatically returns to the home/ticket screen (see _fadeToWhiteThenReset).
 */
const uploadProgress = (() => {
  // Hidden elements — kept for qr.js compatibility
  const wrap  = document.getElementById("uploadProgressWrap");
  const bar   = document.getElementById("uploadProgressBar");
  const pct   = document.getElementById("uploadProgressPct");
  const label = document.getElementById("uploadProgressLabel");
  const hint  = document.getElementById("uploadProgressHint");

  const countdownEl = document.getElementById("qrCountdown");
  const countdownNumberEl = document.getElementById("qrCountdownNumber");

  const QR_COUNTDOWN_SECONDS = 30;

  // Visible 30s post-print countdown, ticking down next to the QR code.
  let _qrCountdownTimer = null;
  // Safety-net timer: if complete() / error() never fires (e.g. upload hangs
  // with no network and no error callback), start the countdown after 25s
  // anyway so the guest is never permanently stranded on the printing page.
  let _safetyTimer = null;

  function _hideCountdown() {
    if (_qrCountdownTimer) { clearInterval(_qrCountdownTimer); _qrCountdownTimer = null; }
    if (countdownEl) countdownEl.hidden = true;
  }

  function _startQrCountdown() {
    if (_safetyTimer) { clearTimeout(_safetyTimer); _safetyTimer = null; }
    if (_qrCountdownTimer) return; // already counting down

    let secondsLeft = QR_COUNTDOWN_SECONDS;
    if (countdownNumberEl) countdownNumberEl.textContent = secondsLeft;
    if (countdownEl) countdownEl.hidden = false;

    _qrCountdownTimer = setInterval(() => {
      secondsLeft -= 1;
      if (countdownNumberEl) countdownNumberEl.textContent = Math.max(secondsLeft, 0);
      if (secondsLeft <= 0) {
        clearInterval(_qrCountdownTimer);
        _qrCountdownTimer = null;
        // ── Audio: begin main → standby crossfade as the kiosk returns home ──
        if (typeof audioManager !== "undefined") {
          audioManager.onPrintingDone();
        }
        _fadeToWhiteThenReset();
      }
    }, 1000);
  }

  return {
    start() {
      // Update hidden elements for qr.js
      if (wrap)  { wrap.classList.remove("complete", "error", "has-progress"); }
      if (bar)   { bar.style.width = "0%"; }
      if (pct)   { pct.textContent = "0%"; }
      if (label) { label.textContent = "Uploading your photos…"; }
      if (hint)  { hint.textContent = "Your digital copy will be ready soon"; }

      // Safety net: if complete() or error() never fires (no network + no error
      // callback), start the countdown after 25s so the kiosk never gets stuck.
      if (_safetyTimer) clearTimeout(_safetyTimer);
      _safetyTimer = setTimeout(() => {
        _safetyTimer = null;
        console.warn("[uploadProgress] Safety timer fired — starting QR countdown (upload may be stalled or offline).");
        _startQrCountdown();
      }, 25000);
    },

    set(fraction) {
      const pctVal = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      if (wrap) { wrap.classList.add("has-progress"); }
      if (bar)  { bar.style.width = `${pctVal}%`; }
      if (pct)  { pct.textContent = `${pctVal}%`; }
    },

    complete() {
      if (wrap)  { wrap.classList.add("complete", "has-progress"); wrap.classList.remove("error"); }
      if (bar)   { bar.style.width = "100%"; }
      if (pct)   { pct.textContent = "100%"; }
      if (label) { label.textContent = "Upload complete!"; }
      if (hint)  { hint.textContent = "Scan the QR code to access your digital copy"; }
      _startQrCountdown();
    },

    error(msg) {
      if (wrap)  { wrap.classList.add("error"); wrap.classList.remove("complete"); }
      if (pct)   { pct.textContent = "—"; }
      if (label) { label.textContent = msg || "Upload failed"; }
      if (hint)  { hint.textContent = "Your photos were printed. Contact staff for the digital copy."; }
      // Still start the countdown so the session isn't stuck
      _startQrCountdown();
    },

    // Called by resetSessionAndRestart() to cancel the auto-timer
    cancelTimer() {
      if (_safetyTimer) { clearTimeout(_safetyTimer); _safetyTimer = null; }
      _hideCountdown();
    }
  };
})();

/*
 * _fadeToWhiteThenReset — the screen fades completely to white, the session
 * is reset and the home/ticket page is swapped in underneath the fade, then
 * the fade clears to reveal it. Used when the Print & QR page's 30s
 * countdown reaches zero (see uploadProgress._startQrCountdown above).
 */
function _fadeToWhiteThenReset() {
  const overlay = document.getElementById("whiteFadeOverlay");
  if (!overlay) { resetSessionAndRestart(); return; }

  overlay.classList.add("active");
  // Wait for the fade-to-white CSS transition (0.6s) to finish before
  // switching pages, so the page change is never visible mid-transition.
  setTimeout(() => {
    // The Print & QR page normally fades out over its own 0.35s .page
    // transition when goToPage() runs — that fade races the white overlay's
    // own (slower) fade-out below and can let the page briefly peek through
    // as the overlay clears. Force it instantly invisible first (no
    // transition) so the swap below happens fully hidden.
    const printingPage = document.getElementById("page-printing");
    if (printingPage) printingPage.classList.add("page-force-hidden");

    resetSessionAndRestart();

    // Reveal the home/ticket page by fading the white overlay back out.
    requestAnimationFrame(() => {
      overlay.classList.remove("active");
      if (printingPage) printingPage.classList.remove("page-force-hidden");
    });
  }, 650);
}


/* Hook into the design page's "NEXT" button — defined in strip.js. */
const _origDesignNext = document.getElementById("btnNextFromDesign");
_origDesignNext.addEventListener("click", async () => {
  // ── Audio: fire printing SFX immediately on button press ──────────────
  // Must happen before any await so the sound starts without delay.
  if (typeof audioManager !== "undefined") {
    audioManager.playPrintSfx();
  }

  // Reset + start progress bar immediately
  uploadProgress.start();
  // Fire QR generation (assigns sessionState.galleryUrlPromise synchronously)
  qrModule.generateAndRender();
  // Set the video frame's aspect ratio based on frame type before init
  _setPrintingFrameAspectRatio();
  // Ensure the printing module has the latest design selection
  await printingModule.init();

  // Photo→video overlay transition removed — video strip shows directly

  // Link the QR ticket to this session (fire-and-forget)
  if (sessionState.ticketId && sessionState.id) {
    queueTickets.linkSession(sessionState.ticketId, sessionState.id).catch((e) => {
      console.warn("[app] Could not link ticket to session:", e.message || e);
    });
  }
});

/*
 * Sets the data-frame attribute on #printingVideoFrame so CSS applies the
 * correct aspect ratio (2:6 for Long Frame, 4:6 for Wide Frame).
 */
function _setPrintingFrameAspectRatio() {
  const videoFrame = document.getElementById("printingVideoFrame");
  if (!videoFrame) return;
  const frameType = sessionState.frameType || "2x6";
  videoFrame.dataset.frame = frameType;
}

/* _startPhotoToVideoTransition removed — photo overlay on Print & QR page
   has been removed per spec. Video strip shows directly without overlay. */

/* Done button removed — printing can no longer be interrupted or cancelled
   from this page (see #page-printing .sb-next-corner in style-redesign.css).
   The kiosk now returns home automatically via the 30s QR countdown in the
   uploadProgress module above; the confirm-before-ending-session modal is
   no longer reachable from this page since there is nothing left that can
   trigger it here. */

/*
 * resetSessionAndRestart — tears down the current session and returns to
 * the Frame Selection page.
 *
 * OFFLINE SAFETY: We no longer block on sessionState.uploadPromise here.
 * The upload either:
 *   a) already completed → no wait needed.
 *   b) is still in progress → offlineQueue handles it; kiosk must not be
 *      stuck waiting on a network call while the guest is standing here.
 *   c) failed → offlineQueue already enqueued it for retry.
 *
 * In all three cases the 30s QR countdown still resets the kiosk on schedule.
 * The pending upload continues / retries in the background via offlineQueue.
 */
async function resetSessionAndRestart() {
  kioskTimer.hide();

  // Evict blob URLs from strip cache before revoking
  sessionState.shots.forEach((s) => {
    if (s.imageUrl) {
      if (typeof stripModule !== "undefined") stripModule._imageCache.delete(s.imageUrl);
      URL.revokeObjectURL(s.imageUrl);
    }
    if (s.videoUrl) {
      if (typeof stripModule !== "undefined") stripModule._imageCache.delete(s.videoUrl);
      URL.revokeObjectURL(s.videoUrl);
    }
  });

  // Flipbook cleanup — revoke the 3 recorded-clip URLs; flipbookFrames are
  // plain Blobs (no object URL made for them until preview/print time, and
  // flipbookPreviewModule/_teardownUrls handles those separately).
  (sessionState.flipbookVideos || []).forEach((clip) => {
    if (clip.videoUrl) URL.revokeObjectURL(clip.videoUrl);
  });
  if (typeof flipbookPreviewModule !== "undefined") flipbookPreviewModule.teardown();
  if (typeof printingModule !== "undefined" && printingModule._flipAnimator) {
    printingModule._flipAnimator.teardown();
    printingModule._flipAnimator = null;
  }
  sessionState._isFlipbook           = false;
  sessionState.flipbookVideos        = [];
  sessionState.selectedFlipbookVideo = null;
  sessionState.flipbookFrames        = [];

  // Mark ticket as COMPLETED before resetting (fire-and-forget)
  if (sessionState.ticketId) {
    queueTickets.completeTicket(sessionState.ticketId).catch((e) => {
      console.warn("[resetSession] Could not complete ticket:", e.message || e);
    });
  }

  sessionState.id        = Date.now().toString(36);
  sessionState.frameType = null;
  sessionState.quantity  = 1;
  sessionState.shots     = [];
  sessionState.selectedShots = [];
  sessionState.design    = null;
  sessionState.finalStripPng   = null;
  sessionState.finalStripVideo = null;
  sessionState.printReadyPng   = null;
  sessionState.galleryUrl = null;
  sessionState.galleryUrlPromise = null;
  sessionState.uploadPromise     = null;

  // Reset ticket state
  sessionState.ticketId       = null;
  sessionState.ticketNumber   = null;
  sessionState.ticketLine     = null;
  sessionState.ticketCopies   = null;
  sessionState.ticketFrame    = null;
  sessionState.ticketKeychain = null;

  // Reset add-on / keychain state
  sessionState.addonChoice           = "none";
  sessionState.keychainAddonSelected = false;
  sessionState._isKeychain           = false;

  // Cancel the 30s QR countdown and hide it, in case reset was triggered
  // some other way while it was still running.
  uploadProgress.cancelTimer();
  const wrap = document.getElementById("uploadProgressWrap");
  if (wrap) {
    wrap.setAttribute("hidden", "");
    wrap.classList.remove("complete", "error", "has-progress");
  }
  const bar = document.getElementById("uploadProgressBar");
  if (bar) bar.style.width = "0%";

  // Reset Template Selection UI (new Page 2)
  sessionState.quantity = 1;
  const btnNextFromTemplate = document.getElementById("btnNextFromTemplate");
  if (btnNextFromTemplate) btnNextFromTemplate.disabled = true;
  const templateSelectedName = document.getElementById("templateSelectedName");
  if (templateSelectedName) templateSelectedName.textContent = "No template selected";
  const templateSelectedSize = document.getElementById("templateSelectedSize");
  if (templateSelectedSize) templateSelectedSize.textContent = "";
  // Reset carousel offset, active category tab, and re-render
  if (typeof templateModule !== "undefined") {
    if (typeof templateModule.resetCategory === "function") templateModule.resetCategory();
    if (typeof templateModule.refresh      === "function") templateModule.refresh();
  }

  // Printing page always keeps white grid-bg — no yellow wave to reset

  // Reset QR wrap state
  const qrUploading = document.getElementById("qrUploading");
  if (qrUploading) qrUploading.style.display = "";
  const qrCodeCanvas = document.getElementById("qrCodeCanvas");
  if (qrCodeCanvas) qrCodeCanvas.innerHTML = "";

  // Wrap in try/catch so a camera error never prevents returning to page 1.
  try {
    cameraController.attachPreview(setupEls.video, setupEls.img);
  } catch (e) {
    console.warn("[resetSession] attachPreview failed (non-fatal):", e.message || e);
  }

  // Reset ticket scan UI (kept in case queue is re-enabled later)
  if (typeof kioskQrScanner !== "undefined") {
    try { kioskQrScanner.reset(); } catch (e) { /* no-op when bypassed */ }
  }

  // Return to the Queue / QR ticket page for the next guest.
  goToPage("ticket");
}

/* Frame thumbnail stubs — kept for any script that reads these paths */
(function() {
  const t2 = document.getElementById("frameThumb2x6");
  const t4 = document.getElementById("frameThumb4x6");
  if (t2) t2.src = "assets/designs/thumbnail/2x6_Strip_Thumbnail.png";
  if (t4) t4.src = "assets/designs/thumbnail/4x6_Strip_Thumbnail.png";
})();

/* Page 4 overlay removed — overlay not used in this design. */

/* Strip overlay removed — not used in this design. */

/* ── Page 3: Photos Taken counter ──────────────────────────────────────── */
/*
 * Dormant since the guest-triggered shutter rewrite (shooting.js v4):
 * shooting.js now writes #photosTakenCount / #photosTakenLabel directly
 * itself (see _updatePhotosTakenUI()) and no longer sets #shotCounter's
 * textContent at all, so this patched setter is never triggered. Left in
 * place (harmless) rather than removed, in case something upstream still
 * writes to #shotCounter in the future.
 *
 * Original note: shooting.js used to update .shot-counter (hidden); this
 * patched the hidden element's textContent setter so any write to it also
 * updated the visible right-panel counter.
 */
(function patchShotCounter() {
  const shotCounterEl = document.getElementById("shotCounter");
  const photosTakenEl = document.getElementById("photosTakenCount");
  const photosTakenLabelEl = document.getElementById("photosTakenLabel");
  if (!shotCounterEl || !photosTakenEl) return;

  const _origSet = Object.getOwnPropertyDescriptor(Node.prototype, "textContent").set;
  Object.defineProperty(shotCounterEl, "textContent", {
    set(val) {
      _origSet.call(this, val);
      // Parse "PHOTO X OF Y" — update the side counter
      const m = String(val).match(/(\d+)\s*OF\s*(\d+)/i);
      if (m) {
        // Minor Fix: counter now shows the CURRENT photo number (1..8),
        // matching the flipbook video counter's "current take" behavior —
        // no longer offset by 1 to show a completed-count instead.
        const taken = parseInt(m[1], 10);
        const total = parseInt(m[2], 10);
        photosTakenEl.innerHTML =
          `${taken}<span class="photos-taken-slash">/</span><span class="photos-taken-total">${total}</span>`;
        // Label text is now static ("Photo") per Minor Fix — no longer
        // overwritten with "Photos X/Y" here.
      }
    },
    get() { return shotCounterEl.innerText; }
  });
})();

/* ── Page 3: Show pose overlay for 4×6 only ────────────────────────────── */
function _updatePoseOverlay() {
  const overlay = document.getElementById("poseOverlay4x6");
  if (overlay) overlay.style.display = sessionState.frameType === "4x6" ? "block" : "none";

  // Stamp the live-preview frame with the active frame type so CSS can size
  // it correctly for 4×6 templates (see #shootingPreviewFrame[data-frame="4x6"]).
  const previewFrame = document.getElementById("shootingPreviewFrame");
  if (previewFrame) previewFrame.dataset.frame = sessionState.frameType || "2x6";
}

/* ── Page 6: Printing status subtitle update ────────────────────────────── */
/*
 * Patch uploadProgress.start() to update the subtitle to show uploading state,
 * and uploadProgress.complete() to update to printing state.
 */
const _origUploadStart = uploadProgress.start.bind(uploadProgress);
uploadProgress.start = function(...args) {
  _origUploadStart(...args);
  const sub = document.getElementById("printingStatusSubtitle");
  if (sub) sub.textContent = "Uploading your photos & video…";
  // Always keep white grid-bg — no yellow wave effect
};

const _origUploadComplete = uploadProgress.complete.bind(uploadProgress);
uploadProgress.complete = function(...args) {
  _origUploadComplete(...args);
  const sub = document.getElementById("printingStatusSubtitle");
  if (sub) sub.textContent = "Your photo is now printing at the counter.";
  // No yellow wave — white grid-bg is maintained throughout

  // Minor Fix: qr_code.wav plays the moment the printer tells the guest
  // their photo is now printing at the counter.
  if (typeof audioManager !== "undefined") {
    audioManager.playQrCode();
  }
};
