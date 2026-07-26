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
    muteToggle: document.getElementById("galleryMuteToggle"),
    grid: document.getElementById("galleryMediaGrid"),
    loading: document.getElementById("galleryLoading"),
    notFound: document.getElementById("galleryNotFound"),
    downloadVideoBtn: document.getElementById("btnDownloadVideo"),
    downloadPhotoBtn: document.getElementById("btnDownloadPhoto"),
    toast: document.getElementById("galleryToast")
  },

  blobCache: new Map(),      // url -> resolved Blob
  fetchPromises: new Map(),  // url -> in-flight fetch promise (dedupe)

  /* Fetches and caches a blob in the background, well before any tap.
     Failures here are silent on purpose — the click handler re-tries
     and is the only place that surfaces an error to the user. Doing
     this means the actual download click can run synchronously off
     an already-resolved blob instead of sitting behind an `await`,
     which is what mobile browsers (especially in-app browsers like
     Instagram/TikTok, common for QR-code visitors) need to still treat
     the click as user-initiated and allow the file to save. */
  prefetch(url) {
    if (!url || this.blobCache.has(url) || this.fetchPromises.has(url)) return;
    const p = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        this.blobCache.set(url, blob);
        this.fetchPromises.delete(url);
      })
      .catch((e) => {
        this.fetchPromises.delete(url);
        console.warn("[gallery] Prefetch failed for", url, e);
      });
    this.fetchPromises.set(url, p);
  },

  showToast(message) {
    const el = this.els.toast;
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  },

  /* Core download routine. Resolves a Blob (from cache if we already
     prefetched it, otherwise fetched fresh) and forces a real save via
     a temporary <a download> click — never navigates/opens the file.
     Lifecycle callbacks let each call site show its own loading/error UI. */
  async downloadUrl(url, filename, { onStart, onSuccess, onError } = {}) {
    if (!url) return;
    try {
      let blob = this.blobCache.get(url);
      if (!blob) {
        if (onStart) onStart();
        blob = await (this.fetchPromises.get(url) || fetch(url).then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.blob();
        }));
        this.blobCache.set(url, blob);
      }

      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);

      if (onSuccess) onSuccess();
    } catch (e) {
      console.error("[gallery] Download failed:", e);
      if (onError) onError(e);
    }
  },

  /* Wires a big pinned "Download Photo/Video" button: swaps its label
     while the fetch is in flight, and on failure shows a real
     tappable link (not an auto-opened tab) so the user always has a
     working way to get the file. */
  bindBigDownloadButton(btn, url, filename) {
    const originalLabel = btn.textContent;
    btn.hidden = false;
    this.prefetch(url);

    btn.addEventListener("click", () => {
      this.downloadUrl(url, filename, {
        onStart: () => {
          btn.disabled = true;
          btn.classList.add("is-downloading");
          btn.textContent = "Downloading…";
        },
        onSuccess: () => {
          btn.disabled = false;
          btn.classList.remove("is-downloading");
          btn.textContent = originalLabel;
        },
        onError: () => {
          btn.disabled = false;
          btn.classList.remove("is-downloading");
          this.showToast("Couldn't download the file — check your connection and tap the button again.");
          const fallback = btn.parentElement.querySelector(".gallery-fallback-link") || (() => {
            const a = document.createElement("a");
            a.className = "gallery-fallback-link";
            a.target = "_blank";
            a.rel = "noopener";
            a.textContent = "Open file manually instead";
            btn.insertAdjacentElement("afterend", a);
            return a;
          })();
          fallback.href = url;
          fallback.download = filename;
        }
      });
    });
  },

  /* Wires a small circular icon-only download button used in the
     individual media grid. */
  bindGridDownloadButton(btn, url, filename) {
    if (!url) { btn.disabled = true; return; }
    this.prefetch(url);
    btn.addEventListener("click", () => {
      this.downloadUrl(url, filename, {
        onStart: () => { btn.textContent = "⏳"; btn.disabled = true; },
        onSuccess: () => { btn.textContent = "⬇"; btn.disabled = false; },
        onError: () => {
          btn.textContent = "⚠";
          btn.disabled = false;
          this.showToast("Couldn't download that file — tap it again to retry.");
        }
      });
    });
  },

  toggleMute(videoEl) {
    if (!videoEl || !this.els.muteToggle) return;
    videoEl.muted = !videoEl.muted;
    this.els.muteToggle.textContent = videoEl.muted ? "🔇" : "🔊";
    this.els.muteToggle.setAttribute("aria-label", videoEl.muted ? "Unmute video" : "Mute video");
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

    // ---- Static photo strip (the exact print design) ----
    if (data.finalStripUrl) {
      this.els.photoStripContainer.innerHTML = `<img src="${data.finalStripUrl}" alt="Photo strip">`;
      this.bindBigDownloadButton(this.els.downloadPhotoBtn, data.finalStripUrl, `${data.id}-photo-strip.png`);
    } else if (typeof stripModule !== "undefined") {
      await stripModule.render(this.els.photoStripContainer, {
        frameType: data.frameType,
        selectedShots: data.photos,
        designId: data.design
      });
    }

    // ---- Live video strip: autoplaying, muted, looping like a GIF,
    //      with a small tap-to-unmute control so people can actually
    //      hear it if they want to, without native scrubber controls
    //      cluttering the preview. ----
    if (data.finalStripVideoUrl) {
      this.els.stripContainer.innerHTML = `<video src="${data.finalStripVideoUrl}" autoplay loop muted playsinline></video>`;
      const videoEl = this.els.stripContainer.querySelector("video");

      if (this.els.muteToggle) {
        this.els.muteToggle.hidden = false;
        this.els.muteToggle.onclick = () => this.toggleMute(videoEl);
      }

      this.bindBigDownloadButton(this.els.downloadVideoBtn, data.finalStripVideoUrl, `${data.id}-video-strip.webm`);
    } else if (typeof stripModule !== "undefined") {
      stripModule.renderLive(this.els.stripContainer, {
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

      const isVideo = !!p.videoUrl;
      const mediaUrl = p.videoUrl || p.imageUrl;
      const filename = `${data.id}-photo-${i + 1}.${isVideo ? "webm" : "jpg"}`;

      card.innerHTML = `
        ${isVideo
          ? `<video src="${mediaUrl}" muted loop autoplay playsinline poster="${p.imageUrl || ""}"></video>`
          : `<img src="${mediaUrl || ""}" alt="Photo ${i + 1}">`}
        <div class="gallery-media-card-footer">
          <span class="gallery-media-label">Photo ${i + 1}${isVideo ? " • video" : ""}</span>
          <button class="gallery-media-download" title="Download" aria-label="Download Photo ${i + 1}">⬇</button>
        </div>
      `;

      this.bindGridDownloadButton(card.querySelector(".gallery-media-download"), mediaUrl, filename);
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
