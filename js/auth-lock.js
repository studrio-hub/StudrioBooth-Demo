/*
 * AUTH-LOCK.JS — Kiosk startup lock screen.
 *
 * Staff unlocks the kiosk with the same email + password credentials used
 * to sign into the Admin Panel (studrio.cc/admin). Authentication is
 * handled by Supabase Auth via adminStorage.signIn() in cloud-storage.js.
 *
 * The lock screen is only shown ONCE at kiosk startup. Between guest
 * sessions the kiosk returns to the Home page (page-home), not here.
 * That matches the previous PIN behaviour and is intentional — staff do
 * not re-authenticate for every guest.
 *
 * Public API (unchanged from previous version):
 *   authLock.lock(onUnlock)  — show the lock screen; call onUnlock() on success
 *   authLock.init()          — alias for lock(goToPage("home")) — called by boot.js
 */

const authLock = (() => {
  let _onUnlock = null;
  let _unlocked = false;

  // ── DOM refs ────────────────────────────────────────────────────────────────
  // Populated on first show so this module is safe to load before DOMContentLoaded.
  function _els() {
    return {
      page:        document.getElementById("page-lock"),
      emailInput:  document.getElementById("lockEmail"),
      passInput:   document.getElementById("lockPassword"),
      submitBtn:   document.getElementById("lockSubmitBtn"),
      statusMsg:   document.getElementById("lockStatusMsg")
    };
  }

  // ── Status display ──────────────────────────────────────────────────────────
  function _setStatus(msg, type = "") {
    // type: "" | "error" | "success"
    const el = document.getElementById("lockStatusMsg");
    if (!el) return;
    el.textContent  = msg;
    el.className    = "lock-status-msg" + (type ? " " + type : "");
  }

  // ── Sign-in handler ─────────────────────────────────────────────────────────
  async function _handleSubmit(e) {
    e.preventDefault();
    if (_unlocked) return;

    const { emailInput, passInput, submitBtn } = _els();

    const email    = emailInput.value.trim();
    const password = passInput.value;

    if (!email || !password) {
      _setStatus("Please enter your email and password.", "error");
      return;
    }

    submitBtn.disabled   = true;
    submitBtn.textContent = "Signing in…";
    _setStatus("");

    try {
      await adminStorage.signIn(email, password);
      _setStatus("Authenticated — starting kiosk…", "success");
      _succeed();
    } catch (err) {
      console.error("[authLock] Sign-in failed:", err);
      _setStatus("Incorrect email or password. Try again.", "error");
      passInput.value       = "";
      submitBtn.disabled    = false;
      submitBtn.textContent = "Sign In";
      passInput.focus();
    }
  }

  // ── Success ─────────────────────────────────────────────────────────────────
  function _succeed() {
    if (_unlocked) return; // idempotent
    _unlocked = true;

    setTimeout(() => {
      const page = document.getElementById("page-lock");
      if (page) page.classList.remove("active");
      if (typeof _onUnlock === "function") _onUnlock();
    }, 600);
  }

  // ── Show ────────────────────────────────────────────────────────────────────
  function _show() {
    _unlocked = false;

    // Make page-lock the active page
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    const page = document.getElementById("page-lock");
    if (page) page.classList.add("active");

    // Wire the form (once — guard against re-wiring on repeated lock() calls)
    const form = document.getElementById("lockForm");
    if (form && !form.dataset.wired) {
      form.addEventListener("submit", _handleSubmit);
      form.dataset.wired = "1";
    }

    _setStatus("");

    // Auto-focus email field
    const emailInput = document.getElementById("lockEmail");
    if (emailInput) setTimeout(() => emailInput.focus(), 100);
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  return {
    /*
     * lock(onUnlock)
     * Shows the lock screen. Calls onUnlock() when authentication succeeds.
     */
    lock(onUnlock) {
      _onUnlock = onUnlock;
      _show();
    },

    /*
     * init()
     * Convenience alias used by boot.js. Equivalent to:
     *   authLock.lock(() => goToPage("home"))
     */
    init() {
      this.lock(() => goToPage("home"));
    }
  };
})();
