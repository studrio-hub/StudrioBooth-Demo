/*
 * QUEUE-TICKET-KIOSK.JS — Kiosk QR Ticket Scanner & Validation
 * ──────────────────────────────────────────────────────────────────────────────
 * Handles Page 1 (QR Ticket Scan):
 *
 * INPUT PRIORITY:
 *   1. USB HID QR scanner  — always active, captures keyboard-emulated input.
 *   2. Camera QR scanner   — live feed fallback using jsQR, draws from the
 *                            same stream as the main camera (Canon DSLR via
 *                            camera-controller / Electron, or browser webcam).
 *
 * The USB scanner fires immediately on scan. If a USB scan is detected,
 * camera decode is paused for 2s to avoid a double-trigger.
 *
 * CAMERA FEED STRATEGY:
 *   - First tries  cameraController.attachPreview() (re-uses the Electron/
 *     Canon bridge stream — no second stream opened, no conflicts).
 *   - Falls back to navigator.mediaDevices.getUserMedia() (browser webcam).
 *   - If neither works, hides the camera panel gracefully.
 *
 * DEPENDS ON:
 *   cloud-storage.js  (provides getSupabaseClient / CLOUD_CONFIG)
 *   queue-ticket.js   (provides queueTickets)
 *   app.js            (provides sessionState, goToPage, kioskTimer)
 *   camera-controller.js (optional — used when available)
 *   jsQR              (loaded via CDN — window.jsQR)
 *
 * PUBLIC API (window.kioskQrScanner):
 *   kioskQrScanner.init()   — call once on boot
 *   kioskQrScanner.reset()  — return to idle state
 *   kioskQrScanner.focus()  — refocus the hidden input
 */

const kioskQrScanner = (() => {
  "use strict";

  // ── Constants ───────────────────────────────────────────────────────────────
  const BUFFER_TIMEOUT_MS   = 350;   // HID scanner finishes within ~200 ms
  const USB_COOLDOWN_MS     = 2000;  // Pause camera decode after a USB scan
  const CAMERA_SCAN_RATE_MS = 150;   // How often to grab a video frame for jsQR
  const ERROR_DISPLAY_MS    = 3000;  // How long error state shows before resetting

  // ── State ───────────────────────────────────────────────────────────────────
  let _usbBuffer      = "";
  let _usbTimer       = null;
  let _validating     = false;
  let _validated      = false;
  let _usbCooldown    = false;

  let _camStream      = null;  // MediaStream (if getUserMedia fallback used)
  let _camAnimFrame   = null;  // requestAnimationFrame handle for jsQR decode
  let _camScanTimer   = null;  // setInterval handle
  let _usingCamCtrl   = false; // true when using cameraController stream

  // ── DOM refs (lazy — resolved after DOMContentLoaded) ────────────────────
  const $ = (id) => document.getElementById(id);

  // ── Panel state ─────────────────────────────────────────────────────────────
  function _setState(state) {
    const panel = $("ticketInfoPanel");
    if (!panel) return;
    panel.classList.remove("idle", "loading", "validated", "error");
    panel.classList.add(state);
  }

  function _setError(msg) {
    _setState("error");
    const el = $("ticketErrorMsg");
    if (el) el.textContent = msg || "Something went wrong. Please try again.";
    setTimeout(() => {
      if (!_validated) {
        _setState("idle");
        _usbBuffer  = "";
        _validating = false;
        _restartCameraScan();
        focus();
      }
    }, ERROR_DISPLAY_MS);
  }

  // ── Activate / deactivate NEXT ───────────────────────────────────────────
  function _activateNext() {
    const btn = $("btnNextFromTicket");
    if (!btn) return;
    btn.disabled = false;
    btn.classList.add("activated");
  }

  function _deactivateNext() {
    const btn = $("btnNextFromTicket");
    if (!btn) return;
    btn.disabled = true;
    btn.classList.remove("activated");
  }

  // ── Render validated ticket ──────────────────────────────────────────────
  function _renderTicket(ticket) {
    const qn   = $("ticketQueueNumber");
    const ql   = $("ticketQueueLine");
    const crow = $("ticketCopiesRow");

    if (qn) qn.textContent = String(ticket.queue_number);
    if (ql) ql.textContent = ticket.queue_line || "Main";

    if (crow) {
      const copies = ticket.copies || 1;
      const badges = [`<span class="ticket-badge">${copies} Cop${copies !== 1 ? "ies" : "y"}</span>`];
      if (ticket.frame_addon > 0)
        badges.push(`<span class="ticket-badge addon">+${ticket.frame_addon} Frame${ticket.frame_addon !== 1 ? "s" : ""}</span>`);
      if (ticket.keychain_addon > 0)
        badges.push(`<span class="ticket-badge addon">+${ticket.keychain_addon} Keychain${ticket.keychain_addon !== 1 ? "s" : ""}</span>`);
      crow.innerHTML = badges.join("");
    }
  }

  // ── Apply ticket to sessionState ────────────────────────────────────────
  function _applyToSession(ticket) {
    sessionState.ticketId       = ticket.id;
    sessionState.ticketNumber   = ticket.queue_number;
    sessionState.ticketLine     = ticket.queue_line;
    sessionState.ticketCopies   = ticket.copies;
    sessionState.ticketFrame    = ticket.frame_addon || 0;
    sessionState.ticketKeychain = ticket.keychain_addon || 0;
    sessionState.quantity       = ticket.copies || 1;

    const qtyEl = $("qtyValue");
    if (qtyEl) qtyEl.textContent = sessionState.quantity;
    if (typeof updateFramePricing === "function") updateFramePricing();
  }

  // ── Core validation (shared by USB + camera paths) ──────────────────────
  async function _validate(rawId) {
    if (!rawId || _validating || _validated) return;
    console.log("[kioskQrScanner] Validating:", rawId);

    _validating = true;
    _stopCameraScan();        // pause camera while we await
    _setState("loading");

    try {
      const result = await queueTickets.validateTicketForKiosk(rawId);

      if (!result.ok) {
        _setError(result.reason);
        _validating = false;
        return;
      }

      // ── SUCCESS ──
      _validated  = true;
      _validating = false;
      _applyToSession(result.ticket);
      _renderTicket(result.ticket);

      // Hide the camera feed on success
      const camWrap = $("ticketCamWrap");
      if (camWrap) camWrap.hidden = true;

      _setState("validated");
      _activateNext();

    } catch (e) {
      console.error("[kioskQrScanner] Validation error:", e);
      _setError("Unexpected error. Please try again or see staff.");
      _validating = false;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // USB HID SCANNER
  // ════════════════════════════════════════════════════════════════════════════

  function _flushUsbBuffer() {
    const raw = _usbBuffer.trim();
    _usbBuffer = "";
    _usbTimer  = null;
    if (!raw) return;

    _usbCooldown = true;
    setTimeout(() => { _usbCooldown = false; }, USB_COOLDOWN_MS);

    _validate(raw);
  }

  function _onUsbInput(e) {
    const ticketPage = $("page-ticket");
    if (!ticketPage?.classList.contains("active")) return;
    if (_validated) return;

    _usbBuffer += e.target.value;
    e.target.value = "";

    if (_usbTimer) clearTimeout(_usbTimer);
    _usbTimer = setTimeout(_flushUsbBuffer, BUFFER_TIMEOUT_MS);
  }

  function _onUsbKeydown(e) {
    const ticketPage = $("page-ticket");
    if (!ticketPage?.classList.contains("active")) return;
    if (e.key === "Enter" && _usbBuffer.trim()) {
      if (_usbTimer) clearTimeout(_usbTimer);
      _flushUsbBuffer();
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CAMERA QR SCANNING (jsQR)
  // ════════════════════════════════════════════════════════════════════════════

  /*
   * _startCameraFeed — acquires a camera stream and wires it to the preview
   * <video> element inside the ticket page.
   *
   * Strategy:
   *   1. If cameraController exists and has an active stream, clone it —
   *      no duplicate getUserMedia call, fully compatible with Canon/DSLR.
   *   2. Otherwise open a browser webcam stream (getUserMedia).
   *   3. If neither is possible, hide the camera panel.
   */
  async function _startCameraFeed() {
    const video   = $("ticketCamVideo");
    const camWrap = $("ticketCamWrap");
    if (!video || !camWrap) return;

    // ── Try cameraController first ──────────────────────────────────────────
    if (typeof cameraController !== "undefined") {
      try {
        // attachPreview hooks the existing stream into the video element
        // and returns cleanly even if the Canon is the source.
        await cameraController.attachPreview(video, null);

        // Verify the video is actually playing
        await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error("video timeout")), 3000);
          video.onloadedmetadata = () => { clearTimeout(t); res(); };
          if (video.readyState >= 1) { clearTimeout(t); res(); }
        });

        _usingCamCtrl = true;
        camWrap.hidden = false;
        console.log("[kioskQrScanner] Camera feed via cameraController.");
        _startCameraScan(video);
        return;
      } catch (e) {
        console.warn("[kioskQrScanner] cameraController.attachPreview failed:", e.message || e);
      }
    }

    // ── Fallback: browser getUserMedia ──────────────────────────────────────
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn("[kioskQrScanner] getUserMedia not available — camera scan disabled.");
      camWrap.hidden = true;
      const body = document.querySelector(".ticket-body");
      if (body) body.classList.add("no-cam");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      _camStream      = stream;
      video.srcObject = stream;
      await video.play();
      camWrap.hidden = false;
      console.log("[kioskQrScanner] Camera feed via getUserMedia.");
      _startCameraScan(video);
    } catch (e) {
      console.warn("[kioskQrScanner] getUserMedia failed:", e.message || e);
      camWrap.hidden = true;
      const body = document.querySelector(".ticket-body");
      if (body) body.classList.add("no-cam");
    }
  }

  /*
   * _startCameraScan — starts the jsQR decode loop.
   * Grabs a frame every CAMERA_SCAN_RATE_MS via a hidden canvas, runs jsQR.
   */
  function _startCameraScan(video) {
    if (!window.jsQR) {
      console.warn("[kioskQrScanner] jsQR not loaded — camera scan disabled.");
      return;
    }

    const canvas = $("ticketCamCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    function _scanFrame() {
      _camScanTimer = setTimeout(_doScan, CAMERA_SCAN_RATE_MS);
    }

    function _doScan() {
      const ticketPage = $("page-ticket");
      if (!ticketPage?.classList.contains("active") || _validated || _usbCooldown) {
        _scanFrame(); // keep ticking but skip decode
        return;
      }

      if (video.readyState < video.HAVE_ENOUGH_DATA) {
        _scanFrame();
        return;
      }

      const w = video.videoWidth  || 640;
      const h = video.videoHeight || 480;
      canvas.width  = w;
      canvas.height = h;

      try {
        ctx.drawImage(video, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: "dontInvert"
        });
        if (code?.data) {
          console.log("[kioskQrScanner] Camera decoded:", code.data);
          _validate(code.data);
          return; // _validate will restart scan if it fails
        }
      } catch (e) {
        // ignore decode errors silently
      }

      _scanFrame();
    }

    _scanFrame();
  }

  function _stopCameraScan() {
    if (_camScanTimer) { clearTimeout(_camScanTimer); _camScanTimer = null; }
  }

  function _restartCameraScan() {
    _stopCameraScan();
    const video = $("ticketCamVideo");
    if (video && (video.srcObject || _usingCamCtrl)) {
      // Already have a stream — just restart the decode loop
      _startCameraScan(video);
    }
  }

  function _stopCameraFeed() {
    _stopCameraScan();
    if (_camStream) {
      _camStream.getTracks().forEach(t => t.stop());
      _camStream = null;
    }
    // Don't stop cameraController stream — it's shared with page-setup
    const video = $("ticketCamVideo");
    if (video && !_usingCamCtrl) {
      video.srcObject = null;
    }
    _usingCamCtrl = false;
  }

  // ── Maintain focus on the hidden USB input ───────────────────────────────
  function _maintainFocus() {
    const ticketPage = $("page-ticket");
    if (!ticketPage?.classList.contains("active")) return;
    const inp = $("ticketQrInput");
    if (inp && document.activeElement !== inp) {
      inp.focus({ preventScroll: true });
    }
  }

  // ── NEXT button ──────────────────────────────────────────────────────────
  function _onNext() {
    if (!_validated) return;
    if (typeof kioskTimer !== "undefined") kioskTimer.hide();
    _stopCameraScan(); // keep stream alive for page-setup, just stop decode
    goToPage("frame");
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════════════════════

  function init() {
    const inp  = $("ticketQrInput");
    const next = $("btnNextFromTicket");

    if (!inp) {
      console.warn("[kioskQrScanner] #ticketQrInput not found.");
      return;
    }

    // USB scanner events
    inp.addEventListener("input",   _onUsbInput);
    inp.addEventListener("keydown", _onUsbKeydown);

    // NEXT
    if (next) next.addEventListener("click", _onNext);

    // Maintain focus every 500 ms
    setInterval(_maintainFocus, 500);

    // Refocus on page click (while idle)
    const ticketPage = $("page-ticket");
    if (ticketPage) {
      ticketPage.addEventListener("click", () => {
        if (ticketPage.classList.contains("active") && !_validated) focus();
      });
    }

    // Start camera feed
    _startCameraFeed();

    console.log("[kioskQrScanner] Initialized.");
  }

  function reset() {
    _usbBuffer  = "";
    _validating = false;
    _validated  = false;
    _usbCooldown = false;

    if (_usbTimer) { clearTimeout(_usbTimer); _usbTimer = null; }

    // Stop scan loop but keep stream alive for re-use
    _stopCameraScan();

    _setState("idle");
    _deactivateNext();

    // Show camera feed again
    const camWrap = $("ticketCamWrap");
    if (camWrap) camWrap.hidden = false;

    // Restart decode loop
    const video = $("ticketCamVideo");
    if (video && (video.srcObject || _usingCamCtrl)) {
      _startCameraScan(video);
    } else {
      // Stream was stopped — reacquire
      _startCameraFeed();
    }

    const inp = $("ticketQrInput");
    if (inp) inp.value = "";
  }

  function focus() {
    const inp = $("ticketQrInput");
    if (inp) { try { inp.focus({ preventScroll: true }); } catch (_) {} }
  }

  return { init, reset, focus };
})();

// Auto-init
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", kioskQrScanner.init);
} else {
  kioskQrScanner.init();
}
