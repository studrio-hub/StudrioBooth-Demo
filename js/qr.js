/*
 * QR.JS — QR code generation + digital gallery abstraction.
 *
 * mediaStorage.createGallery() tries cloudStorage (Supabase) first;
 * if unavailable or it fails, falls back to local-only IndexedDB
 * storage (same-device preview only — see gallery.js for details).
 */

const mediaStorage = {
  async createGallery(sessionData) {
    if (cloudStorage.isAvailable()) {
      try {
        const result = await cloudStorage.saveSession(sessionData);
        galleryStore.saveSession(sessionData).catch(() => {});
        return result;
      } catch (e) {
        console.error("[mediaStorage] Cloud save failed, falling back to local-only:", e);
      }
    }

    console.warn("[mediaStorage] Saving locally to IndexedDB (same-device preview only). Configure cloud-storage.js to make the QR code work on other phones.");
    await galleryStore.saveSession(sessionData);
    return { url: `${window.location.origin}${window.location.pathname.replace("index.html", "")}gallery.html?gallery=${sessionData.id}` };
  }
};

const qrModule = {
  async generateAndRender() {
    const container = document.getElementById("qrCodeCanvas");
    const urlText = document.getElementById("qrUrlText");
    container.innerHTML = "";

    // Lets printingModule.print() wait for the gallery URL to exist even
    // if the guest hits "PRINT NOW" before this upload finishes.
    let resolveGalleryUrl;
    sessionState.galleryUrlPromise = new Promise((resolve) => { resolveGalleryUrl = resolve; });

    urlText.textContent = "Compositing photo strip...";
    const finalStripPng = await stripModule.exportPNG({
      frameType: sessionState.frameType,
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design
    });

    urlText.textContent = "Recording video strip...";
    const finalStripVideo = await stripModule.exportVideoStrip({
      frameType: sessionState.frameType,
      selectedShots: sessionState.selectedShots,
      designId: sessionState.design
    });

    urlText.textContent = "Uploading...";
    const galleryPayload = {
      id: sessionState.id,
      frameType: sessionState.frameType,
      design: sessionState.design,
      finalStripPng,
      finalStripVideo,
      photos: sessionState.selectedShots.map((s) => ({
        id: s.id,
        image: s.image
      }))
    };

    let galleryUrl;
    try {
      const gallery = await mediaStorage.createGallery(galleryPayload);
      galleryUrl = gallery.url;
    } catch (e) {
      console.error("Gallery creation failed:", e);
      galleryUrl = `${window.location.origin}${window.location.pathname.replace("index.html", "")}gallery.html?gallery=${sessionState.id}`;
    }

    urlText.textContent = galleryUrl;
    sessionState.galleryUrl = galleryUrl;
    resolveGalleryUrl(galleryUrl);

    new QRCode(container, {
      text: galleryUrl,
      width: 220,
      height: 220,
      colorDark: "#000000",
      colorLight: "#ffffff",
      // L = lowest error-correction overhead → fewer modules needed for
      // the same URL, so each module renders bigger and scans easier.
      // Safe here because the URL is short and machine-printed (no risk
      // of smudging/damage the way a handled paper card would have).
      correctLevel: QRCode.CorrectLevel.L
    });
  }
};