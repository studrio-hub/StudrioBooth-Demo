/*
 * GALLERY.JS — digital gallery for the QR/video experience.
 * Tries cloud (Supabase) first when ?cloud=1 is present, falls back
 * to local IndexedDB (same-device preview only) otherwise.
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

  async saveSession(sessionData) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(sessionData);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
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
    grid: document.getElementById("galleryMediaGrid"),
    stripContainer: document.getElementById("galleryStripContainer"),
    loading: document.getElementById("galleryLoading"),
    notFound: document.getElementById("galleryNotFound"),
    photoStripContainer: document.getElementById("galleryPhotoStripContainer")
  },

  async renderFromId(sessionId, fromCloud = false) {
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
          p.imageUrl = p.image ? URL.createObjectURL(p.image) : null;
          p.videoUrl = p.video ? URL.createObjectURL(p.video) : null;
        });
        if (local.finalStripPng) {
          local.finalStripUrl = URL.createObjectURL(local.finalStripPng);
        }
        if (local.finalStripVideo) {
          local.finalStripVideoUrl = URL.createObjectURL(local.finalStripVideo);
        }
        data = local;
      }
    }

    this.els.loading.hidden = true;

    if (!data) {
      this.els.notFound.hidden = false;
      return;
    }

    // Prefer the single combined recorded video if available; otherwise
    // fall back to the DOM-based live strip (individual <video> tags).
    if (data.finalStripVideoUrl) {
      this.els.stripContainer.innerHTML = `<video src="${data.finalStripVideoUrl}" class="layout-canvas" autoplay loop muted playsinline controls></video>`;
    } else {
      stripModule.renderLive(this.els.stripContainer, {
        frameType: data.frameType,
        selectedShots: data.photos,
        designId: data.design
      });
    }

    if (data.finalStripUrl) {
      this.els.photoStripContainer.innerHTML = `<img src="${data.finalStripUrl}" class="layout-canvas" alt="Photo strip">`;
    } else {
      await stripModule.render(this.els.photoStripContainer, {
        frameType: data.frameType,
        selectedShots: data.photos,
        designId: data.design
      });
    }

    this.els.grid.innerHTML = "";
    data.photos.forEach((p, i) => {
      const card = document.createElement("div");
      card.className = "gallery-media-card";
      if (p.videoUrl) {
        card.innerHTML = `
          <video src="${p.videoUrl}" controls poster="${p.imageUrl || ""}" playsinline></video>
          <span class="gallery-media-label">Photo ${i + 1} • video</span>
        `;
      } else {
        card.innerHTML = `
          <img src="${p.imageUrl || ""}" alt="Photo ${i + 1}">
          <span class="gallery-media-label">Photo ${i + 1}</span>
        `;
      }
      this.els.grid.appendChild(card);
    });
  }
};

/* Auto-detect ?gallery=<id> in the URL and switch into gallery view */
(function checkGalleryRoute() {
  const params = new URLSearchParams(window.location.search);
  const galleryId = params.get("gallery");
  if (!galleryId) return;

  const fromCloud = params.get("cloud") === "1";

  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.getElementById("page-gallery").classList.add("active");
  document.getElementById("kiosk").classList.add("gallery-mode");

  galleryModule.renderFromId(galleryId, fromCloud);
})();