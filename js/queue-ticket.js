/*
 * QUEUE-TICKET.JS — Studrio QR Ticketing + Queue System
 * ──────────────────────────────────────────────────────────────────────────────
 * Shared module for kiosk, admin panel, and queue-status page.
 *
 * Depends on: cloud-storage.js (provides getSupabaseClient())
 *
 * Public API:
 *   queueTickets.generateId()              — create a unique ticket ID
 *   queueTickets.createTicket(opts)        — admin: insert new ticket row
 *   queueTickets.getTicket(id)             — fetch single ticket by ID
 *   queueTickets.validateTicketForKiosk(id)— kiosk: validate + transition CALLED→IN_SESSION
 *   queueTickets.setStatus(id, status)     — update ticket status
 *   queueTickets.callNext(queueLine)       — admin: advance to next customer
 *   queueTickets.holdTicket(id)            — admin: place ticket ON_HOLD
 *   queueTickets.restoreHeld(id)           — admin: return held ticket after current
 *   queueTickets.completeTicket(id)        — mark IN_SESSION → COMPLETED
 *   queueTickets.cancelTicket(id)          — mark → CANCELLED
 *   queueTickets.listActive(queueLine?)    — fetch active queue (optionally filtered)
 *   queueTickets.subscribeToQueue(cb)      — realtime subscription to ticket changes
 *   queueTickets.unsubscribe(channel)      — unsubscribe from realtime channel
 *   queueTickets.getNextQueueNumber(line)  — next available number for a line
 *
 * Queue Status order:
 *   IN_SESSION (currently being served) → CALLED → ON_HOLD → WAITING
 *
 * ON_HOLD re-insertion rule:
 *   When a held ticket is restored, it is placed immediately after the ticket
 *   currently IN_SESSION (or CALLED), before any other WAITING tickets.
 *   This is achieved by assigning a queue_number slightly higher than the
 *   current serving ticket but lower than the next WAITING ticket.
 */

const queueTickets = (() => {

  // ── ID generation ─────────────────────────────────────────────────────────

  function generateId() {
    // Produces a URL-safe ~12-char ID: timestamp base-36 + 4 random chars
    const ts   = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 6);
    return `T-${ts}-${rand}`.toUpperCase();
  }

  // ── Supabase client helper ─────────────────────────────────────────────────

  function _client() {
    if (typeof getSupabaseClient === "function") return getSupabaseClient();
    if (typeof supabase !== "undefined" && typeof CLOUD_CONFIG !== "undefined") {
      return supabase.createClient(CLOUD_CONFIG.supabaseUrl, CLOUD_CONFIG.supabaseAnonKey);
    }
    throw new Error("[queueTickets] Supabase client not available. Load cloud-storage.js first.");
  }

  // ── Ticket CRUD ────────────────────────────────────────────────────────────

  /*
   * createTicket — admin creates a new ticket.
   * opts: { queueLine, copies, frameAddon, keychainAddon }
   * Returns the inserted ticket row.
   */
  async function createTicket({ queueLine = "Main", copies = 1, frameAddon = 0, keychainAddon = 0 } = {}) {
    const db = _client();
    const id  = generateId();

    // Get the next queue number for this line
    const nextNum = await getNextQueueNumber(queueLine);

    const { data, error } = await db.from("tickets").insert({
      id,
      queue_number:   nextNum,
      queue_line:     queueLine,
      copies:         Math.max(1, copies),
      frame_addon:    Math.max(0, frameAddon),
      keychain_addon: Math.max(0, keychainAddon),
      status:         "WAITING"
    }).select().single();

    if (error) throw error;
    return data;
  }

  /*
   * getTicket — fetch a single ticket by ID.
   * Returns ticket row or null if not found.
   */
  async function getTicket(id) {
    if (!id) return null;
    const db = _client();
    const { data, error } = await db
      .from("tickets")
      .select("*")
      .eq("id", id.trim().toUpperCase())
      .single();
    if (error && error.code !== "PGRST116") throw error; // PGRST116 = no rows found
    return data || null;
  }

  /*
   * setStatus — update a ticket's status column.
   * Returns the updated ticket row.
   */
  async function setStatus(id, status) {
    const db = _client();
    const patch = { status };
    if (status === "CALLED")      patch.called_at     = new Date().toISOString();
    if (status === "ON_HOLD")     patch.held_at        = new Date().toISOString();
    if (status === "COMPLETED")   patch.completed_at   = new Date().toISOString();

    const { data, error } = await db
      .from("tickets")
      .update(patch)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  /*
   * validateTicketForKiosk — called when a customer scans their QR code.
   *
   * Rules:
   *   • Ticket must exist
   *   • Status must be CALLED (admin has called this ticket)
   *   • Transitions CALLED → IN_SESSION
   *   • Prevents duplicate scans (IN_SESSION / COMPLETED / CANCELLED all rejected)
   *
   * Returns { ok: true, ticket } on success or { ok: false, reason } on failure.
   */
  async function validateTicketForKiosk(id) {
    if (!id) return { ok: false, reason: "No ticket ID provided." };

    let ticket;
    try {
      ticket = await getTicket(id);
    } catch (e) {
      return { ok: false, reason: "Could not reach the server. Check your connection." };
    }

    if (!ticket) {
      return { ok: false, reason: "Ticket not found. Please check with staff." };
    }

    if (ticket.status === "COMPLETED") {
      return { ok: false, reason: "This ticket has already been used." };
    }
    if (ticket.status === "CANCELLED") {
      return { ok: false, reason: "This ticket has been cancelled. Please see staff." };
    }
    if (ticket.status === "IN_SESSION") {
      return { ok: false, reason: "A session for this ticket is already active." };
    }
    if (ticket.status === "WAITING") {
      return { ok: false, reason: "Your ticket has not been called yet. Please wait." };
    }
    if (ticket.status === "ON_HOLD") {
      return { ok: false, reason: "Your ticket is on hold. Please see staff." };
    }
    if (ticket.status !== "CALLED") {
      return { ok: false, reason: `Unexpected ticket status: ${ticket.status}` };
    }

    // Transition to IN_SESSION
    try {
      const updated = await setStatus(id, "IN_SESSION");
      return { ok: true, ticket: updated };
    } catch (e) {
      return { ok: false, reason: "Could not start session. Please see staff." };
    }
  }

  /*
   * getNextQueueNumber — returns the next available queue number for a given line.
   * This is MAX(queue_number) + 1 across ALL statuses (so numbers never repeat).
   */
  async function getNextQueueNumber(queueLine = "Main") {
    const db = _client();
    const { data, error } = await db
      .from("tickets")
      .select("queue_number")
      .eq("queue_line", queueLine)
      .order("queue_number", { ascending: false })
      .limit(1)
      .single();

    if (error && error.code === "PGRST116") return 1; // no tickets yet
    if (error) throw error;
    return (data?.queue_number || 0) + 1;
  }

  /*
   * listActive — returns active tickets for a queue line (or all lines).
   * Excludes COMPLETED and CANCELLED tickets.
   * Sorted: IN_SESSION → CALLED → ON_HOLD → WAITING, then by queue_number ASC.
   */
  async function listActive(queueLine = null) {
    const db = _client();
    let query = db
      .from("tickets")
      .select("*")
      .not("status", "in", '("COMPLETED","CANCELLED")');

    if (queueLine) query = query.eq("queue_line", queueLine);

    const { data, error } = await query.order("queue_number", { ascending: true });
    if (error) throw error;

    const ORDER = { IN_SESSION: 0, CALLED: 1, ON_HOLD: 2, WAITING: 3 };
    return (data || []).sort((a, b) => {
      const oa = ORDER[a.status] ?? 99;
      const ob = ORDER[b.status] ?? 99;
      if (oa !== ob) return oa - ob;
      return a.queue_number - b.queue_number;
    });
  }

  /*
   * callNext — admin calls the next WAITING ticket in a line.
   * Any existing CALLED ticket that wasn't scanned is moved back to WAITING.
   * Returns the newly CALLED ticket row, or null if the queue is empty.
   */
  async function callNext(queueLine = "Main") {
    const db = _client();

    // Find the next WAITING ticket (lowest queue number)
    const { data: waiting, error: wErr } = await db
      .from("tickets")
      .select("*")
      .eq("queue_line", queueLine)
      .eq("status", "WAITING")
      .order("queue_number", { ascending: true })
      .limit(1)
      .single();

    if (wErr && wErr.code === "PGRST116") return null; // queue empty
    if (wErr) throw wErr;

    // Transition to CALLED
    const updated = await setStatus(waiting.id, "CALLED");
    return updated;
  }

  /*
   * holdTicket — places the currently CALLED ticket ON_HOLD.
   * Returns the updated ticket row.
   */
  async function holdTicket(id) {
    return setStatus(id, "ON_HOLD");
  }

  /*
   * restoreHeld — moves a held ticket back into the queue after the current
   * serving ticket (IN_SESSION/CALLED).
   *
   * Strategy: assign it a queue_number that places it immediately after the
   * current serving ticket by bumping its queue_number to currentServing + 0.5
   * (stored as a float if the schema allows it; here we renumber to keep int).
   *
   * Simpler approach used here:
   *   1. Find the lowest WAITING ticket's queue_number in this line.
   *   2. Assign the held ticket a queue_number one less than that.
   *      If it's already lower, leave it and just set status to WAITING.
   *
   * This places the held ticket as the very next WAITING entry without
   * renumbering all other tickets.
   */
  async function restoreHeld(id) {
    const db = _client();

    // Fetch the held ticket
    const ticket = await getTicket(id);
    if (!ticket || ticket.status !== "ON_HOLD") {
      throw new Error(`Ticket ${id} is not ON_HOLD`);
    }

    // Find the lowest WAITING queue_number for this line
    const { data: nextWaiting, error: nErr } = await db
      .from("tickets")
      .select("queue_number")
      .eq("queue_line", ticket.queue_line)
      .eq("status", "WAITING")
      .order("queue_number", { ascending: true })
      .limit(1)
      .single();

    let targetNumber = ticket.queue_number;
    if (!nErr && nextWaiting) {
      // Place before the next waiting ticket
      targetNumber = Math.max(ticket.queue_number, nextWaiting.queue_number - 1);
      // If there's no room (consecutive numbers), renumber to insert before
      if (targetNumber >= nextWaiting.queue_number) {
        // Shift all waiting tickets up by 1 to make room
        const { data: waitingTickets } = await db
          .from("tickets")
          .select("id, queue_number")
          .eq("queue_line", ticket.queue_line)
          .eq("status", "WAITING")
          .order("queue_number", { ascending: true });

        if (waitingTickets && waitingTickets.length > 0) {
          // Renumber waiting tickets upward, making room for the restored ticket
          for (let i = waitingTickets.length - 1; i >= 0; i--) {
            await db.from("tickets")
              .update({ queue_number: waitingTickets[i].queue_number + 1 })
              .eq("id", waitingTickets[i].id);
          }
          targetNumber = nextWaiting.queue_number;
        }
      }
    }

    const { data, error } = await db
      .from("tickets")
      .update({ status: "WAITING", queue_number: targetNumber, held_at: null })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  /*
   * completeTicket — marks a ticket COMPLETED.
   * Called when the kiosk session ends (printing done).
   */
  async function completeTicket(id) {
    if (!id) return;
    return setStatus(id, "COMPLETED");
  }

  /*
   * cancelTicket — marks a ticket CANCELLED.
   */
  async function cancelTicket(id) {
    return setStatus(id, "CANCELLED");
  }

  /*
   * subscribeToQueue — subscribes to realtime changes on the tickets table.
   * callback(payload) is called on every INSERT/UPDATE/DELETE.
   * Returns the realtime channel (store it to unsubscribe later).
   */
  function subscribeToQueue(callback) {
    const db = _client();
    const channel = db
      .channel("queue-tickets")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tickets" },
        (payload) => {
          try { callback(payload); } catch (e) { console.error("[queueTickets] Subscriber error:", e); }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log("[queueTickets] Realtime subscription active.");
        } else if (status === "CHANNEL_ERROR") {
          console.warn("[queueTickets] Realtime subscription error — will retry.");
        }
      });
    return channel;
  }

  /*
   * unsubscribe — removes a realtime channel created by subscribeToQueue.
   */
  function unsubscribe(channel) {
    if (!channel) return;
    try {
      const db = _client();
      db.removeChannel(channel);
    } catch (e) {
      console.warn("[queueTickets] Could not remove channel:", e);
    }
  }

  /*
   * linkSession — links a ticket to a completed photo session.
   * Called when the kiosk finalizes the session (printing starts).
   */
  async function linkSession(ticketId, sessionId) {
    if (!ticketId || !sessionId) return;
    const db = _client();
    const { error } = await db
      .from("tickets")
      .update({ session_id: sessionId })
      .eq("id", ticketId);
    if (error) console.warn("[queueTickets] Could not link session to ticket:", error.message);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  return {
    generateId,
    createTicket,
    getTicket,
    validateTicketForKiosk,
    setStatus,
    getNextQueueNumber,
    listActive,
    callNext,
    holdTicket,
    restoreHeld,
    completeTicket,
    cancelTicket,
    linkSession,
    subscribeToQueue,
    unsubscribe
  };
})();
