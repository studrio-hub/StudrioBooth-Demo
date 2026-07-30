/*
 * QR.JS — QR code generation + digital gallery abstraction.
 *
 * mediaStorage.createGallery() uploads via cloudStorage (Supabase).
 * There is no local-only fallback — the gallery is cloud-only project-wide
 * (see gallery.js / cloud-storage.js). If Supabase is unavailable, the QR
 * still resolves to the deterministic gallery URL so printing/QR-baking
 * can proceed, it just won't have media behind it until Supabase is fixed.
 *
 * Gallery URL format: https://studrio.cc/g/#<sessionId>
 * e.g. https://studrio.cc/g/#2ydgshd
 *
 * The hash fragment is used instead of a path segment (/g/2ydgshd) because
 * GitHub Pages has no server-side rewrite support — a path like /g/2ydgshd
 * would 404 since there is no file at that path. The hash is read entirely
 * client-side by gallery.js, so GitHub Pages just serves /g/index.html and
 * everything works with zero hosting configuration.
 *
 * RELIABILITY CONTRACT: sessionState.galleryUrlPromise MUST resolve —
 * never reject, never hang — no matter what happens during export or
 * upload. printing.js awaits this promise to know when to hide its
 * "Uploading…" indicator and start the 60s kiosk timer. If this promise
 * never settles, the guest is stuck on Page 6 forever. Everything below
 * is wrapped so that a single guaranteed resolveGalleryUrl() call always
 * happens, via a try/catch/finally plus an upload timeout.
 */

const GALLERY_BASE_URL = "https://studrio.cc/g/#";
const UPLOAD_TIMEOUT_MS = 20000; // never let a stalled upload hang the guest

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
    return { url: `${GALLERY_BASE_URL}${sessionData.id}` };
  }
};

const qrModule = {
  async generateAndRender() {
    const container = document.getElementById("qrCodeCanvas");
    container.innerHTML = "";

    // Lets printingModule.init() wait for the gallery URL to exist even
    // if auto-print fires before this upload finishes.
    let resolveGalleryUrl;
    sessionState.galleryUrlPromise = new Promise((resolve) => { resolveGalleryUrl = resolve; });

    // Deterministic fallback — known immediately, with zero async work.
    // Whatever else happens below, this is what the QR/print output will
    // use if exports or the upload fail or hang.
    const fallbackGalleryUrl = `${GALLERY_BASE_URL}${sessionState.id}`;
    let resolvedGalleryUrl = fallbackGalleryUrl;

    try {
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

      let printReadyPng = null;
      try {
        printReadyPng = await stripModule.exportPrintPNG({
          frameType: sessionState.frameType,
          selectedShots: sessionState.selectedShots,
          designId: sessionState.design,
          qrText: fallbackGalleryUrl
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

      // Race the actual upload against a hard timeout. A stalled fetch
      // (bad wifi, Supabase hiccup) can hang with no rejection at all —
      // without this, the promise above would never resolve and the
      // guest would be stuck on "Uploading…" indefinitely.
      const timeout = new Promise((resolve) => {
        setTimeout(() => resolve({ url: fallbackGalleryUrl, timedOut: true }), UPLOAD_TIMEOUT_MS);
      });

      const gallery = await Promise.race([
        mediaStorage.createGallery(galleryPayload),
        timeout
      ]);

      if (gallery && gallery.timedOut) {
        console.warn(`[qrModule] Gallery upload did not finish within ${UPLOAD_TIMEOUT_MS}ms — using fallback URL. The session's media may still finish uploading in the background.`);
      }

      resolvedGalleryUrl = (gallery && gallery.url) || fallbackGalleryUrl;
    } catch (e) {
      // Anything unexpected above (a compositing/export failure, a thrown
      // upload error) lands here. We must still resolve with *something*.
      console.error("[qrModule] generateAndRender failed, using fallback gallery URL:", e);
      resolvedGalleryUrl = fallbackGalleryUrl;
    } finally {
      // Guaranteed to run exactly once, regardless of what happened above.
      // This is the line printing.js is actually waiting on.
      sessionState.galleryUrl = resolvedGalleryUrl;
      resolveGalleryUrl(resolvedGalleryUrl);
    }

    try {
      new QRCode(container, {
        text: resolvedGalleryUrl,
        width: 220,
        height: 220,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.L
      });
    } catch (e) {
      console.error("[qrModule] QR render failed:", e);
    }
  }
};
