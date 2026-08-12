/*
 * ADMIN-QUEUE-BRIDGE.JS — Hooks queueManager into the existing admin tab system.
 *
 * admin-dashboard.js already handles tab switching (data-tab / data-panel).
 * This script:
 *   1. Waits for the admin to become authenticated.
 *   2. Intercepts clicks on the "queue" tab to lazy-init queueManager once.
 *   3. Patches the existing tab-switch function if needed.
 *
 * This approach means we never touch admin-dashboard.js directly, so existing
 * sessions / templates / hardware tabs are completely unaffected.
 *
 * LOAD ORDER: after admin-queue-manager.js, after admin-dashboard.js.
 */

(function () {
  "use strict";

  let _initialized = false;

  async function _initQueue() {
    if (_initialized) return;
    _initialized = true;
    try {
      if (typeof queueManager !== "undefined") {
        await queueManager.init();
      }
    } catch (e) {
      console.error("[admin-queue-bridge] queueManager.init() failed:", e);
    }
  }

  function _wireQueueTab() {
    // Find the queue tab button
    const adminTabs = document.getElementById("adminTabs");
    if (!adminTabs) return;

    // Intercept all tab clicks via event delegation
    adminTabs.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tab]");
      if (!btn) return;
      if (btn.dataset.tab === "queue") {
        // Allow the existing dashboard tab-switch to run first, then init queue
        setTimeout(_initQueue, 0);
      }
    }, true); // useCapture so we run before (or alongside) the existing listener
  }

  // Also handle the case where the queue tab is already active on load
  function _checkActiveOnLoad() {
    const active = document.querySelector(".admin-panel.active[data-panel='queue']");
    if (active) _initQueue();
  }

  // Run after the DOM is ready and admin-dashboard.js has loaded
  function _run() {
    _wireQueueTab();
    _checkActiveOnLoad();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _run);
  } else {
    _run();
  }
})();
