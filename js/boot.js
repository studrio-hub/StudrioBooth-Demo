/*
 * BOOT.JS — Kiosk startup sequence.
 */

(async function boot() {
  const bootStatusList = document.getElementById("bootStatusList");
  const bootError = document.getElementById("bootError");
  const bootErrorText = document.getElementById("bootErrorText");
  const bootSpinner = document.getElementById("bootSpinner");

  function addStatus(msg) {
    if (!bootStatusList) return;
    const row = document.createElement("div");
    row.className = "boot-status-row";
    row.textContent = `> ${msg}`;
    bootStatusList.appendChild(row);
    row.scrollIntoView();
  }

  function showError(msg) {
    if (bootError) bootError.hidden = false;
    if (bootErrorText) bootErrorText.textContent = msg;
    if (bootSpinner) bootSpinner.hidden = true;
  }

  // Initial UI state
  goToPage("boot");
  addStatus("Initializing system...");

  /* ── 1. Sync templates directly from Supabase ───────────────────────────── */
  try {
    addStatus("Syncing templates from cloud...");
    await assetSync.init();
    addStatus(`Sync complete — ${assetSync.getTemplates().length} templates ready.`);
  } catch (e) {
    console.error("[boot] Unexpected error during template sync:", e);
    addStatus("Warning: Template sync failed, using cache.");
  }

  /* ── 2. Populate STRIP_DESIGNS ───────────────────────────────────────────── */
  if (typeof stripModule !== "undefined") {
    stripModule.initDesigns();
  }

  /* ── 3. Connect camera ───────────────────────────────────────────────────── */
  async function tryConnectCamera() {
    try {
      addStatus("Detecting camera...");
      const cameraStatus = await cameraController.connect();
      
      if (cameraController.mode === "real") {
        addStatus(`Camera detected: ${cameraStatus.model}`);
      } else {
        addStatus(`Falling back to: ${cameraStatus.model}`);
      }
      
      // Monitor for disconnect
      if (window.electronAPI && cameraController.mode === "real") {
        setInterval(async () => {
          if (!cameraController.status.connected) {
            console.log("[boot] Attempting auto-reconnect...");
            await cameraController.connect().catch(() => {});
          }
        }, 5000);
      }
      return true;
    } catch (e) {
      console.error("[boot] Camera connect failed:", e);
      addStatus("Error: Camera connection failed.");
      showError("Camera not detected. Please check connection and retry.");
      return false;
    }
  }

  const cameraConnected = await tryConnectCamera();
  if (!cameraConnected) return;

  /* ── 4. Attach live preview ─────────────────────────────────────────────── */
  if (cameraController.mode) {
    try {
      cameraController.attachPreview(setupEls.video, setupEls.img);
      const nextBtn = document.getElementById("btnNextFromSetup");
      if (nextBtn) nextBtn.disabled = false;
      addStatus("Preview stream active.");
    } catch (e) {
      console.error("[boot] Preview attach failed:", e);
      addStatus("Warning: Preview stream failed.");
    }
  }

  /* ── 5. Show the lock screen ─────────────────────────────────────────────── */
  addStatus("System ready.");
  setTimeout(() => {
    if (typeof authLock !== "undefined") {
      authLock.init();
    } else {
      console.warn("[boot] authLock not found — skipping lock screen.");
      goToPage("home");
    }
  }, 1000);

  // Retry logic
  document.getElementById("btnBootRetry")?.addEventListener("click", () => {
    window.location.reload();
  });
  
  document.getElementById("btnBootRestart")?.addEventListener("click", () => {
    window.location.reload();
  });

})();
