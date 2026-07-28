/*
 * STUDIO BOOTH PRINT AGENT
 * -------------------------------------------------------------------------
 * A tiny local service that runs on the kiosk Raspberry Pi alongside
 * Chromium. The kiosk web app (index.html / admin.html, served from GitHub
 * Pages) is just static JS in a browser — it has no way to talk to CUPS,
 * enumerate printers, or send a print job without a dialog. This agent
 * fills that gap: it listens on localhost, and the browser POSTs finished
 * print-ready images to it, which it hands straight to CUPS via `lp`.
 *
 * Zero npm dependencies on purpose — this only needs to run `node server.js`
 * on a fresh Pi with no `npm install` step to go wrong.
 *
 * Endpoints (all on http://localhost:PORT):
 *   GET  /health          -> { ok, agentPrinter, cupsDefault }
 *   GET  /printers        -> { printers: [{ name, status, isCupsDefault }], configured }
 *   GET  /config          -> { printer }
 *   POST /config          { printer } -> { ok, printer }
 *   POST /print?copies=N&printer=NAME   body: raw image/png bytes
 *                          -> { ok, jobId, printer }
 *
 * CORS: the kiosk page is served over https:// from GitHub Pages, so
 * requests to this http://localhost agent are cross-origin from the
 * browser's point of view. Chrome exempts requests TO localhost/127.0.0.1
 * from mixed-content blocking, but Private Network Access (PNA) preflights
 * still need an explicit allow — both are handled below.
 */

const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const CONFIG_DIR = path.join(os.homedir(), ".studio-booth-print-agent");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25MB — generous headroom for a 2400x3600 PNG

/* ---------------------------------------------------------------- config */

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { printer: parsed.printer || null };
  } catch (e) {
    return { printer: null };
  }
}

function writeConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

/* ------------------------------------------------------------ CUPS calls */

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr && stderr.trim() ? stderr.trim() : err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/* Parses `lpstat -p -d` output into a printer list + the CUPS system
 * default. Typical lines:
 *   "printer Canon_SELPHY_CP1300 is idle.  enabled since ..."
 *   "system default destination: Canon_SELPHY_CP1300"          */
async function listCupsPrinters() {
  let stdout;
  try {
    stdout = await run("lpstat", ["-p", "-d"]);
  } catch (e) {
    // lpstat exits non-zero if there are no printers configured at all —
    // treat that as an empty list rather than a hard failure.
    return { printers: [], cupsDefault: null };
  }

  const printers = [];
  let cupsDefault = null;

  stdout.split("\n").forEach((line) => {
    const printerMatch = line.match(/^printer\s+(\S+)\s+is\s+(\w+)/);
    if (printerMatch) {
      printers.push({ name: printerMatch[1], status: printerMatch[2] });
      return;
    }
    const defaultMatch = line.match(/system default destination:\s*(\S+)/);
    if (defaultMatch) {
      cupsDefault = defaultMatch[1];
    }
  });

  printers.forEach((p) => { p.isCupsDefault = p.name === cupsDefault; });
  return { printers, cupsDefault };
}

function resolveTargetPrinter(override, configured, cupsDefault) {
  return override || configured || cupsDefault || null;
}

async function sendToLp(filePath, printerName, copies) {
  const args = ["-d", printerName, "-n", String(Math.max(1, copies || 1)), filePath];
  const stdout = await run("lp", args);
  // "request id is Canon_SELPHY_CP1300-42 (1 file(s))"
  const idMatch = stdout.match(/request id is (\S+)/);
  return idMatch ? idMatch[1] : stdout.trim();
}

/* -------------------------------------------------------------- HTTP glue */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function applyCors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Chrome's Private Network Access policy: a public https:// page (the
  // GitHub Pages kiosk) fetching a private-network target (this agent, even
  // on localhost) needs this on the preflight response or the real request
  // gets blocked before it ever reaches us.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const buf = await readRawBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw new Error("Invalid JSON body");
  }
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      const config = readConfig();
      const { cupsDefault } = await listCupsPrinters();
      sendJson(res, 200, { ok: true, agentPrinter: config.printer, cupsDefault });
      return;
    }

    if (req.method === "GET" && url.pathname === "/printers") {
      const config = readConfig();
      const { printers, cupsDefault } = await listCupsPrinters();
      sendJson(res, 200, { printers, cupsDefault, configured: config.printer });
      return;
    }

    if (req.method === "GET" && url.pathname === "/config") {
      sendJson(res, 200, readConfig());
      return;
    }

    if (req.method === "POST" && url.pathname === "/config") {
      const body = await readJsonBody(req);
      if (!body.printer || typeof body.printer !== "string") {
        sendJson(res, 400, { error: "Body must include a non-empty 'printer' string" });
        return;
      }
      const config = { printer: body.printer };
      writeConfig(config);
      sendJson(res, 200, { ok: true, printer: config.printer });
      return;
    }

    if (req.method === "POST" && url.pathname === "/print") {
      const copies = Number(url.searchParams.get("copies")) || 1;
      const printerOverride = url.searchParams.get("printer") || null;

      const imageBuffer = await readRawBody(req, MAX_BODY_BYTES);
      if (!imageBuffer.length) {
        sendJson(res, 400, { error: "Empty print request body" });
        return;
      }

      const config = readConfig();
      const { cupsDefault, printers } = await listCupsPrinters();
      const targetPrinter = resolveTargetPrinter(printerOverride, config.printer, cupsDefault);

      if (!targetPrinter) {
        sendJson(res, 400, {
          error: "No printer configured. Set one from Admin \u2192 Printer Setup, or " +
                 "configure a CUPS default printer."
        });
        return;
      }
      if (printers.length && !printers.some((p) => p.name === targetPrinter)) {
        sendJson(res, 400, { error: `Printer "${targetPrinter}" is not known to CUPS.` });
        return;
      }

      const tmpFile = path.join(os.tmpdir(), `studio-booth-${crypto.randomUUID()}.png`);
      fs.writeFileSync(tmpFile, imageBuffer);

      try {
        const jobId = await sendToLp(tmpFile, targetPrinter, copies);
        sendJson(res, 200, { ok: true, jobId, printer: targetPrinter, copies });
      } finally {
        fs.unlink(tmpFile, () => {});
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("[print-agent] Error handling", req.method, url.pathname, "-", e.message);
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[print-agent] Listening on http://localhost:${PORT}`);
  console.log(`[print-agent] Config file: ${CONFIG_PATH}`);
});
