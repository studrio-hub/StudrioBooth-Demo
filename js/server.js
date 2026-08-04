#!/usr/bin/env node
"use strict";

/*
 * STUDRIO BOOTH — Unified Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Single Node process, single HTTPS port (3000), covering:
 *
 *   • Static file server  — serves the kiosk HTML/CSS/JS from ./  (localhost)
 *   • Camera agent        — gphoto2 live preview, still capture
 *   • Print agent         — CUPS printer management, print jobs
 *   • Template sync API   — pulls templates table from Supabase, caches assets
 *
 * Why one process / one port?
 *   - Simpler launcher (one command, one PID to manage on both Windows/WSL
 *     and Raspberry Pi)
 *   - Chrome kiosk only needs to trust one self-signed cert
 *   - No inter-process communication between camera/print agents needed
 *
 * URL layout:
 *   GET  /                         → index.html (kiosk UI)
 *   GET  /health                   → { ok, camera, printer }
 *   GET  /camera/status            → { connected, model, port }
 *   GET  /camera/live-preview      → MJPEG stream
 *   GET  /camera/frame             → single JPEG (for canvas recording)
 *   POST /camera/capture           → JPEG buffer
 *   POST /camera/video/start       → { ok }  (no-op, browser handles recording)
 *   POST /camera/video/stop        → { ok }  (no-op)
 *   GET  /printers                 → { printers, cupsDefault, configured }
 *   GET  /printer/config           → { printer }
 *   POST /printer/config           → { ok, printer }
 *   POST /print?copies=N           → { ok, jobId, printer }
 *   GET  /sync/templates           → [ { id, name, type, version, ... } ]
 *   GET  /sync/asset?path=…        → proxies Supabase public asset download
 *
 * HTTPS: self-signed cert auto-generated on first run via openssl.
 * Chrome cert warning is expected — accept once at https://localhost:3000/health.
 */

const https              = require("https");
const { exec, spawn, execSync } = require("child_process");
const fs                 = require("fs");
const path               = require("path");
const os                 = require("os");
const crypto             = require("crypto");

// ── Constants ─────────────────────────────────────────────────────────────────

const PORT              = process.env.PORT ? Number(process.env.PORT) : 3000;
const KIOSK_ROOT        = __dirname;           // serves static files from here
const AGENT_DIR         = __dirname;
const CERT_PATH         = path.join(AGENT_DIR, "cert.pem");
const KEY_PATH          = path.join(AGENT_DIR, "key.pem");
const PRINT_CONFIG_DIR  = path.join(os.homedir(), ".studrio-booth-print");
const PRINT_CONFIG_PATH = path.join(PRINT_CONFIG_DIR, "config.json");
const TMP_DIR           = os.tmpdir();

const MAX_BROADCAST_FPS         = 15;
const CAPTURE_TIMEOUT           = 15000;
const MAX_PRINT_BODY_BYTES      = 25 * 1024 * 1024; // 25 MB
const GPHOTO2                   = "gphoto2";
const PREVIEW_LOOP_BACKOFF_MS   = [200, 200, 300, 500, 800, 1000];
const PREVIEW_LOOP_REDETECT_AFTER = 20;

// Supabase config — read from environment or config file so credentials stay
// out of the source tree on production devices.
// Set SUPABASE_URL and SUPABASE_ANON_KEY environment variables before starting,
// or create supabase.config.json in the project root:
//   { "url": "https://…supabase.co", "anonKey": "eyJ…" }
let _supabaseCfg = { url: null, anonKey: null };
try {
  const cfgPath = path.join(KIOSK_ROOT, "supabase.config.json");
  if (fs.existsSync(cfgPath)) {
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    _supabaseCfg = { url: raw.url || null, anonKey: raw.anonKey || null };
  }
} catch (_) {}
const SUPABASE_URL      = process.env.SUPABASE_URL      || _supabaseCfg.url;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || _supabaseCfg.anonKey;
const TEMPLATES_BUCKET  = "photobooth";          // same bucket, templates/ prefix

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`[studrio] ${msg}`); }
function warn(msg) { console.warn(`[studrio] WARN ${msg}`); }
function err(msg)  { console.error(`[studrio] ERROR ${msg}`); }

// ── TLS cert ──────────────────────────────────────────────────────────────────

function ensureCert() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
      log("TLS cert found ✓");
      resolve();
      return;
    }
    log("Generating self-signed TLS cert...");
    const cmd = [
      "openssl req -x509 -newkey rsa:2048 -nodes",
      `-keyout "${KEY_PATH}"`,
      `-out "${CERT_PATH}"`,
      `-days 3650`,
      `-subj "/CN=localhost"`,
      `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`
    ].join(" ");
    exec(cmd, { timeout: 15000 }, (error) => {
      if (error) { reject(new Error(`TLS cert generation failed: ${error.message}`)); return; }
      log("TLS cert generated ✓");
      resolve();
    });
  });
}

// ── CORS ──────────────────────────────────────────────────────────────────────

function setCorsHeaders(res, req) {
  const origin = (req && req.headers && req.headers.origin) || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

// ── Body helpers ──────────────────────────────────────────────────────────────

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("Request body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const buf = await readRawBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString("utf8")); }
  catch (e) { throw new Error("Invalid JSON body"); }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

// ── Static file server ────────────────────────────────────────────────────────

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".mp4":  "video/mp4",
  ".webm": "video/webm",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
};

function serveStaticFile(req, res, urlPath) {
  // Sanitise: prevent directory traversal
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = path.join(KIOSK_ROOT, safePath);

  // If requesting a directory, try index.html inside it
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  if (!fs.existsSync(filePath)) return false;

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  const stat = fs.statSync(filePath);

  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": stat.size,
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600"
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// ── Camera state ──────────────────────────────────────────────────────────────

let _cameraModel      = null;
let _cameraPort       = null;
let _previewClients   = [];
let _captureInFlight  = false;
let _movieProc        = null;
let _movieBuffer      = Buffer.alloc(0);
let _lastBroadcastMs  = 0;
let _framesSinceStart = 0;
let _stallWatchdogId  = null;
let _lastFrame        = null;   // latest JPEG buffer for /camera/frame
let _usePreviewLoop   = false;
let _previewLoopActive = false;

// ── Camera: gphoto2 helpers ───────────────────────────────────────────────────

function detectCamera() {
  return new Promise((resolve) => {
    exec(`${GPHOTO2} --auto-detect`, { timeout: 8000 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      const lines = stdout.split("\n").slice(2);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^(.+?)\s{2,}(usb:[0-9,]+|ptpip:[^\s]+)$/);
        if (match) { resolve({ model: match[1].trim(), port: match[2].trim() }); return; }
      }
      resolve(null);
    });
  });
}

function prepareCameraForLiveView() {
  const commands = [
    `${GPHOTO2} --set-config capturetarget=0`,
    `${GPHOTO2} --set-config viewfinder=1`,
    `${GPHOTO2} --set-config eosviewfinder=1`
  ];
  return commands.reduce(
    (chain, cmd) => chain.then(() => new Promise((resolve) => {
      exec(cmd, { timeout: 5000 }, () => resolve());
    })),
    Promise.resolve()
  );
}

// ── Camera: Mode A — --capture-movie (DSLRs: 70D, 200D) ──────────────────────

async function startMovieStream() {
  if (_movieProc) return;
  if (_previewLoopActive) return;
  await prepareCameraForLiveView();
  if (_movieProc || _previewLoopActive) return;
  if (_usePreviewLoop) { startPreviewLoop(); } else { startCaptureMovie(); }
}

function startCaptureMovie() {
  log("Starting movie stream (--capture-movie)...");
  _movieBuffer = Buffer.alloc(0);
  _framesSinceStart = 0;
  _movieProc = spawn(GPHOTO2, ["--capture-movie", "--stdout", "--quiet"]);
  const startedProc = _movieProc;

  _movieProc.stdout.on("data", (chunk) => { processMovieChunk(chunk); });
  _movieProc.stderr.on("data", (d) => {
    const text = d.toString();
    if (/error/i.test(text)) warn(`movie stderr: ${text.trim()}`);
  });
  _movieProc.on("close", (code) => {
    if (_movieProc === startedProc) _movieProc = null;
    _movieBuffer = Buffer.alloc(0);
    clearStallWatchdog();
    if (_framesSinceStart === 0) {
      warn("--capture-movie produced 0 frames. Switching to preview loop mode.");
      _usePreviewLoop = true;
      if (_previewClients.length > 0) {
        setTimeout(() => {
          if (_previewClients.length > 0 && !_movieProc && !_previewLoopActive) startPreviewLoop();
        }, 300);
      }
    } else {
      if (_previewClients.length > 0) {
        setTimeout(() => {
          if (_previewClients.length > 0 && !_movieProc && !_previewLoopActive) startMovieStream();
        }, 1000);
      }
    }
  });
  _movieProc.on("error", (e) => {
    err(`Movie stream error: ${e.message}`);
    if (_movieProc === startedProc) _movieProc = null;
    clearStallWatchdog();
  });

  clearStallWatchdog();
  _stallWatchdogId = setTimeout(() => {
    if (_movieProc === startedProc && _framesSinceStart === 0 && _previewClients.length > 0) {
      warn("No frames in 6s from --capture-movie. Switching to preview loop...");
      stopMovieStream();
      _usePreviewLoop = true;
      setTimeout(() => {
        if (_previewClients.length > 0 && !_previewLoopActive) startPreviewLoop();
      }, 300);
    }
  }, 6000);
}

// ── Camera: Mode B — --capture-preview loop (mirrorless: M50) ────────────────

async function startPreviewLoop() {
  if (_previewLoopActive) return;
  _previewLoopActive = true;
  _framesSinceStart = 0;
  log("Starting preview loop (--capture-preview, M50/mirrorless)...");
  let consecutiveFailures = 0;

  while (_previewLoopActive && _previewClients.length > 0) {
    if (_captureInFlight) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    const frame = await capturePreviewFrame();
    if (frame) {
      if (_framesSinceStart === 0) log("First preview frame — stream is live.");
      _framesSinceStart++;
      consecutiveFailures = 0;
      broadcastFrame(frame);
    } else {
      consecutiveFailures++;
      if (consecutiveFailures % 25 === 0) {
        warn(`${consecutiveFailures} consecutive preview failures.`);
      }
      if (consecutiveFailures === PREVIEW_LOOP_REDETECT_AFTER) {
        const stillThere = await detectCamera();
        if (!stillThere) {
          warn("Camera no longer detected — stopping preview loop.");
          _cameraModel = null; _cameraPort = null;
          break;
        }
      }
      const backoffIdx = Math.min(consecutiveFailures, PREVIEW_LOOP_BACKOFF_MS.length - 1);
      await new Promise((r) => setTimeout(r, PREVIEW_LOOP_BACKOFF_MS[backoffIdx]));
    }
  }

  _previewLoopActive = false;
  log("Preview loop stopped.");
}

function capturePreviewFrame() {
  return new Promise((resolve) => {
    const chunks = [];
    let stderr = "";
    const proc = spawn(GPHOTO2, [
      "--set-config", "capturetarget=0",
      "--set-config", "eosviewfinder=1",
      "--capture-preview", "--stdout", "--quiet"
    ]);
    proc.stdout.on("data", (chunk) => chunks.push(chunk));
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0 && chunks.length > 0) { resolve(Buffer.concat(chunks)); }
      else { if (stderr.trim()) warn(`capture-preview failed: ${stderr.trim()}`); resolve(null); }
    });
    proc.on("error", (e) => { warn(`capture-preview spawn error: ${e.message}`); resolve(null); });
    setTimeout(() => { proc.kill(); resolve(null); }, 3000);
  });
}

function clearStallWatchdog() {
  if (_stallWatchdogId) { clearTimeout(_stallWatchdogId); _stallWatchdogId = null; }
}

function stopMovieStream() {
  if (_movieProc) {
    const proc = _movieProc; _movieProc = null;
    clearStallWatchdog();
    proc.kill();
    _movieBuffer = Buffer.alloc(0);
  }
  if (_previewLoopActive) { _previewLoopActive = false; }
}

function stopMovieStreamAsync() {
  return new Promise((resolve) => {
    if (_previewLoopActive) {
      _previewLoopActive = false;
      log("Stopping preview loop...");
      setTimeout(resolve, 500);
      return;
    }
    if (!_movieProc) { resolve(); return; }
    log("Stopping movie stream (waiting for release)...");
    const proc = _movieProc; _movieProc = null;
    _movieBuffer = Buffer.alloc(0);
    clearStallWatchdog();
    let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(); };
    proc.once("close", finish);
    proc.once("error", finish);
    proc.kill();
    setTimeout(finish, 2000);
  });
}

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const MJPEG_BOUNDARY = "studiobooth_frame";

function processMovieChunk(chunk) {
  _movieBuffer = Buffer.concat([_movieBuffer, chunk]);
  if (_movieBuffer.length > 4_000_000) { _movieBuffer = Buffer.alloc(0); return; }
  while (true) {
    const soi = _movieBuffer.indexOf(JPEG_SOI);
    if (soi === -1) break;
    const eoi = _movieBuffer.indexOf(JPEG_EOI, soi + 2);
    if (eoi === -1) { if (soi > 0) _movieBuffer = _movieBuffer.slice(soi); break; }
    const frame = _movieBuffer.slice(soi, eoi + 2);
    _movieBuffer = _movieBuffer.slice(eoi + 2);
    broadcastFrame(frame);
  }
}

function broadcastFrame(frame) {
  _framesSinceStart++;
  _lastFrame = frame;  // always update for /camera/frame single-image endpoint

  if (_previewClients.length === 0) return;
  if (_captureInFlight) return;
  const now = Date.now();
  if (now - _lastBroadcastMs < 1000 / MAX_BROADCAST_FPS) return;
  _lastBroadcastMs = now;

  const header = [
    `--${MJPEG_BOUNDARY}`,
    "Content-Type: image/jpeg",
    `Content-Length: ${frame.length}`,
    "", ""
  ].join("\r\n");
  const packet = Buffer.concat([Buffer.from(header, "ascii"), frame, Buffer.from("\r\n", "ascii")]);
  _previewClients = _previewClients.filter((res) => {
    try { res.write(packet); return true; } catch (e) { return false; }
  });
}

// ── Camera: still capture ─────────────────────────────────────────────────────

async function capturePhoto() {
  const wasStreaming = !!_movieProc || _previewLoopActive;
  await stopMovieStreamAsync();
  await new Promise((r) => setTimeout(r, 250));

  return new Promise((resolve, reject) => {
    const outPath = path.join(TMP_DIR, `studrio_capture_${Date.now()}.jpg`);
    const args = ["--capture-image-and-download", `--filename=${outPath}`, "--force-overwrite", "--quiet"];
    const proc = spawn(GPHOTO2, args);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      const restore = () => { if (wasStreaming && _previewClients.length > 0) startMovieStream(); };
      if (code !== 0) { restore(); reject(new Error(`gphoto2 capture failed (exit ${code}): ${stderr}`)); return; }
      if (!fs.existsSync(outPath)) {
        restore(); reject(new Error(`gphoto2 reported success but no file written. stderr: ${stderr}`)); return;
      }
      fs.readFile(outPath, (readErr, data) => {
        fs.unlink(outPath, () => {});
        restore();
        if (readErr) { reject(readErr); return; }
        resolve(data);
      });
    });
    proc.on("error", (e) => {
      if (wasStreaming && _previewClients.length > 0) startMovieStream();
      reject(e);
    });
    setTimeout(() => { proc.kill(); reject(new Error("Capture timed out")); }, CAPTURE_TIMEOUT);
  });
}

// ── Print agent: config ───────────────────────────────────────────────────────

function readPrintConfig() {
  try { return JSON.parse(fs.readFileSync(PRINT_CONFIG_PATH, "utf8")); }
  catch (e) { return { printer: null }; }
}

function writePrintConfig(config) {
  fs.mkdirSync(PRINT_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PRINT_CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

// ── Print agent: CUPS ─────────────────────────────────────────────────────────

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const { execFile } = require("child_process");
    execFile(cmd, args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(stderr && stderr.trim() ? stderr.trim() : error.message)); return; }
      resolve(stdout);
    });
  });
}

async function listCupsPrinters() {
  let stdout;
  try { stdout = await runCmd("lpstat", ["-p", "-d"]); }
  catch (e) { return { printers: [], cupsDefault: null }; }
  const printers = [];
  let cupsDefault = null;
  stdout.split("\n").forEach((line) => {
    const pm = line.match(/^printer\s+(\S+)\s+is\s+(\w+)/);
    if (pm) { printers.push({ name: pm[1], status: pm[2] }); return; }
    const dm = line.match(/system default destination:\s*(\S+)/);
    if (dm) cupsDefault = dm[1];
  });
  printers.forEach((p) => { p.isCupsDefault = p.name === cupsDefault; });
  return { printers, cupsDefault };
}

async function sendToLp(filePath, printerName, copies) {
  const args = ["-d", printerName, "-n", String(Math.max(1, copies || 1)), filePath];
  const stdout = await runCmd("lp", args);
  const idMatch = stdout.match(/request id is (\S+)/);
  return idMatch ? idMatch[1] : stdout.trim();
}

// ── Template sync: Supabase REST helpers ──────────────────────────────────────
// The server uses the Supabase REST API directly (no npm SDK) to keep
// zero npm dependencies. Templates table is read with the anon key
// (public read RLS policy) — same pattern as the browser-side client.

function supabaseFetch(endpoint, opts = {}) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return Promise.reject(new Error("Supabase not configured"));
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + (parsedUrl.search || ""),
      method: opts.method || "GET",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        ...(opts.headers || {})
      }
    };
    const lib = require(parsedUrl.protocol === "https:" ? "https" : "http");
    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

// Downloads a file from a public URL and returns its buffer.
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = require(parsedUrl.protocol === "https:" ? "https" : "http");
    lib.get(url, (res) => {
      if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode} fetching ${url}`)); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

// Fetches the templates list from Supabase (enabled only, ordered by sort_order)
async function fetchTemplatesFromSupabase() {
  const { status, data } = await supabaseFetch(
    "templates?select=*&order=sort_order.asc,created_at.asc"
  );
  if (status !== 200) throw new Error(`Supabase templates fetch failed: ${status}`);
  return Array.isArray(data) ? data : [];
}

// Returns the public URL for a Supabase Storage asset
function getSupabasePublicUrl(storagePath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${TEMPLATES_BUCKET}/${storagePath}`;
}

// ── Request router ────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  setCorsHeaders(res, req);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const urlObj = new URL(req.url, `https://localhost:${PORT}`);
  const urlPath = urlObj.pathname;

  // ── Health ──────────────────────────────────────────────────────────────────
  if (req.method === "GET" && urlPath === "/health") {
    const printConfig = readPrintConfig();
    const { cupsDefault } = await listCupsPrinters().catch(() => ({ cupsDefault: null }));
    sendJson(res, 200, {
      ok: true,
      camera: { model: _cameraModel, connected: !!_cameraModel },
      printer: { configured: printConfig.printer, cupsDefault }
    });
    return;
  }

  // ── Camera: status ──────────────────────────────────────────────────────────
  if (req.method === "GET" && urlPath === "/camera/status") {
    const camera = await detectCamera();
    if (camera) {
      _cameraModel = camera.model; _cameraPort = camera.port;
      sendJson(res, 200, { connected: true, model: camera.model, port: camera.port, connection: "USB / Tethered (gphoto2)" });
    } else {
      _cameraModel = null; _cameraPort = null;
      sendJson(res, 200, { connected: false, model: null, port: null, connection: null });
    }
    return;
  }

  // ── Camera: MJPEG live preview ──────────────────────────────────────────────
  if (req.method === "GET" && urlPath === "/camera/live-preview") {
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace;boundary=${MJPEG_BOUNDARY}`,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Connection": "keep-alive"
    });
    _previewClients.push(res);
    log(`Preview client connected (${_previewClients.length} active)`);
    startMovieStream();
    req.on("close", () => {
      _previewClients = _previewClients.filter((r) => r !== res);
      log(`Preview client disconnected (${_previewClients.length} active)`);
      if (_previewClients.length === 0) stopMovieStream();
    });
    return;
  }

  // ── Camera: single JPEG frame (for canvas recording, avoids MJPEG taint) ───
  if (req.method === "GET" && urlPath === "/camera/frame") {
    if (_lastFrame) {
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": _lastFrame.length,
        "Cache-Control": "no-cache"
      });
      res.end(_lastFrame);
    } else {
      sendJson(res, 503, { error: "No frame available yet" });
    }
    return;
  }

  // ── Camera: still capture ───────────────────────────────────────────────────
  if (req.method === "POST" && urlPath === "/camera/capture") {
    if (_captureInFlight) { sendJson(res, 409, { error: "Capture already in progress" }); return; }
    _captureInFlight = true;
    log("Capture triggered");
    try {
      const jpegBuffer = await capturePhoto();
      log(`Capture complete — ${jpegBuffer.length} bytes`);
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": jpegBuffer.length });
      res.end(jpegBuffer);
    } catch (e) {
      err(`Capture failed: ${e.message}`);
      sendJson(res, 500, { error: e.message });
    } finally {
      _captureInFlight = false;
    }
    return;
  }

  // ── Camera: video start/stop no-ops (browser handles recording) ─────────────
  if (req.method === "POST" && (urlPath === "/camera/video/start" || urlPath === "/camera/video/stop")) {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── Print: list printers ────────────────────────────────────────────────────
  if (req.method === "GET" && urlPath === "/printers") {
    const config = readPrintConfig();
    const { printers, cupsDefault } = await listCupsPrinters().catch(() => ({ printers: [], cupsDefault: null }));
    sendJson(res, 200, { printers, cupsDefault, configured: config.printer });
    return;
  }

  // ── Print: get/set config ───────────────────────────────────────────────────
  if (req.method === "GET" && urlPath === "/printer/config") {
    sendJson(res, 200, readPrintConfig());
    return;
  }
  if (req.method === "POST" && urlPath === "/printer/config") {
    const body = await readJsonBody(req);
    if (!body.printer || typeof body.printer !== "string") {
      sendJson(res, 400, { error: "Body must include a non-empty 'printer' string" }); return;
    }
    writePrintConfig({ printer: body.printer });
    sendJson(res, 200, { ok: true, printer: body.printer });
    return;
  }

  // ── Print: send job ─────────────────────────────────────────────────────────
  if (req.method === "POST" && urlPath === "/print") {
    const copies        = Number(urlObj.searchParams.get("copies")) || 1;
    const printerOverride = urlObj.searchParams.get("printer") || null;
    const imageBuffer   = await readRawBody(req, MAX_PRINT_BODY_BYTES);
    if (!imageBuffer.length) { sendJson(res, 400, { error: "Empty print request body" }); return; }

    const config = readPrintConfig();
    const { cupsDefault, printers } = await listCupsPrinters().catch(() => ({ cupsDefault: null, printers: [] }));
    const targetPrinter = printerOverride || config.printer || cupsDefault || null;
    if (!targetPrinter) {
      sendJson(res, 400, { error: "No printer configured. Set one from Admin → Printer Setup." }); return;
    }
    if (printers.length && !printers.some((p) => p.name === targetPrinter)) {
      sendJson(res, 400, { error: `Printer "${targetPrinter}" is not known to CUPS.` }); return;
    }
    const tmpFile = path.join(TMP_DIR, `studrio-print-${crypto.randomUUID()}.png`);
    fs.writeFileSync(tmpFile, imageBuffer);
    try {
      const jobId = await sendToLp(tmpFile, targetPrinter, copies);
      sendJson(res, 200, { ok: true, jobId, printer: targetPrinter, copies });
    } finally {
      fs.unlink(tmpFile, () => {});
    }
    return;
  }

  // ── Sync: templates list ────────────────────────────────────────────────────
  // The kiosk calls this on startup to get the latest template metadata.
  // Returns the full templates array from Supabase (anon read, no auth needed).
  if (req.method === "GET" && urlPath === "/sync/templates") {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      sendJson(res, 503, { error: "Supabase not configured on this server" }); return;
    }
    try {
      const templates = await fetchTemplatesFromSupabase();
      sendJson(res, 200, templates);
    } catch (e) {
      err(`Templates sync failed: ${e.message}`);
      sendJson(res, 502, { error: e.message });
    }
    return;
  }

  // ── Sync: asset proxy download ──────────────────────────────────────────────
  // The kiosk calls GET /sync/asset?path=templates/... to download an asset.
  // The server fetches it from Supabase Storage and streams it back, so the
  // browser never has to talk to Supabase directly for asset downloads.
  if (req.method === "GET" && urlPath === "/sync/asset") {
    const assetPath = urlObj.searchParams.get("path");
    if (!assetPath || assetPath.includes("..")) {
      sendJson(res, 400, { error: "Invalid asset path" }); return;
    }
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      sendJson(res, 503, { error: "Supabase not configured on this server" }); return;
    }
    try {
      const publicUrl = getSupabasePublicUrl(assetPath);
      const buffer = await fetchUrl(publicUrl);
      const ext = path.extname(assetPath).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Content-Length": buffer.length, "Cache-Control": "public, max-age=86400" });
      res.end(buffer);
    } catch (e) {
      err(`Asset proxy failed for ${assetPath}: ${e.message}`);
      sendJson(res, 502, { error: e.message });
    }
    return;
  }

  // ── Static files ────────────────────────────────────────────────────────────
  // Serve the kiosk app from the project root.
  // API routes above take priority; everything else falls through to static.
  const served = serveStaticFile(req, res, urlPath === "/" ? "/index.html" : urlPath);
  if (!served) {
    // For SPA-style sub-paths (e.g. /admin/, /g/), fall back to their index.html
    const dirIndex = serveStaticFile(req, res, urlPath + "/index.html");
    if (!dirIndex) {
      sendJson(res, 404, { error: "Not found" });
    }
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  await ensureCert();

  const tlsOptions = {
    key:  fs.readFileSync(KEY_PATH),
    cert: fs.readFileSync(CERT_PATH)
  };

  const server = https.createServer(tlsOptions, (req, res) => {
    handleRequest(req, res).catch((e) => {
      err(`Unhandled error: ${e.message}`);
      try { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
      catch (_) {}
    });
  });

  server.listen(PORT, "127.0.0.1", async () => {
    log(`Studrio Booth server running on https://localhost:${PORT}`);
    log(`Serving kiosk from: ${KIOSK_ROOT}`);
    log(`Platform: ${os.platform()} ${os.arch()}`);

    try { execSync(`which ${GPHOTO2}`, { stdio: "pipe" }); log("gphoto2 found ✓"); }
    catch (e) { warn("gphoto2 not found. Run: sudo apt install gphoto2"); }

    const camera = await detectCamera();
    if (camera) {
      _cameraModel = camera.model; _cameraPort = camera.port;
      log(`Camera detected: ${camera.model} on ${camera.port} ✓`);
    } else {
      warn("No camera detected. Connect a DSLR via USB.");
    }

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      warn("Supabase not configured — template sync disabled.");
      warn("Create supabase.config.json or set SUPABASE_URL + SUPABASE_ANON_KEY env vars.");
    } else {
      log("Supabase configured — template sync enabled ✓");
    }

    log("─────────────────────────────────────────────────────");
    log("ONE-TIME SETUP: Accept the self-signed cert in Chrome:");
    log(`  Open https://localhost:${PORT}/health`);
    log('  Click "Advanced" → "Proceed to localhost (unsafe)"');
    log("─────────────────────────────────────────────────────");
    log(`Kiosk UI: https://localhost:${PORT}/`);
    log(`Admin:    https://localhost:${PORT}/admin/`);
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      err(`Port ${PORT} already in use. Kill it: fuser -k ${PORT}/tcp`);
    } else {
      err(`Server error: ${e.message}`);
    }
    process.exit(1);
  });

  function shutdown() {
    log("Shutting down...");
    stopMovieStream();
    server.close();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT",  shutdown);
}

main().catch((e) => { err(`Startup failed: ${e.message}`); process.exit(1); });
