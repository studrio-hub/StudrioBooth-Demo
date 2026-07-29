/*
 * GALLERY.JS — standalone digital gallery logic for g/index.html.
 * Ported directly from the proven kiosk "Preview Digital Gallery"
 * popup logic — cloud-only, no local IndexedDB fallback, no
 * dependency on stripModule/layout-config. Simpler and matches
 * what's already confirmed working.
 *
 * URL format: https://studrio.cc/g/{sessionId}
 * The session ID is the last non-empty path segment of
 * window.location.pathname, e.g. "/g/2ydgshd" → "2ydgshd".
 * There is no ?gallery= query param in this format.
 */

(function () {
  const els = {
    stripContainer: document.getElementById("galleryStripContainer"),
    muteToggle: document.getElementById("galleryMuteToggle"),
    loading: document.getElementById("galleryLoading"),
    notFound: document.getElementById("galleryNotFound"),
    downloadPhotoBtn: document.getElementById("btnDownloadPhoto"),
    downloadVideoBtn: document.getElementById("btnDownloadVideo")
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

    // ---- Main strip preview ----
    if (videoUrl) {
      els.stripContainer.innerHTML = `<video src="${videoUrl}" autoplay loop muted playsinline></video>`;
      const videoEl = els.stripContainer.querySelector("video");
      if (els.muteToggle) {
        els.stripContainer.appendChild(els.muteToggle);
        els.muteToggle.hidden = false;
        els.muteToggle.onclick = () => {
          videoEl.muted = !videoEl.muted;
          els.muteToggle.textContent = videoEl.muted ? "🔇" : "🔊";
        };
      }
    } else if (photoUrl) {
      els.stripContainer.innerHTML = `<img src="${photoUrl}" alt="Photo strip">`;
    } else {
      els.stripContainer.innerHTML = `<p class="gallery-status">Your strip is still processing — check back in a moment.</p>`;
    }

    // ---- Download buttons ----
    if (photoUrl && els.downloadPhotoBtn) {
      els.downloadPhotoBtn.hidden = false;
      els.downloadPhotoBtn.addEventListener("click", () => {
        downloadFile(photoUrl, `${data.id}-photo-strip.png`, els.downloadPhotoBtn);
      });
    }
    if (videoUrl && els.downloadVideoBtn) {
      els.downloadVideoBtn.hidden = false;
      els.downloadVideoBtn.addEventListener("click", () => {
        downloadFile(videoUrl, `${data.id}-video-strip.${extOf(videoUrl, "webm")}`, els.downloadVideoBtn);
      });
    }
  }

  function getSessionIdFromPath() {
    // URL format: https://studrio.cc/g/{sessionId}
    // pathname is "/g/2ydgshd" — take the last non-empty segment.
    const segments = window.location.pathname.split("/").filter(Boolean);
    const id = segments[segments.length - 1];
    // Reject "g" itself (bare /g/ with no ID) and anything that looks
    // like a filename with an extension (shouldn't happen, but be safe).
    if (!id || id === "g" || /\.\w+$/.test(id)) return null;
    return id;
  }

  async function init() {
    const galleryId = getSessionIdFromPath();

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
