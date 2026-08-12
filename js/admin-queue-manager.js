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
  let _lines        = new Set(["Main"]);

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
      <div class="queue-layout">

        <!-- Left: Generate ticket -->
        <div class="queue-gen-card">
          <div class="queue-gen-title">Generate Ticket</div>

          <div class="form-group" style="margin-bottom:14px">
            <label>Queue Line</label>
            <input
              type="text"
              id="genQueueLine"
              class="admin-input"
              value="Main"
              placeholder="e.g. Main, VIP, Group A"
            >
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
        const line       = (document.getElementById("genQueueLine")?.value || "Main").trim();
        const copies     = parseInt(document.getElementById("genCopies")?.value || "1", 10);
        const frameAddon = parseInt(document.getElementById("genFrameAddon")?.value || "0", 10);
        const keychain   = parseInt(document.getElementById("genKeychainAddon")?.value || "0", 10);

        if (!line) { showToast("Please enter a queue line name."); return; }
        if (isNaN(copies) || copies < 1) { showToast("Copies must be at least 1."); return; }

        btnGen.disabled = true;
        btnGen.textContent = "Generating…";
        try {
          let ticket = await queueTickets.createTicket({
            queueLine: line,
            copies: Math.max(1, copies),
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

    // QR Modal: print
    const btnPrint = document.getElementById("btnPrintQr");
    if (btnPrint) {
      btnPrint.addEventListener("click", () => {
        // Simple print: open a print-friendly version of the QR
        const canvas = document.querySelector("#qrModalCanvas canvas");
        const num    = document.getElementById("qrModalNumber")?.textContent || "";
        const line   = document.getElementById("qrModalLine")?.textContent || "";
        const id     = document.getElementById("qrModalId")?.textContent || "";
        const meta   = document.getElementById("qrModalMeta")?.textContent || "";

        const imgSrc = canvas ? canvas.toDataURL("image/png") : "";

        const win = window.open("", "_blank", "width=400,height=560");
        win.document.write(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <title>Queue Ticket ${num}</title>
            <style>
              body { font-family: Inter, system-ui, sans-serif; text-align: center; padding: 24px; margin: 0; }
              h1   { font-size: 48px; font-weight: 900; margin: 0; }
              p    { color: #666; font-size: 13px; margin: 4px 0; }
              img  { margin: 16px auto; display: block; }
              .id  { font-family: monospace; font-size: 11px; color: #999; word-break: break-all; }
              .line { font-weight: 700; font-size: 16px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
            </style>
          </head>
          <body>
            <h1>${num}</h1>
            <div class="line">${line}</div>
            ${imgSrc ? `<img src="${imgSrc}" width="200" height="200">` : ""}
            <p>${meta}</p>
            <p class="id">${id}</p>
            <script>window.onload = function() { window.print(); window.close(); };<\/script>
          </body>
          </html>
        `);
        win.document.close();
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

  // ── Public API ──────────────────────────────────────────────────────────────

  return {
    async init() {
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
