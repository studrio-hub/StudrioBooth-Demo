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
        galleryStore.saveSession(sessionData).catch(() => {}); // best-effort local backup too
        return result;
      } catch (e) {
        console.error("[mediaStorage] Cloud save failed, falling back to local-only:", e);
      }
    }

    console.warn("[mediaStorage] Saving locally to IndexedDB (same-device preview only). Configure cloud-storage.js to make the QR code work on other phones.");
    await galleryStore.saveSession(sessionData);
    return { url: `${window.location.origin}${window.location.pathname}?gallery=${sessionData.id}` };
  }
};

const qrModule = {
  async generateAndRender() {
    const container = document.getElementById("qrCodeCanvas");
    const urlText = document.getElementById("qrUrlText");
    container.innerHTML = "";

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
      galleryUrl = `${window.location.origin}${window.location.pathname}?gallery=${sessionState.id}`;
    }

    urlText.textContent = galleryUrl;

    new QRCode(container, {
      text: galleryUrl,
      width: 130,
      height: 130,
      colorDark: "#000000",
      colorLight: "#ffffff"
    });
  }
};