/*
 * QR.JS — QR code generation + digital gallery abstraction.
 *
 * IMPORTANT — read this before wiring a real deployment:
 * GitHub Pages is a static host. It can serve the frontend, but
 * it CANNOT receive uploads, run a database, or persist customer
 * photos/videos long-term. mediaStorage below is an interface —
 * plug in a real backend (Firebase, Supabase, S3 + a small API,
 * your own Node server, etc.) that implements uploadMedia() and
 * createGallery(). Until that exists, this file falls back to a
 * MOCK gallery that just encodes the session data into the URL
 * itself (fine for local testing, NOT fine for real videos/photos
 * at scale — URLs have practical length limits).
 */

const mediaStorage = {
  // Set this once you have a real backend. Leave null to use the mock.
  backendUrl: null, // e.g. "https://your-backend.example.com/api"

  async uploadMedia(mediaBlob, filename) {
    if (!this.backendUrl) {
      console.warn("[mediaStorage] No backend configured — mock upload only.");
      return { url: null, mock: true };
    }
    const formData = new FormData();
    formData.append("file", mediaBlob, filename);
    const res = await fetch(`${this.backendUrl}/upload`, { method: "POST", body: formData });
    return res.json(); // expected: { url: "https://.../file.jpg" }
  },

  async createGallery(sessionData) {
    if (!this.backendUrl) {
      // MOCK: no real hosting — just generate a local session id.
      // The QR will point at a URL that won't resolve anywhere real
      // until a backend exists. Clearly logged so it's not mistaken
      // for working infrastructure.
      console.warn("[mediaStorage] MOCK gallery — QR will not resolve publicly until a backend is connected.");
      return { url: `${window.location.origin}${window.location.pathname}#/gallery/${sessionData.id}` };
    }

    const res = await fetch(`${this.backendUrl}/gallery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionData)
    });
    return res.json(); // expected: { url: "https://your-domain.com/gallery/session-12345" }
  }
};

const qrModule = {
  async generateAndRender() {
    const container = document.getElementById("qrCodeCanvas");
    const urlText = document.getElementById("qrUrlText");
    container.innerHTML = "";
    urlText.textContent = "Generating gallery link...";

    const galleryPayload = {
      id: sessionState.id,
      frameType: sessionState.frameType,
      design: sessionState.design,
      photos: sessionState.selectedShots.map((s) => ({ id: s.id, hasVideo: !!s.videoUrl }))
      // Real implementation: upload each selectedShots[i].image / .video
      // via mediaStorage.uploadMedia() first, then pass the resulting
      // URLs here instead of raw blobs.
    };

    let galleryUrl;
    try {
      const gallery = await mediaStorage.createGallery(galleryPayload);
      galleryUrl = gallery.url;
    } catch (e) {
      console.error("Gallery creation failed:", e);
      galleryUrl = `${window.location.origin}${window.location.pathname}#/gallery/${sessionState.id}`;
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