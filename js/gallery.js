/*
 * GALLERY.JS — standalone digital gallery logic for g/index.html.
 * Cloud-only, no local IndexedDB fallback, no dependency on
 * stripModule/layout-config.
 *
 * URL format: https://studrio.cc/g/#<sessionId>
 * e.g. https://studrio.cc/g/#2ydgshd
 *
 * The session ID is read from window.location.hash (everything after "#").
 * Hash-based routing means GitHub Pages just serves /g/index.html and
 * requires zero rewrite rules or hosting configuration.
 */

(function () {
  const els = {
    stripContainer: document.getElementById("galleryStripContainer"),
    loading: document.getElementById("galleryLoading"),
    notFound: document.getElementById("galleryNotFound"),
    downloadPhotoBtn: document.getElementById("btnDownloadPhoto"),
    downloadVideoBtn: document.getElementById("btnDownloadVideo"),
    // downloadQrBtn: document.getElementById("btnDownloadQR") // Removed per user request
    photoGrid: document.getElementById("galleryPhotoGrid")
  };

  function extOf(url, fallback) {
    const m = /\.([a-zA-Z0-9]+)(?:\?.*)?$/.exec(url || "");
    return m ? m[1] : fallback;
  }

  function downloadFile(url, filename, btn) {
    if (!url) return;
    const subtitleEl = btn.querySelector(".gallery-download-subtitle");
    const original = subtitleEl ? subtitleEl.textContent : "";
    btn.disabled = true;
    btn.classList.add("is-downloading");
    if (subtitleEl) subtitleEl.textContent = "Downloading…";

    fetch(url)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.blob(); })
      .then((blob) => {
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
        btn.disabled = false;
        btn.classList.remove("is-downloading");
        if (subtitleEl) subtitleEl.textContent = original;
      })
      .catch((e) => {
        console.error("[gallery] Download failed:", e);
        btn.disabled = false;
        btn.classList.remove("is-downloading");
        if (subtitleEl) subtitleEl.textContent = "Tap to retry";
      });
  }

  function render(data) {
    const photoUrl = data.finalStripUrl || null;
    const videoUrl = data.finalStripVideoUrl || null;
    // const qrUrl    = data.printReadyUrl || null; // Removed from gallery per user request

    // ---- Main strip preview ----
    // Minor Fix: the photo strip is now the primary preview (previously the
    // video strip was preferred). The video — now a single stitched clip
    // (Video 1 → 2 → 3 → 4, see stripModule.exportStitchedVideo) rather
    // than the old multi-slot composite — loads hidden and swaps in once
    // it can actually play, same progressive photo-then-video behavior as
    // the Print & QR page. If the video never loads, the photo just stays.
    els.stripContainer.innerHTML = "";
    if (photoUrl) {
      const img = document.createElement("img");
      img.src = photoUrl;
      img.alt = "Photo strip";
      els.stripContainer.appendChild(img);
    } else if (!videoUrl) {
      els.stripContainer.innerHTML = `<p class="gallery-status">Your strip is still processing — check back in a moment.</p>`;
    }

    if (videoUrl) {
      const videoEl = document.createElement("video");
      videoEl.src = videoUrl;
      videoEl.loop = true;
      videoEl.muted = true;        // must be muted for autoplay to work cross-browser
      videoEl.playsInline = true;
      videoEl.setAttribute("playsinline", "");
      videoEl.style.display = "none"; // stays hidden until it can actually play
      videoEl.addEventListener("canplay", () => {
        // Swap the photo out only once the video is actually ready to
        // replace it, so there's never a moment showing neither.
        const img = els.stripContainer.querySelector("img");
        if (img) img.remove();
        videoEl.style.display = "";
        videoEl.play().catch((e) => console.warn("[gallery] Video autoplay blocked:", e));
      }, { once: true });
      videoEl.onerror = () => {
        // If the video fails to load, the photo strip (already showing) just stays.
        console.warn("[gallery] Video load failed — keeping the photo strip.");
        videoEl.remove();
      };
      els.stripContainer.appendChild(videoEl);
    }

    // ---- Download buttons ----
    if (photoUrl && els.downloadPhotoBtn) {
      els.downloadPhotoBtn.hidden = false;
      els.downloadPhotoBtn.addEventListener("click", () => {
        downloadFile(photoUrl, `${data.id}-photo-strip.${extOf(photoUrl, "jpg")}`, els.downloadPhotoBtn);
      });
    }
    if (videoUrl && els.downloadVideoBtn) {
      els.downloadVideoBtn.hidden = false;
      els.downloadVideoBtn.addEventListener("click", () => {
        downloadFile(videoUrl, `${data.id}-video-strip.${extOf(videoUrl, "webm")}`, els.downloadVideoBtn);
      });
    }
    // QR download logic removed from gallery per user request (admin panel only)

    // ---- Individual photo grid ----
    // NOTE: expects data.individualPhotoUrls — a new array of up to 4
    // public URLs for the compressed individual photos qr.js now prepares
    // (see qrModule._compressIndividualPhotos). cloud-storage.js needs to
    // upload sessionState.individualPhotos and write the resulting URLs
    // back under this field for a session record; until it does, the grid
    // just stays hidden.
    renderPhotoGrid(data.individualPhotoUrls, data.id);
  }

  /* Renders up to 4 individually-downloadable photos below the main strip.
     Each photo gets a small square download button pinned to its
     upper-right corner. Hides the whole section if there's nothing to show. */
  function renderPhotoGrid(urls, sessionId) {
    if (!els.photoGrid) return;
    els.photoGrid.innerHTML = "";

    const valid = (urls || []).filter(Boolean);
    if (!valid.length) {
      els.photoGrid.hidden = true;
      return;
    }
    els.photoGrid.hidden = false;

    valid.forEach((url, i) => {
      const cell = document.createElement("div");
      cell.className = "gallery-grid-photo";

      const img = document.createElement("img");
      img.src = url;
      img.alt = `Photo ${i + 1}`;
      cell.appendChild(img);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gallery-grid-download-btn";
      btn.setAttribute("aria-label", `Download photo ${i + 1}`);
      btn.textContent = "⬇";
      btn.addEventListener("click", () => {
        downloadFile(url, `${sessionId}-photo-${i + 1}.${extOf(url, "jpg")}`, btn);
      });
      cell.appendChild(btn);

      els.photoGrid.appendChild(cell);
    });
  }

  function getSessionIdFromHash() {
    // URL format: https://studrio.cc/g/#2ydgshd
    // window.location.hash is "#2ydgshd" — strip the leading "#".
    const hash = window.location.hash.replace(/^#/, "").trim();
    return hash || null;
  }

  async function init() {
    const galleryId = getSessionIdFromHash();

    if (!galleryId) {
      els.loading.hidden = true;
      els.notFound.hidden = false;
      return;
    }

    let data = null;
    if (typeof cloudStorage !== "undefined" && cloudStorage.isAvailable()) {
      try {
        data = await cloudStorage.getSession(galleryId);
      } catch (e) {
        console.error("[gallery] Cloud fetch failed:", e);
      }
    }

    els.loading.hidden = true;

    if (!data) {
      els.notFound.hidden = false;
      return;
    }

    render(data);
  }

  init();
})();
