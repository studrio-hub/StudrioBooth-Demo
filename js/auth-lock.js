/*
 * AUTH-LOCK.JS — Kiosk lock screen.
 *
 * The kiosk starts locked. Staff unlocks it via one of two methods:
 *
 *   1. NFC TAG (primary): Staff taps an NFC-enabled card/tag with their
 *      phone. The tag stores a URL like:
 *        https://studrio.cc/nfc/?token=<CONFIGURED_TOKEN>
 *      The phone visits that page, which inserts a row into the
 *      `nfc_tokens` Supabase table. The kiosk polls every 2 seconds
 *      and unlocks as soon as a valid, unused, non-expired token appears.
 *
 *   2. PIN CODE (fallback): A 6-digit PIN entered on the touchscreen.
 *      The PIN is stored only in this file (not in Supabase) — it never
 *      leaves the kiosk. Change LOCK_CONFIG.pin to rotate it.
 *
 * After a session ends (resetSessionAndRestart in app.js), the kiosk
 * returns here and re-locks automatically.
 *
 * NFC TAG SETUP:
 *   - Get any NFC tag (NTAG213 or similar, ~₱20–50 each).
 *   - Use an NFC writer app (e.g. "NFC Tools" on Android) to write a URL:
 *       https://studrio.cc/nfc/?token=<value matching LOCK_CONFIG.nfcToken>
 *   - The token value can be anything — treat it like a password.
 *   - To rotate: change LOCK_CONFIG.nfcToken here AND re-write the tag.
 */

const LOCK_CONFIG = {
  pin: "123456",         // ← CHANGE THIS before going live
  nfcToken: "studrio-nfc-2026",  // ← Must match the token written to your NFC tag(s)
  pollIntervalMs: 2000   // How often the kiosk checks Supabase for an NFC tap
};

const authLock = (() => {
  let _pollTimer = null;
  let _pinBuffer = "";
  let _onUnlock  = null; // callback to call when auth succeeds
  let _unlocked  = false;

  // ── DOM refs (populated on first show) ───────────────────────────────────
  let els = {};

  function _getEls() {
    return {
      page:        document.getElementById("page-lock"),
      pinDisplay:  document.getElementById("lockPinDisplay"),
      pinDots:     document.querySelectorAll(".lock-pin-dot"),
      keys:        document.querySelectorAll(".lock-key"),
      clearBtn:    document.getElementById("lockKeyClear"),
      statusMsg:   document.getElementById("lockStatusMsg"),
      nfcHint:     document.getElementById("lockNfcHint")
    };
  }

  // ── PIN display ───────────────────────────────────────────────────────────
  function _updateDots() {
    els.pinDots.forEach((dot, i) => {
      dot.classList.toggle("filled", i < _pinBuffer.length);
    });
  }

  function _setStatus(msg, type = "") {
    // type: "" | "error" | "success"
    els.statusMsg.textContent = msg;
    els.statusMsg.className   = "lock-status-msg" + (type ? " " + type : "");
  }

  // ── PIN logic ─────────────────────────────────────────────────────────────
  function _appendDigit(digit) {
    if (_pinBuffer.length >= 6) return;
    _pinBuffer += digit;
    _updateDots();
    _setStatus(""); // clear any previous error

    if (_pinBuffer.length === 6) {
      _checkPin();
    }
  }

  function _clearPin() {
    _pinBuffer = "";
    _updateDots();
    _setStatus("");
  }

  function _checkPin() {
    if (_pinBuffer === LOCK_CONFIG.pin) {
      _succeed("pin");
    } else {
      _setStatus("Incorrect PIN — try again.", "error");
      // Shake animation then clear
      els.pinDisplay.classList.add("shake");
      setTimeout(() => {
        els.pinDisplay.classList.remove("shake");
        _clearPin();
      }, 600);
    }
  }

  // ── NFC polling ───────────────────────────────────────────────────────────
  function _startNfcPoll() {
    if (!cloudStorage.isAvailable()) return; // Supabase not configured, NFC unavailable
    _pollTimer = setInterval(_pollNfc, LOCK_CONFIG.pollIntervalMs);
  }

  function _stopNfcPoll() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  async function _pollNfc() {
    try {
      const client = getSupabaseClient();
      if (!client) return;

      // Look for our exact token that is unused and not yet expired
      const { data, error } = await client
        .from("nfc_tokens")
        .select("token, used_at, expires_at")
        .eq("token", LOCK_CONFIG.nfcToken)
        .is("used_at", null)
        .gt("expires_at", new Date().toISOString())
        .limit(1);

      if (error || !data || data.length === 0) return;

      // Mark as used so the same tap can't unlock twice
      await client
        .from("nfc_tokens")
        .update({ used_at: new Date().toISOString() })
        .eq("token", LOCK_CONFIG.nfcToken);

      _succeed("nfc");
    } catch (e) {
      // Silent — NFC poll failures are non-critical
      console.warn("[authLock] NFC poll error:", e.message || e);
    }
  }

  // ── Success ───────────────────────────────────────────────────────────────
  function _succeed(method) {
    if (_unlocked) return; // idempotent
    _unlocked = true;
    _stopNfcPoll();
    _setStatus(method === "nfc" ? "NFC tag detected — unlocking…" : "PIN accepted — unlocking…", "success");

    setTimeout(() => {
      _hide();
      if (typeof _onUnlock === "function") _onUnlock();
    }, 600);
  }

  // ── Show / hide ───────────────────────────────────────────────────────────
  function _show() {
    _unlocked  = false;
    _pinBuffer = "";
    els = _getEls();
    _updateDots();
    _setStatus("");

    // Wire keypad (once — guard against double-wiring on re-lock)
    if (!els.page.dataset.wired) {
      els.keys.forEach(key => {
        key.addEventListener("click", () => {
          const digit = key.dataset.digit;
          if (digit !== undefined) _appendDigit(digit);
        });
      });
      els.clearBtn.addEventListener("click", _clearPin);
      els.page.dataset.wired = "1";
    }

    // Make page visible
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    els.page.classList.add("active");

    // Start polling for NFC
    _startNfcPoll();

    // Show NFC hint only if Supabase is configured
    if (els.nfcHint) {
      els.nfcHint.hidden = !cloudStorage.isAvailable();
    }
  }

  function _hide() {
    els.page.classList.remove("active");
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    /*
     * lock(onUnlock)
     * Shows the lock screen. Calls onUnlock() when auth succeeds.
     * Call this on startup and after each session resets.
     */
    lock(onUnlock) {
      _onUnlock = onUnlock;
      _show();
    }
  };
})();
