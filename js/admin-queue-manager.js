/*
 * ADMIN-QUEUE-MANAGER.JS — Studrio Admin Queue Management Tab
 * ──────────────────────────────────────────────────────────────────────────────
 * Provides the Queue tab in the admin dashboard (dashboard.html).
 *
 * Features:
 *   • Generate tickets: Next Number, Queue Line, Copies, Add-ons (Frame, Keychain)
 *   • Shows QR code modal after ticket creation (uses qrcodejs)
 *   • Live queue view with realtime Supabase subscription
 *   • Call Next — calls the first WAITING ticket in the selected line
 *   • Put On Hold — moves CALLED ticket to ON_HOLD
 *   • Restore from Hold — places held ticket back after current serving
 *   • Cancel ticket
 *   • Shows add-on details per ticket
 *
 * Depends on:
 *   cloud-storage.js  (getSupabaseClient, CLOUD_CONFIG)
 *   queue-ticket.js   (queueTickets)
 *   qrcodejs          (loaded via CDN in dashboard.html)
 *
 * Call queueManager.init() once after auth is confirmed.
 */

const queueManager = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  let _queue        = [];
  let _channel      = null;
  let _activeFilter = "all"; // "all" or a queue line name
  let _lines        = new Set(["Booth", "Drop"]);

  // ── Daily queue-number reset ───────────────────────────────────────────────
  // Stores today's date (YYYY-MM-DD) in localStorage; if stale, resets counters.
  const _RESET_KEY = "studrio_queue_last_reset";
  function _checkDailyReset() {
    const today = new Date().toISOString().slice(0, 10); // "2025-08-16"
    const last  = localStorage.getItem(_RESET_KEY);
    if (last !== today) {
      localStorage.setItem(_RESET_KEY, today);
      // Notify any listeners that today is a fresh day.
      // Actual ticket-number sequencing starts from 1 in queueTickets.createTicket
      // because the Supabase query counts only today's tickets (see queue-ticket.js).
      console.info("[queueManager] New day detected — queue numbers reset to #1.");
    }
  }

  // ── Toast (shared with admin-dashboard.js) ─────────────────────────────────
  function showToast(msg, duration = 3500) {
    const toast = document.getElementById("adminToast");
    if (!toast) { alert(msg); return; }
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, duration);
  }

  // ── HTML injection ─────────────────────────────────────────────────────────
  function _injectHTML() {
    const container = document.getElementById("queueSection");
    if (!container) return;

    container.innerHTML = `
      <style>
        /* Cancel Session button — distinct from plain Cancel to prevent accidental taps */
        .btn-queue-cancel-session {
          background: transparent;
          color: #c0392b;
          border: 1.5px solid #c0392b;
          font-size: 11px;
          font-weight: 700;
          padding: 4px 10px;
          border-radius: 6px;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.15s, color 0.15s;
        }
        .btn-queue-cancel-session:hover {
          background: #c0392b;
          color: #fff;
        }
        /* IN_SESSION ticket row gets a subtle left border accent */
        .queue-ticket-item[data-status="IN_SESSION"] {
          border-left: 3px solid #f39c12;
        }
      </style>
      <div class="queue-layout">

        <!-- Left: Generate ticket -->
        <div class="queue-gen-card">
          <div class="queue-gen-title">Generate Ticket</div>

          <div class="form-group" style="margin-bottom:14px">
            <label>Queue Line</label>
            <select id="genQueueLine" class="admin-input">
              <option value="Booth">Booth</option>
              <option value="Drop">Drop</option>
            </select>
          </div>

          <div class="form-group" style="margin-bottom:14px">
            <label>Copies</label>
            <input
              type="number"
              id="genCopies"
              class="admin-input"
              value="1"
              min="1"
              max="20"
            >
          </div>

          <div class="form-group" style="margin-bottom:14px">
            <label>Price <span style="color:#9e9e9e;font-weight:400">(₱)</span></label>
            <input
              type="number"
              id="genPrice"
              class="admin-input"
              value="0"
              min="0"
              step="0.01"
              placeholder="e.g. 250"
            >
          </div>

          <div class="form-group" style="margin-bottom:14px">
            <label>Frame Add-on <span style="color:#9e9e9e;font-weight:400">(paid)</span></label>
            <input
              type="number"
              id="genFrameAddon"
              class="admin-input"
              value="0"
              min="0"
              max="99"
              placeholder="Quantity"
            >
          </div>

          <div class="form-group" style="margin-bottom:20px">
            <label>Keychain Add-on <span style="color:#9e9e9e;font-weight:400">(paid)</span></label>
            <input
              type="number"
              id="genKeychainAddon"
              class="admin-input"
              value="0"
              min="0"
              max="99"
              placeholder="Quantity"
            >
          </div>

          <button class="btn-admin btn-admin-primary btn-full" id="btnGenerateTicket">
            Generate &amp; Print QR
          </button>

          <p class="form-hint" style="margin-top:8px">
            Ticket is created as WAITING. Call it when the customer is ready.
          </p>
        </div>

        <!-- Right: Active queue -->
        <div class="queue-active-card">
          <div class="queue-active-head">
            <div>
              <div class="queue-active-title">
                <span class="queue-conn-dot" id="queueConnDot"></span>
                Live Queue
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <div class="queue-line-filter">
                <label style="font-size:12px;font-weight:600;color:#666">Line:</label>
                <select id="queueLineFilter">
                  <option value="all">All Lines</option>
                </select>
              </div>
              <button class="btn-admin btn-admin-primary btn-sm" id="btnCallNext">
                ▶ Call Next
              </button>
              <button class="btn-admin btn-admin-ghost btn-sm" id="btnRefreshQueue">
                ↻ Refresh
              </button>
            </div>
          </div>

          <!-- Call bar: shows next in line -->
          <div class="queue-call-bar" id="queueCallBar" style="display:none">
            <div class="queue-call-bar-info">
              <div class="queue-call-bar-label">Next in Line</div>
              <div class="queue-call-bar-next" id="queueCallBarNext">—</div>
            </div>
          </div>

          <!-- Ticket list -->
          <div class="queue-ticket-list" id="queueTicketList">
            <div class="queue-empty">Loading queue…</div>
          </div>
        </div>

      </div>

      <!-- QR Modal -->
      <div class="queue-qr-modal-overlay" id="queueQrModal" style="display:none">
        <div class="queue-qr-modal">
          <div class="queue-qr-modal-number" id="qrModalNumber">—</div>
          <div class="queue-qr-modal-line"   id="qrModalLine">—</div>
          <div class="queue-qr-canvas"       id="qrModalCanvas"></div>
          <div class="queue-qr-id"           id="qrModalId"></div>
          <div class="queue-qr-meta"         id="qrModalMeta"></div>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
            <button class="btn-admin btn-admin-primary" id="btnPrintQr">Print</button>
            <button class="btn-admin btn-admin-ghost"   id="btnCloseQr">Close</button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Render queue list ──────────────────────────────────────────────────────
  function _renderQueue() {
    const list = document.getElementById("queueTicketList");
    if (!list) return;

    let filtered = _queue;
    if (_activeFilter !== "all") {
      filtered = _queue.filter(t => t.queue_line === _activeFilter);
    }

    // Update call bar
    const nextWaiting = filtered.find(t => t.status === "WAITING");
    const callBar   = document.getElementById("queueCallBar");
    const callBarNext = document.getElementById("queueCallBarNext");
    if (callBar && callBarNext) {
      if (nextWaiting) {
        callBar.style.display = "";
        callBarNext.textContent = `#${nextWaiting.queue_number} — ${nextWaiting.queue_line}`;
      } else {
        callBar.style.display = "none";
      }
    }

    if (!filtered.length) {
      list.innerHTML = '<div class="queue-empty">Queue is empty</div>';
      return;
    }

    list.innerHTML = filtered.map(t => _renderTicketItem(t)).join("");

    // Wire action buttons
    list.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", () => _handleAction(btn.dataset.action, btn.dataset.id));
    });
  }

  function _addonText(t) {
    const parts = [];
    if (t.copies)         parts.push(`${t.copies} cop${t.copies !== 1 ? "ies" : "y"}`);
    if (t.frame_addon)    parts.push(`${t.frame_addon} frame${t.frame_addon !== 1 ? "s" : ""}`);
    if (t.keychain_addon) parts.push(`${t.keychain_addon} keychain${t.keychain_addon !== 1 ? "s" : ""}`);
    return parts.join(", ") || "1 copy";
  }

  function _renderTicketItem(t) {
    const statusClass = t.status;
    const actions = [];

    if (t.status === "CALLED") {
      actions.push(`<button class="btn-queue btn-queue-hold" data-action="hold" data-id="${_esc(t.id)}">On Hold</button>`);
    }
    if (t.status === "ON_HOLD") {
      actions.push(`<button class="btn-queue btn-queue-restore" data-action="restore" data-id="${_esc(t.id)}">Restore</button>`);
    }
    if (t.status === "WAITING" || t.status === "CALLED" || t.status === "ON_HOLD") {
      actions.push(`<button class="btn-queue btn-queue-cancel" data-action="cancel" data-id="${_esc(t.id)}">Cancel</button>`);
    }
    if (t.status === "IN_SESSION") {
      // Uses a distinct action key so the handler shows a confirmation prompt
      // before cancelling a session that is actively in progress on the kiosk.
      actions.push(`<button class="btn-queue btn-queue-cancel-session" data-action="cancel-session" data-id="${_esc(t.id)}">Cancel Session</button>`);
    }

    return `
      <div class="queue-ticket-item" data-status="${statusClass}" data-id="${_esc(t.id)}">
        <span class="queue-ticket-num">${t.queue_number}</span>
        <div class="queue-ticket-info">
          <div class="queue-ticket-line-name">${_esc(t.queue_line)}</div>
          <div class="queue-ticket-addons">${_esc(_addonText(t))}</div>
          <div class="queue-ticket-meta">${_esc(t.id)}</div>
        </div>
        <span class="queue-ticket-status ${statusClass}">${_formatStatus(t.status)}</span>
        <div class="queue-ticket-actions">${actions.join("")}</div>
      </div>
    `;
  }

  function _formatStatus(s) {
    const map = {
      WAITING: "Waiting",
      CALLED: "Called",
      ON_HOLD: "On Hold",
      IN_SESSION: "In Session",
      COMPLETED: "Done",
      CANCELLED: "Cancelled"
    };
    return map[s] || s;
  }

  function _esc(str) {
    return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // ── Update line filter dropdown ────────────────────────────────────────────
  function _updateLineFilter() {
    const sel = document.getElementById("queueLineFilter");
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = `<option value="all">All Lines</option>` +
      Array.from(_lines).map(l => `<option value="${_esc(l)}"${l === current ? " selected" : ""}>${_esc(l)}</option>`).join("");
  }

  // ── _callNextForLine ────────────────────────────────────────────────────────
  // Calls the next WAITING ticket. If line is null, picks the globally next
  // ticket (lowest queue_number across all lines that have no active ticket).
  async function _callNextForLine(line) {
    if (line) {
      return queueTickets.callNext(line);
    }
    // "All lines" mode: find each line that has WAITING tickets but no
    // CALLED/IN_SESSION ticket, then call the one with the lowest queue_number.
    const waiting = _queue.filter(t => t.status === "WAITING");
    if (!waiting.length) return null;

    // Group by line — skip lines that already have someone CALLED/IN_SESSION
    const busyLines = new Set(
      _queue
        .filter(t => t.status === "CALLED" || t.status === "IN_SESSION")
        .map(t => t.queue_line)
    );

    const eligibleWaiting = waiting.filter(t => !busyLines.has(t.queue_line));
    if (!eligibleWaiting.length) return null;

    // Pick the globally lowest queue_number among eligible lines
    eligibleWaiting.sort((a, b) => a.queue_number - b.queue_number);
    return queueTickets.callNext(eligibleWaiting[0].queue_line);
  }

  // ── Action handlers ────────────────────────────────────────────────────────
  async function _handleAction(action, id) {
    try {
      if (action === "hold") {
        await queueTickets.holdTicket(id);
        showToast("Ticket placed on hold.");

        // Auto-advance: call the next WAITING ticket in the same line
        const held = _queue.find(t => t.id === id);
        if (held) {
          const nextCalled = await _callNextForLine(held.queue_line);
          if (nextCalled) showToast(`Called #${nextCalled.queue_number}.`);
        }
      }

      if (action === "restore") {
        await queueTickets.restoreHeld(id);
        showToast("Ticket restored — placed after current.");
      }

      if (action === "cancel") {
        const cancelled = _queue.find(t => t.id === id);
        await queueTickets.cancelTicket(id);
        showToast("Ticket cancelled.");

        // Auto-advance: if the cancelled ticket was CALLED/IN_SESSION, call next
        if (cancelled && (cancelled.status === "CALLED" || cancelled.status === "IN_SESSION")) {
          const nextCalled = await _callNextForLine(cancelled.queue_line);
          if (nextCalled) showToast(`Called #${nextCalled.queue_number}.`);
        }
      }

      if (action === "cancel-session") {
        const ticket = _queue.find(t => t.id === id);
        const label  = ticket ? `#${ticket.queue_number} (${ticket.queue_line})` : id;

        // Confirm before interrupting an active kiosk session
        const confirmed = window.confirm(
          `Cancel the IN-SESSION ticket ${label}?\n\nThis will mark the ticket as cancelled and call the next guest in line.`
        );
        if (!confirmed) return; // bail — skip _loadQueue below

        await queueTickets.cancelTicket(id);
        showToast(`Session for ${label} cancelled.`);

        // Auto-advance: call next WAITING ticket in the same line
        if (ticket) {
          const nextCalled = await _callNextForLine(ticket.queue_line);
          if (nextCalled) showToast(`Called #${nextCalled.queue_number}.`);
        }
      }

      await _loadQueue();
    } catch (e) {
      showToast("Error: " + (e.message || e));
    }
  }

  // ── Load queue from Supabase ───────────────────────────────────────────────
  async function _loadQueue() {
    try {
      _queue = await queueTickets.listActive();
      // Collect known lines
      _queue.forEach(t => _lines.add(t.queue_line));
      _updateLineFilter();
      _renderQueue();
      _setConn(true);
    } catch (e) {
      console.error("[queueManager] Load failed:", e.message || e);
      _setConn(false);
    }
  }

  // ── Connection indicator ───────────────────────────────────────────────────
  function _setConn(ok) {
    const dot = document.getElementById("queueConnDot");
    if (!dot) return;
    dot.className = "queue-conn-dot " + (ok ? "live" : "error");
  }

  // ── Realtime subscription ──────────────────────────────────────────────────
  function _subscribe() {
    if (_channel) { queueTickets.unsubscribe(_channel); _channel = null; }
    _channel = queueTickets.subscribeToQueue(async (payload) => {
      const prev   = payload?.old;
      const next   = payload?.new;

      // When a ticket moves to COMPLETED or CANCELLED from the kiosk side,
      // automatically call the next WAITING ticket in that line if nothing
      // is already CALLED or IN_SESSION there.
      if (
        next?.status === "COMPLETED" || next?.status === "CANCELLED"
      ) {
        const line = next.queue_line;
        // Refresh first so _queue reflects current state
        await _loadQueue();

        const lineHasActive = _queue.some(t =>
          t.queue_line === line &&
          (t.status === "CALLED" || t.status === "IN_SESSION")
        );
        if (!lineHasActive) {
          try {
            const called = await _callNextForLine(line);
            if (called) showToast(`Auto-called #${called.queue_number} — ${called.queue_line}`);
          } catch (_) {}
        }
      }

      await _loadQueue();
    });
  }

  // ── QR modal ───────────────────────────────────────────────────────────────
  function _showQrModal(ticket) {
    const modal  = document.getElementById("queueQrModal");
    const numEl  = document.getElementById("qrModalNumber");
    const lineEl = document.getElementById("qrModalLine");
    const canvas = document.getElementById("qrModalCanvas");
    const idEl   = document.getElementById("qrModalId");
    const metaEl = document.getElementById("qrModalMeta");

    if (!modal) return;

    numEl.textContent  = `#${ticket.queue_number}`;
    lineEl.textContent = ticket.queue_line || "Main";
    idEl.textContent   = ticket.id;

    const addons = [];
    if (ticket.copies > 1)      addons.push(`${ticket.copies} copies`);
    else                         addons.push("1 copy");
    if (ticket.frame_addon)     addons.push(`${ticket.frame_addon} frame${ticket.frame_addon !== 1 ? "s" : ""}`);
    if (ticket.keychain_addon)  addons.push(`${ticket.keychain_addon} keychain${ticket.keychain_addon !== 1 ? "s" : ""}`);
    if (ticket.price > 0)       addons.push(`₱${Number(ticket.price).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`);
    metaEl.textContent = addons.join(" · ");

    // Render QR
    canvas.innerHTML = "";
    if (typeof QRCode !== "undefined") {
      new QRCode(canvas, {
        text: ticket.id,
        width:  200,
        height: 200,
        colorDark:  "#1A1200",
        colorLight: "#FFFFFF",
        correctLevel: QRCode.CorrectLevel.M
      });
    } else {
      canvas.textContent = ticket.id;
    }

    modal.style.display = "flex";
  }

  function _hideQrModal() {
    const modal = document.getElementById("queueQrModal");
    if (modal) modal.style.display = "none";
    // Reload queue to reflect new ticket
    _loadQueue();
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function _wire() {
    // Generate ticket
    const btnGen = document.getElementById("btnGenerateTicket");
    if (btnGen) {
      btnGen.addEventListener("click", async () => {
        const line       = (document.getElementById("genQueueLine")?.value || "Booth").trim();
        const copies     = parseInt(document.getElementById("genCopies")?.value || "1", 10);
        const price      = parseFloat(document.getElementById("genPrice")?.value || "0") || 0;
        const frameAddon = parseInt(document.getElementById("genFrameAddon")?.value || "0", 10);
        const keychain   = parseInt(document.getElementById("genKeychainAddon")?.value || "0", 10);

        if (!line) { showToast("Please select a queue line."); return; }
        if (isNaN(copies) || copies < 1) { showToast("Copies must be at least 1."); return; }

        btnGen.disabled = true;
        btnGen.textContent = "Generating…";
        try {
          let ticket = await queueTickets.createTicket({
            queueLine: line,
            copies: Math.max(1, copies),
            price: Math.max(0, price),
            frameAddon: Math.max(0, frameAddon),
            keychainAddon: Math.max(0, keychain)
          });
          _lines.add(ticket.queue_line);
          _updateLineFilter();

          // Auto-call: if nothing is CALLED or IN_SESSION in this line,
          // immediately call this ticket so the customer can scan right away.
          const lineHasActive = _queue.some(t =>
            t.queue_line === line &&
            (t.status === "CALLED" || t.status === "IN_SESSION")
          );
          if (!lineHasActive) {
            try {
              const called = await queueTickets.callNext(line);
              if (called) {
                ticket = called; // show the now-CALLED ticket in the QR modal
                showToast(`Ticket #${ticket.queue_number} created & called — ready to scan!`);
              } else {
                showToast(`Ticket #${ticket.queue_number} created.`);
              }
            } catch (_autoCallErr) {
              showToast(`Ticket #${ticket.queue_number} created.`);
            }
          } else {
            showToast(`Ticket #${ticket.queue_number} added to queue.`);
          }

          await _loadQueue();
          _showQrModal(ticket);
        } catch (e) {
          showToast("Error creating ticket: " + (e.message || e));
        } finally {
          btnGen.disabled = false;
          btnGen.textContent = "Generate & Print QR";
        }
      });
    }

    // Call Next
    const btnCallNext = document.getElementById("btnCallNext");
    if (btnCallNext) {
      btnCallNext.addEventListener("click", async () => {
        // When "all lines" is selected, call next across all lines
        // by finding the WAITING ticket with the lowest queue_number overall.
        const line = _activeFilter === "all" ? null : _activeFilter;
        btnCallNext.disabled = true;
        try {
          const called = await _callNextForLine(line);
          if (called) {
            showToast(`Called #${called.queue_number} — ${called.queue_line}!`);
          } else {
            showToast("No one waiting in the queue.");
          }
          await _loadQueue();
        } catch (e) {
          showToast("Error: " + (e.message || e));
        } finally {
          btnCallNext.disabled = false;
        }
      });
    }

    // Refresh
    const btnRefresh = document.getElementById("btnRefreshQueue");
    if (btnRefresh) {
      btnRefresh.addEventListener("click", () => _loadQueue());
    }

    // Line filter
    const lineFilter = document.getElementById("queueLineFilter");
    if (lineFilter) {
      lineFilter.addEventListener("change", () => {
        _activeFilter = lineFilter.value;
        _renderQueue();
      });
    }

    // QR Modal: close
    const btnClose = document.getElementById("btnCloseQr");
    if (btnClose) btnClose.addEventListener("click", _hideQrModal);

    // QR Modal: print (58mm thermal layout)
    // ─────────────────────────────────────────────────────────────────────────
    // ROOT CAUSE OF "random text" / garbage output:
    //   window.open() + window.print() sends a Chromium-rendered PDF/raster to
    //   the Windows print spooler. The POS-58 11.2.0.0 driver installs as a
    //   generic text-only driver by default. When it receives a binary PDF
    //   stream it interprets the raw bytes as ASCII text and prints them
    //   literally — the "random text" you see.
    //
    // FIX — QZ Tray (primary path):
    //   QZ Tray is a free Java service that runs locally on the PC connected
    //   to the POS-58. The browser sends ESC/POS commands over WebSocket;
    //   QZ Tray forwards them raw to the driver, bypassing the PDF pipeline
    //   entirely. This is the industry-standard browser→thermal-printer solution.
    //   Download: https://qz.io/download/
    //
    // FALLBACK — canvas PNG via window.print():
    //   If QZ Tray is not running, we render the ticket to a <canvas>, export
    //   it as a PNG, and print that PNG in a popup window. A raster image
    //   avoids the "generic text" driver misinterpreting HTML/PDF, though the
    //   operator may still need to set the POS-58 driver to "POS Printer" (not
    //   "Generic Text Only") in Windows for images to print correctly.
    // ─────────────────────────────────────────────────────────────────────────
    const btnPrint = document.getElementById("btnPrintQr");
    if (btnPrint) {
      btnPrint.addEventListener("click", async () => {
        const qrCanvas = document.querySelector("#qrModalCanvas canvas");
        const num    = document.getElementById("qrModalNumber")?.textContent?.trim() || "";
        const line   = document.getElementById("qrModalLine")?.textContent?.trim() || "";
        const id     = document.getElementById("qrModalId")?.textContent?.trim() || "";
        const meta   = document.getElementById("qrModalMeta")?.textContent?.trim() || "";

        const metaParts  = meta.split(" · ");
        const copiesText = metaParts.find(p => p.includes("cop")) || "";
        const priceText  = metaParts.find(p => p.startsWith("₱")) || "";
        const addonParts = metaParts.filter(p => !p.includes("cop") && !p.startsWith("₱"));

        const now     = new Date();
        const dateStr = now.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
        const timeStr = now.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" });

        // ── Try QZ Tray first ─────────────────────────────────────────────────
        if (typeof qz !== "undefined" && qz.websocket) {
          try {
            await _printViaQzTray({ num, line, id, meta, copiesText, priceText, addonParts, dateStr, timeStr, qrCanvas });
            return; // success — done
          } catch (qzErr) {
            console.warn("[queueManager] QZ Tray print failed, falling back to canvas PNG:", qzErr);
          }
        }

        // ── Fallback: canvas PNG in popup ─────────────────────────────────────
        _printViaCanvasPng({ num, line, id, copiesText, priceText, addonParts, dateStr, timeStr, qrCanvas });
      });
    }

    // Close modal on overlay click
    const modal = document.getElementById("queueQrModal");
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) _hideQrModal();
      });
    }
  }

  // ── Ticket print helpers ────────────────────────────────────────────────────

  /*
   * _printViaQzTray({ num, line, id, copiesText, priceText, addonParts,
   *                   dateStr, timeStr, qrCanvas })
   *
   * Sends the ticket as ESC/POS commands to the POS-58 via QZ Tray WebSocket.
   * QZ Tray must be running on the PC that has the POS-58 connected.
   *
   * Setup (one-time):
   *   1. Download and install QZ Tray from https://qz.io/download/
   *   2. Start QZ Tray (it runs in the system tray).
   *   3. On first use, QZ Tray will prompt to trust this site — click Allow.
   *   4. The printer name in qz.printers.find() below must match the exact
   *      Windows printer name for the POS-58. Adjust the string if needed.
   *
   * Why ESC/POS and not window.print():
   *   The POS-58 driver installs as a generic text/passthrough driver on
   *   Windows. window.print() sends a Chromium-rendered PDF/raster; that
   *   driver interprets the binary PDF bytes as literal ASCII text and
   *   prints them as "random characters". ESC/POS bypasses the PDF pipeline
   *   and speaks the printer's native command language directly.
   */
  async function _printViaQzTray({ num, line, id, copiesText, priceText, addonParts, dateStr, timeStr, qrCanvas }) {
    // ── Connect ────────────────────────────────────────────────────────────
    if (!qz.websocket.isActive()) {
      await qz.websocket.connect();
    }

    // ── Find the POS-58 ───────────────────────────────────────────────────
    // qz.printers.find() returns an array of printer names matching the query.
    // "POS-58" is the typical Windows driver name — adjust if yours differs.
    let printerName = null;
    const candidates = ["POS-58", "POS58", "Thermal", "Receipt"];
    for (const cand of candidates) {
      const found = await qz.printers.find(cand);
      if (found && found.length) {
        printerName = Array.isArray(found) ? found[0] : found;
        break;
      }
    }
    if (!printerName) {
      // Last resort: list all printers and pick the first one
      const all = await qz.printers.find();
      printerName = Array.isArray(all) ? all[0] : all;
    }
    if (!printerName) throw new Error("No printer found via QZ Tray");

    const config = qz.configs.create(printerName, {
      language: "ESCP",     // ESC/POS passthrough
      encoding: "Cp437",    // standard IBM PC / thermal codepage
    });

    // ── Build ESC/POS command sequence ────────────────────────────────────
    // ESC/POS reference: https://reference.epson-biz.com/modules/ref_escpos/
    const ESC = "\x1B";
    const GS  = "\x1D";
    const LF  = "\x0A";

    const cmds = [];

    // Initialize printer — full reset clears any stale size/align state
    cmds.push({ type: "raw", format: "plain", data: `${ESC}@` });

    // ── POS-58 geometry ───────────────────────────────────────────────────────
    // 58mm paper at 203dpi = 464 printable dots.
    // Normal font (Font A) = 12 dots wide per char → 38 chars/line max.
    // Double-width font    = 24 dots/char           → 19 chars/line max.
    // Triple-width (GS!x2) = 36 dots/char           → 12 chars/line max.
    // Divider at normal size: 32 chars fits comfortably with small side margins.
    const DIV = "--------------------------------"; // 32 chars — fits 58mm

    // Center align
    cmds.push({ type: "raw", format: "plain", data: `${ESC}a\x01` });

    // Brand header — double-width + double-height (GS!\x11)
    // \x11 = 0b00010001 → width bits[0-2]=1 (×2), height bits[4-6]=1 (×2)
    // "STUDRIO BOOTH" = 13 chars × 2 = 26 — fits 58mm (max 19 double-width chars)
    cmds.push({ type: "raw", format: "plain", data: `${ESC}E\x01${GS}!\x11` });
    cmds.push({ type: "raw", format: "plain", data: "STUDRIO BOOTH" + LF });

    // Reset size, then sub-header — bold ON
    cmds.push({ type: "raw", format: "plain", data: `${GS}!\x00${ESC}E\x01` });
    cmds.push({ type: "raw", format: "plain", data: "Queue Ticket" + LF });
    // Divider — bold stays on
    cmds.push({ type: "raw", format: "plain", data: DIV + LF });
    cmds.push({ type: "raw", format: "plain", data: `${ESC}E\x00` }); // reset bold

    // Queue line — bold + double-width + double-height (GS!\x11 = ×2 width, ×2 height)
    cmds.push({ type: "raw", format: "plain", data: `${GS}!\x11${ESC}E\x01` });
    cmds.push({ type: "raw", format: "plain", data: line.toUpperCase() + LF });
    cmds.push({ type: "raw", format: "plain", data: `${GS}!\x00${ESC}E\x00` });

    // Big queue number — double-width + triple-height (GS!\x21)
    // \x21 = 0b00100001 → width ×2, height ×3 — tall and readable, won't overflow.
    // At ×2 width: "123" = 6 char-widths = 6×24 = 144px — centred on 464px, fine.
    cmds.push({ type: "raw", format: "plain", data: `${GS}!\x21${ESC}E\x01` });
    cmds.push({ type: "raw", format: "plain", data: num + LF });
    // Explicitly reset size AND bold before continuing
    cmds.push({ type: "raw", format: "plain", data: `${GS}!\x00${ESC}E\x00` });

    // QR code — native ESC/POS QR (Model 2, error level M)
    // Module size 4 = 4 × (1 dot at 203dpi ≈ 0.125mm) = 0.5mm/module.
    // UUID is 36 chars → ~Version 3 QR (29×29 modules) → 29 × 0.5mm = ~14.5mm.
    // That leaves generous margins on 58mm paper. Use size 5 for ~18mm — easier
    // to scan while still fitting comfortably within the printable width.
    const qrData   = id; // raw ticket UUID — what the kiosk scans
    const qrLen    = qrData.length + 3;
    const qrLenL   = qrLen & 0xFF;
    const qrLenH   = (qrLen >> 8) & 0xFF;

    cmds.push({ type: "raw", format: "plain", data:
      `${GS}(k\x04\x00\x31\x41\x32\x00` +   // Select Model 2
      `${GS}(k\x03\x00\x31\x45\x35` +        // Error level M (0x35)
      `${GS}(k\x03\x00\x31\x43\x05` +        // Module size 5 (≈18mm — fits 58mm)
      `${GS}(k` + String.fromCharCode(qrLenL, qrLenH) + `\x31\x50\x30` + qrData +
      `${GS}(k\x03\x00\x31\x51\x30`          // Print QR
    });
    cmds.push({ type: "raw", format: "plain", data: LF });

    // Divider — reset to normal size first (safety reset after QR block), bold ON
    cmds.push({ type: "raw", format: "plain", data: `${ESC}a\x01${GS}!\x00${ESC}E\x01` });
    cmds.push({ type: "raw", format: "plain", data: DIV + LF });
    cmds.push({ type: "raw", format: "plain", data: `${ESC}E\x00` }); // reset bold

    // Details — left-align, double-width + double-height (GS!\x11), bold ON for all rows.
    // ×2 width keeps lines readable; 58mm at ×2 = 19 chars max — short labels fit fine.
    cmds.push({ type: "raw", format: "plain", data: `${ESC}a\x00${GS}!\x11${ESC}E\x01` });
    if (copiesText) {
      cmds.push({ type: "raw", format: "plain", data: `Copies: ${copiesText}` + LF });
    }
    if (addonParts.length) {
      cmds.push({ type: "raw", format: "plain", data: `Add-ons: ${addonParts.join(", ")}` + LF });
    }
    if (priceText) {
      // Price is already bold — just print it
      cmds.push({ type: "raw", format: "plain", data: `Total: ${priceText}` + LF });
    }
    cmds.push({ type: "raw", format: "plain", data: `Date: ${dateStr}` + LF });
    cmds.push({ type: "raw", format: "plain", data: `Time: ${timeStr}` + LF });
    cmds.push({ type: "raw", format: "plain", data: `${GS}!\x00${ESC}E\x00` }); // reset size + bold

    // Divider — bold ON
    cmds.push({ type: "raw", format: "plain", data: `${ESC}a\x01${ESC}E\x01` });
    cmds.push({ type: "raw", format: "plain", data: DIV + LF });
    cmds.push({ type: "raw", format: "plain", data: `${ESC}E\x00` }); // reset bold

    // Ticket ID — normal size, bold ON for legibility
    cmds.push({ type: "raw", format: "plain", data: `${ESC}E\x01` });
    cmds.push({ type: "raw", format: "plain", data: id + LF });
    cmds.push({ type: "raw", format: "plain", data: `${ESC}E\x00` }); // reset bold

    // Footer — bold ON
    cmds.push({ type: "raw", format: "plain", data: `${ESC}E\x01` });
    cmds.push({ type: "raw", format: "plain", data: "Thank you! Please wait" + LF });
    cmds.push({ type: "raw", format: "plain", data: "for your number to be called." + LF });
    cmds.push({ type: "raw", format: "plain", data: `${ESC}E\x00` });

    // Feed and cut
    cmds.push({ type: "raw", format: "plain", data: LF + LF + LF });
    cmds.push({ type: "raw", format: "plain", data: `${GS}V\x41\x03` }); // partial cut

    // ── Send ──────────────────────────────────────────────────────────────
    await qz.print(config, cmds);
    console.log("[queueManager] Ticket sent to POS-58 via QZ Tray ✓");
  }

  /*
   * _printViaCanvasPng({ num, line, id, copiesText, priceText, addonParts,
   *                      dateStr, timeStr, qrCanvas })
   *
   * Renders the ticket onto a <canvas> at 203dpi equivalent (576px wide for
   * 58mm paper), exports it as a PNG, and opens a print popup with that image.
   *
   * This avoids the HTML→PDF→text-driver garbage issue because the popup
   * contains only a single <img> — no HTML text for the driver to misread.
   *
   * The operator still needs to:
   *   - Set the POS-58 driver type to "POS Printer" (not "Generic Text Only")
   *     in Windows Device Manager / Add Printer wizard.
   *   - Set paper size to 58mm × continuous in the driver's own preferences.
   *
   * QZ Tray is the preferred path — this is only the fallback.
   */
  function _printViaCanvasPng({ num, line, id, copiesText, priceText, addonParts, dateStr, timeStr, qrCanvas }) {
    // ── Canvas geometry ────────────────────────────────────────────────────
    // 58mm at 203dpi = 464 printable dots.
    // We render at 2× pixel density (928px wide) so text is crisp when the
    // browser scales the PNG down to fit the 58mm @page rule.
    // All layout values are expressed in logical pixels (half of canvas px).
    const SCALE = 2;
    const LOGICAL_W = 464;           // logical width = 58mm worth of dots
    const CW = LOGICAL_W * SCALE;    // actual canvas pixel width = 928
    const PAD  = 10 * SCALE;         // side padding (logical 10px ≈ 1.3mm)
    const MID  = CW / 2;
    const INNER_W = CW - PAD * 2;    // drawable width inside padding

    // ── Fonts — all sized relative to SCALE so they scale correctly ───────
    // All sizes bumped +25% from previous values and all weights set to bold
    // so every line is crisp and readable on the printed 58mm slip.
    const fBrand  = `bold ${Math.round(18 * 1.25) * SCALE}px "Courier New", monospace`; // "STUDRIO BOOTH" — 18→23
    const fSub    = `bold ${Math.round(17 * 1.25) * SCALE}px "Courier New", monospace`; // "Queue Ticket"  — 17→21
    const fLine   = `bold ${Math.round(20 * 1.25) * SCALE}px "Courier New", monospace`; // queue line name — 20→25
    const fBigNum = `900 ${Math.round(56 * 1.25) * SCALE}px "Courier New", monospace`;  // queue number   — 56→70
    const fDetail = `bold ${Math.round(15 * 1.25) * SCALE}px "Courier New", monospace`; // details rows   — 15→19
    const fDetailB= `bold ${Math.round(16 * 1.25) * SCALE}px "Courier New", monospace`; // bold details   — 16→20
    const fId     = `bold ${Math.round(12 * 1.25) * SCALE}px "Courier New", monospace`; // ticket UUID    — 12→15

    // ── Divider — measured to fit exactly within INNER_W ──────────────────
    // drawDivider uses fDetail font + measureText so the dash count auto-adjusts
    // to whatever font size fDetail is — no hardcoded repeat count.
    function drawDivider(ctx, y) {
      ctx.font = fDetail;
      ctx.textAlign = "center";
      ctx.fillStyle = "#000";
      const dash = "- ";
      const dashW = ctx.measureText(dash).width;
      const count = Math.floor(INNER_W / dashW);
      ctx.fillText(dash.repeat(count), MID, y);
      return y + 26 * SCALE; // line height matches fDetail at 19px logical
    }

    const QR_SIZE = 160 * SCALE; // 160 logical px → ~22mm at 203dpi — unchanged

    // Estimate total height — row heights updated to match new +25% font sizes
    let estimatedH = PAD;
    estimatedH += 30 * SCALE;  // brand  (23px logical)
    estimatedH += 28 * SCALE;  // sub    (21px logical)
    estimatedH += 28 * SCALE;  // divider
    estimatedH += 32 * SCALE;  // line name (25px logical)
    estimatedH += 88 * SCALE;  // big number (70px logical)
    estimatedH += 12 * SCALE;  // gap before QR
    estimatedH += QR_SIZE;
    estimatedH += 14 * SCALE;  // gap after QR
    estimatedH += 28 * SCALE;  // divider
    if (copiesText)        estimatedH += 26 * SCALE;
    if (addonParts.length) estimatedH += 26 * SCALE;
    if (priceText)         estimatedH += 28 * SCALE;
    estimatedH += 26 * SCALE;  // date
    estimatedH += 26 * SCALE;  // time
    estimatedH += 28 * SCALE;  // divider
    estimatedH += 22 * SCALE;  // ID     (15px logical)
    estimatedH += 26 * SCALE;  // footer line 1
    estimatedH += 26 * SCALE;  // footer line 2
    estimatedH += PAD + 24 * SCALE; // bottom margin + cut feed

    // ── Allocate canvas ────────────────────────────────────────────────────
    const canvas = document.createElement("canvas");
    canvas.width  = CW;
    canvas.height = estimatedH;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, CW, estimatedH);
    ctx.fillStyle = "#000";

    let y = PAD + 6 * SCALE;

    // ── Brand header ───────────────────────────────────────────────────────
    ctx.font      = fBrand;
    ctx.textAlign = "center";
    ctx.fillText("STUDRIO BOOTH", MID, y + 23 * SCALE); y += 30 * SCALE;

    ctx.font = fSub;
    ctx.fillText("Queue Ticket", MID, y + 21 * SCALE); y += 28 * SCALE;

    y = drawDivider(ctx, y + 10 * SCALE);

    // ── Queue line ─────────────────────────────────────────────────────────
    ctx.font = fLine;
    ctx.fillText(line.toUpperCase(), MID, y + 25 * SCALE); y += 32 * SCALE;

    // ── Big queue number ───────────────────────────────────────────────────
    // Scale down font if the number is wide (e.g. "999")
    ctx.font = fBigNum;
    const numW = ctx.measureText(num).width;
    if (numW > INNER_W) {
      const ratio = INNER_W / numW;
      ctx.font = `900 ${Math.floor(70 * SCALE * ratio)}px "Courier New", monospace`;
    }
    ctx.fillText(num, MID, y + 70 * SCALE); y += 88 * SCALE;

    // ── QR image ───────────────────────────────────────────────────────────
    y += 10 * SCALE;
    if (qrCanvas) {
      try {
        const qrX = MID - QR_SIZE / 2;
        ctx.drawImage(qrCanvas, qrX, y, QR_SIZE, QR_SIZE);
      } catch (_) {
        ctx.font = fDetail;
        ctx.fillText("[QR code]", MID, y + QR_SIZE / 2);
      }
    }
    y += QR_SIZE + 14 * SCALE;

    // ── Divider ────────────────────────────────────────────────────────────
    y = drawDivider(ctx, y + 10 * SCALE);
    y += 6 * SCALE;

    // ── Details (left-aligned) ─────────────────────────────────────────────
    ctx.textAlign = "left";
    if (copiesText) {
      ctx.font = fDetail;
      ctx.fillText(`Copies: ${copiesText}`, PAD, y + 19 * SCALE); y += 26 * SCALE;
    }
    if (addonParts.length) {
      ctx.font = fDetail;
      ctx.fillText(`Add-ons: ${addonParts.join(", ")}`, PAD, y + 19 * SCALE); y += 26 * SCALE;
    }
    if (priceText) {
      ctx.font = fDetailB;
      ctx.fillText(`Total: ${priceText}`, PAD, y + 20 * SCALE); y += 28 * SCALE;
    }
    ctx.font = fDetail;
    ctx.fillText(`Date: ${dateStr}`, PAD, y + 19 * SCALE); y += 26 * SCALE;
    ctx.fillText(`Time: ${timeStr}`, PAD, y + 19 * SCALE); y += 26 * SCALE;

    // ── Divider ────────────────────────────────────────────────────────────
    y += 6 * SCALE;
    y = drawDivider(ctx, y + 10 * SCALE);
    y += 6 * SCALE;

    // ── Ticket ID (small, centered) ────────────────────────────────────────
    ctx.font = fId;
    ctx.textAlign = "center";
    ctx.fillStyle = "#444";
    ctx.fillText(id, MID, y + 15 * SCALE); y += 22 * SCALE;

    // ── Footer ─────────────────────────────────────────────────────────────
    ctx.fillStyle = "#000";
    ctx.font = fDetail;
    ctx.fillText("Thank you! Please wait", MID, y + 19 * SCALE); y += 26 * SCALE;
    ctx.fillText("for your number to be called.", MID, y + 19 * SCALE); y += 26 * SCALE;

    // ── Trim to actual content ─────────────────────────────────────────────
    const finalH = y + PAD;
    const trimmed = document.createElement("canvas");
    trimmed.width  = CW;
    trimmed.height = finalH;
    trimmed.getContext("2d").drawImage(canvas, 0, 0);

    const imgSrc = trimmed.toDataURL("image/png");

    // ── Open print popup ───────────────────────────────────────────────────
    // The @page rule requests 58mm × continuous paper with zero margins.
    // The img is set to 100vw so it spans the full printable width — the
    // browser then clips at 58mm when the driver honours the @page size.
    // We also set body width to exactly 58mm so Chrome's print preview
    // matches the physical paper width.
    const win = window.open("", "_blank", "width=300,height=700");
    if (!win) {
      console.warn("[queueManager] Popup blocked — please allow popups for this page.");
      return;
    }
    win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Queue Ticket ${num}</title>
  <style>
    @page { size: 58mm auto; margin: 0mm; }
    html, body { margin: 0; padding: 0; width: 58mm; background: #fff; }
    img { display: block; width: 58mm; height: auto; }
  </style>
</head>
<body>
  <img src="${imgSrc}">
  <script>
    window.onload = function () {
      setTimeout(function () { window.print(); window.close(); }, 400);
    };
  <\/script>
</body>
</html>`);
    win.document.close();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  return {
    async init() {
      _checkDailyReset();
      _injectHTML();
      _wire();
      await _loadQueue();
      _subscribe();
    },

    async refresh() {
      await _loadQueue();
    }
  };
})();
