/*
 * QR.JS — QR code generation + digital gallery abstraction.
 *
 * mediaStorage.createGallery() uploads via cloudStorage (Supabase).
 * There is no local-only fallback — the gallery is cloud-only project-wide
 * (see gallery.js / cloud-storage.js). If Supabase is unavailable, the QR
 * still resolves to the deterministic gallery URL so printing/QR-baking
 * can proceed, it just won't have media behind it until Supabase is fixed.
 */

const mediaStorage = {
  async createGallery(sessionData) {
    if (cloudStorage.isAvailable()) {
      return cloudStorage.saveSession(sessionData);
    }

    // No local-only fallback: gallery.js is cloud-only (IndexedDB fallback
    // was removed from the project — see gallery.js). If Supabase isn't
    // configured/available, the QR still resolves to the deterministic
    // gallery URL, it just won't have any media behind it yet.
    console.warn("[mediaStorage] Cloud storage unavailable — QR will point to a gallery URL with no uploaded media. Check cloud-storage.js CLOUD_CONFIG.");
    return { url: `${window.location.origin}${window.location.pathname.replace("index.html", "")}gallery.html?gallery=${sessionData.id}` };
  }
};

const qrModule = {
  async generateAndRender() {
    const container = document.getElementById("qrCodeCanvas");
    container.innerHTML = "";

    // Lets printingModule.init() wait for the gallery URL to exist even
    // if auto-print fires before this upload finishes.
    // Note: #qrUrlText was removed from index.html — upload state is now
    // shown via #qrUploading in printing.js. No urlText references here.
    let resolveGalleryUrl;
    sessionState.galleryUrlPromise = new Promise((resolve) => { resolveGalleryUrl = resolve; });

    const finalStripPng = await stripModule.exportPNG({
      frameType: sessionState.frameType,
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design
    });

    // Per-shot videos run ~8.6s each (shootingModule.countdownSeconds of 8s
    // plus the ~600ms captured-still freeze tail — see shooting.js and
    // camera-bridge.js stopVideoRecording()). exportVideoStrip()'s default
    // durationMs (3000) cuts off before a single loop finishes, producing a
    // truncated-looking export. Record a bit past one full per-shot cycle
    // so the uploaded strip-live video shows a complete loop.
    const perShotDurationMs = (shootingModule.countdownSeconds * 1000) + 600;
    const finalStripVideo = await stripModule.exportVideoStrip({
      frameType: sessionState.frameType,
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design,
      durationMs: perShotDurationMs + 500 // small buffer past the loop point
    });

    // The gallery URL is fully deterministic from the session id (same
    // formula mediaStorage.createGallery() falls back to), so it can be
    // computed before the upload even starts — which lets us bake the
    // QR into a print-ready strip up front, not just at print time.
    // This gives the admin dashboard a reprint-ready file for every
    // session, even ones the guest never actually printed.
    const galleryUrl = `${window.location.origin}${window.location.pathname.replace("index.html", "")}gallery.html?gallery=${sessionState.id}`;

    let printReadyPng = null;
    try {
      printReadyPng = await stripModule.exportPrintPNG({
        frameType: sessionState.frameType,
        selectedShots: sessionState.selectedShots,
        designId: sessionState.design,
        qrText: galleryUrl
      });
    } catch (e) {
      console.warn("[qrModule] Could not prepare print-ready (QR-baked) copy:", e);
    }

    const galleryPayload = {
      id: sessionState.id,
      frameType: sessionState.frameType,
      design: sessionState.design,
      finalStripPng,
      finalStripVideo,
      printReadyPng,
      photos: sessionState.selectedShots.map((s) => ({
        id: s.id,
        image: s.image
      }))
    };

    let resolvedGalleryUrl;
    try {
      const gallery = await mediaStorage.createGallery(galleryPayload);
      resolvedGalleryUrl = gallery.url;
    } catch (e) {
      console.error("Gallery creation failed:", e);
      resolvedGalleryUrl = galleryUrl;
    }

    sessionState.galleryUrl = resolvedGalleryUrl;
    resolveGalleryUrl(resolvedGalleryUrl);

    new QRCode(container, {
      text: resolvedGalleryUrl,
      width: 220,
      height: 220,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.L
    });
  }
};