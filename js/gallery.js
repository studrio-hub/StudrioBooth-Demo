/*
 * GALLERY.JS — standalone digital gallery logic, used by gallery.html.
 * This file does NOT touch the camera, does NOT reference #kiosk or
 * .page classes — it's independent of the kiosk app entirely.
 *
 * Reads ?gallery=<id> and optional &cloud=1 from the URL, fetches the
 * session from Supabase (cloud) or IndexedDB (local, same-device
 * preview only — see cloud-storage.js for the cloud setup guide),
 * then renders the photo strip, video strip, individual media grid,
 * and wires up download buttons for each.
 */

const galleryStore = {
  dbPromise: null,

  openDB() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("photobooth-gallery", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("sessions", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  },

  async getSession(id) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const req = tx.objectStore("sessions").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
};

const galleryModule = {
  els: {
    stripContainer: document.getElementById("galleryStripContainer"),
    photoStripContainer: document.getElementById("galleryPhotoStripContainer"),
    grid: document.getElementById("galleryMediaGrid"),
    loading: document.getElementById("galleryLoading"),
    notFound: document.getElementById("galleryNotFound"),
    downloadVideoBtn: document.getElementById("btnDownloadVideo"),
    downloadPhotoBtn: document.getElementById("btnDownloadPhoto")
  },

  /* Fetches a URL (same-origin blob: URL or cross-origin Supabase URL)
     and triggers a real file download rather than navigating to it. */
  async downloadUrl(url, filename) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
    } catch (e) {
      console.error("[gallery] Download failed:", e);
      window.open(url, "_blank"); // fallback: at least let them view/save manually
    }
  },

  async renderFromId(sessionId, fromCloud) {
    this.els.loading.hidden = false;
    this.els.notFound.hidden = true;

    let data = null;

    if (fromCloud && cloudStorage.isAvailable()) {
      try {
        data = await cloudStorage.getSession(sessionId);
      } catch (e) {
        console.error("[gallery] Cloud fetch failed:", e);
      }
    }

    if (!data) {
      const local = await galleryStore.getSession(sessionId);
      if (local) {
        local.photos.forEach((p) => {
          p.imageUrl = p.image ? URL.createObjectURL(p.image) : (p.imageUrl || null);
          p.videoUrl = p.video ? URL.createObjectURL(p.video) : (p.videoUrl || null);
        });
        if (local.finalStripPng) local.finalStripUrl = URL.createObjectURL(local.finalStripPng);
        if (local.finalStripVideo) local.finalStripVideoUrl = URL.createObjectURL(local.finalStripVideo);
        data = local;
      }
    }

    this.els.loading.hidden = true;

    if (!data) {
      this.els.notFound.hidden = false;
      return;
    }

    // ---- Live/recorded video strip ----
    if (data.finalStripVideoUrl) {
      this.els.stripContainer.innerHTML = `<video src="${data.finalStripVideoUrl}" autoplay loop muted playsinline controls></video>`;
      this.els.downloadVideoBtn.hidden = false;
      this.els.downloadVideoBtn.addEventListener("click", () => {
        this.downloadUrl(data.finalStripVideoUrl, `${data.id}-video-strip.webm`);
      });
    } else if (typeof stripModule !== "undefined") {
      stripModule.renderLive(this.els.stripContainer, {
        frameType: data.frameType,
        selectedShots: data.photos,
        designId: data.design
      });
    }

    // ---- Static photo strip (print design) ----
    if (data.finalStripUrl) {
      this.els.photoStripContainer.innerHTML = `<img src="${data.finalStripUrl}" alt="Photo strip">`;
      this.els.downloadPhotoBtn.hidden = false;
      this.els.downloadPhotoBtn.addEventListener("click", () => {
        this.downloadUrl(data.finalStripUrl, `${data.id}-photo-strip.png`);
      });
    } else if (typeof stripModule !== "undefined") {
      await stripModule.render(this.els.photoStripContainer, {
        frameType: data.frameType,
        selectedShots: data.photos,
        designId: data.design
      });
    }

    // ---- Individual photos/videos grid ----
    this.els.grid.innerHTML = "";
    data.photos.forEach((p, i) => {
      const card = document.createElement("div");
      card.className = "gallery-media-card";

      const mediaUrl = p.videoUrl || p.imageUrl;
      const isVideo = !!p.videoUrl;
      const filename = `${data.id}-photo-${i + 1}.${isVideo ? "webm" : "jpg"}`;

      card.innerHTML = `
        ${isVideo
          ? `<video src="${mediaUrl}" controls poster="${p.imageUrl || ""}" playsinline></video>`
          : `<img src="${mediaUrl || ""}" alt="Photo ${i + 1}">`}
        <div class="gallery-media-card-footer">
          <span class="gallery-media-label">Photo ${i + 1}${isVideo ? " • video" : ""}</span>
          <button class="gallery-media-download" title="Download" aria-label="Download">⬇</button>
        </div>
      `;

      card.querySelector(".gallery-media-download").addEventListener("click", () => {
        if (mediaUrl) this.downloadUrl(mediaUrl, filename);
      });

      this.els.grid.appendChild(card);
    });
  }
};

/* Read ?gallery=<id>&cloud=1 from the URL on load */
(function init() {
  const params = new URLSearchParams(window.location.search);
  const galleryId = params.get("gallery");
  const fromCloud = params.get("cloud") === "1";

  if (!galleryId) {
    document.getElementById("galleryLoading").hidden = true;
    document.getElementById("galleryNotFound").hidden = false;
    return;
  }

  galleryModule.renderFromId(galleryId, fromCloud);
})();