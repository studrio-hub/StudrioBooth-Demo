/*
 * GALLERY.JS — FotoShare-style carousel gallery for g/index.html.
 *
 * Media items shown (in order):
 *   1. Photo strip (finalStripUrl)          → label "Photo Strip"
 *   2. Individual photos × up to 4          → label "Photo 1" … "Photo 4"
 *   3. Stitched video (finalStripVideoUrl)  → label "Video"
 *
 * Each item has a prominent download button (top-right corner).
 * Download behavior:
 *   - iOS Safari: opens the blob URL in a new tab so the user can long-press
 *     → "Add to Photos" / "Save to Files". A one-time hint sheet explains
 *     this on the first download so guests know what to do.
 *   - Android / desktop: standard <a download> blob trigger — saves directly
 *     to the device gallery / Downloads.
 *
 * Carousel: horizontal scroll-snap + arrow buttons + filmstrip thumbnails.
 * Swipe works natively via CSS scroll-snap; arrows call scrollTo().
 *
 * URL format: https://studrio.cc/g/#<sessionId>
 */

(function () {
  "use strict";

  // ── Platform detection ────────────────────────────────────────────────────
  const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
                 (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const IS_ANDROID = /android/i.test(navigator.userAgent);

  // Whether the iOS save-hint has been shown this session
  let _iosHintShown = false;

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    page:        $("galleryPage"),
    loading:     $("galleryLoading"),
    notFound:    $("galleryNotFound"),
    toast:       $("galleryToast"),
    carousel:    $("galleryCarousel"),
    filmstrip:   $("galleryFilmstrip"),
    navPrev:     $("galleryNavPrev"),
    navNext:     $("galleryNavNext"),
    footer:      document.querySelector(".gallery-footer")
  };

  // ── Slide / item state ────────────────────────────────────────────────────
  let _items   = [];   // { type, url, label, mimeExt }
  let _current = 0;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function extOf(url, fallback) {
    const m = /\.([a-zA-Z0-9]+)(?:\?[^.]*)?$/.exec(url || "");
    return m ? m[1].toLowerCase() : fallback;
  }

  function showToast(msg, duration = 2800) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.classList.add("is-visible");
    clearTimeout(els.toast._timer);
    els.toast._timer = setTimeout(() => els.toast.classList.remove("is-visible"), duration);
  }

  // ── Download logic ────────────────────────────────────────────────────────
  /*
   * On iOS, the browser blocks <a download> for cross-origin blob URLs and
   * doesn't save anything to the Photos app. Instead we open the blob URL in
   * a new tab, where the user can long-press the image/video and choose
   * "Add to Photos" or "Save to Files".
   *
   * On Android / desktop, a standard anchor click with the download attribute
   * triggers the OS save-to-gallery / Downloads flow.
   *
   * We fetch first so both paths work for cross-origin Supabase URLs.
   */
  async function downloadItem(item, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add("is-downloading");

    // Swap icon → spinner
    const iconEl = btn.querySelector(".gallery-dl-icon");
    const spinEl = btn.querySelector(".gallery-dl-spinner");
    if (iconEl) iconEl.style.display = "none";
    if (spinEl) spinEl.style.display = "";

    try {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const filename = `studrio-${item.label.replace(/\s+/g, "-").toLowerCase()}.${item.mimeExt}`;

      if (IS_IOS) {
        // Open in new tab — user long-presses to save
        window.open(objUrl, "_blank");
        // Show one-time hint
        if (!_iosHintShown) {
          _iosHintShown = true;
          _showIosHint(item.type === "video");
        } else {
          const action = item.type === "video" ? "hold the video → Save to Files" : "hold the photo → Add to Photos";
          showToast(`Long-${action}`);
        }
        // Revoke after a generous delay so the new tab has time to use it
        setTimeout(() => URL.revokeObjectURL(objUrl), 90000);
      } else {
        // Android / desktop: standard anchor download
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 15000);
        showToast(item.type === "video" ? "Video saved" : "Photo saved");
      }
    } catch (e) {
      console.error("[gallery] Download failed:", e);
      showToast("Download failed — tap to retry");
    } finally {
      // Restore icon
      if (iconEl) iconEl.style.display = "";
      if (spinEl) spinEl.style.display = "none";
      btn.disabled = false;
      btn.classList.remove("is-downloading");
    }
  }

  // ── iOS hint sheet ────────────────────────────────────────────────────────
  function _showIosHint(isVideo) {
    const existing = document.querySelector(".gallery-ios-hint");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "gallery-ios-hint";
    overlay.innerHTML = `
      <div class="gallery-ios-hint-sheet">
        <h2>${isVideo ? "Save Video" : "Save Photo"}</h2>
        <p>
          ${isVideo
            ? "The video opened in a new tab. Tap and hold it, then choose <strong>Save to Files</strong> or <strong>Download</strong>."
            : "The photo opened in a new tab. Tap and hold it, then choose <strong>Add to Photos</strong>."}
        </p>
        <button class="gallery-ios-hint-ok">Got it</button>
      </div>`;
    overlay.querySelector(".gallery-ios-hint-ok").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // ── Download button HTML ──────────────────────────────────────────────────
  function _makeDownloadBtn(item) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gallery-slide-download";
    btn.setAttribute("aria-label", `Download ${item.label}`);
    btn.innerHTML = `
      <svg class="gallery-dl-icon" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3v13M7 11l5 5 5-5"/>
        <path d="M5 21h14"/>
      </svg>
      <div class="gallery-dl-spinner" style="display:none;"></div>`;
    btn.addEventListener("click", () => downloadItem(item, btn));
    return btn;
  }

  // ── Build slides ──────────────────────────────────────────────────────────
  function _buildSlide(item, index, total) {
    const slide = document.createElement("div");
    slide.className = "gallery-slide";
    slide.dataset.index = index;

    // Media element
    let mediaEl;
    if (item.type === "video") {
      mediaEl = document.createElement("video");
      mediaEl.src = item.url;
      mediaEl.loop = true;
      mediaEl.muted = true;
      mediaEl.playsInline = true;
      mediaEl.setAttribute("playsinline", "");
      mediaEl.setAttribute("controls", ""); // native controls so user can scrub
    } else {
      mediaEl = document.createElement("img");
      mediaEl.src = item.url;
      mediaEl.alt = item.label;
    }
    slide.appendChild(mediaEl);

    // Counter badge
    const counter = document.createElement("div");
    counter.className = "gallery-slide-counter";
    counter.textContent = `${index + 1} / ${total}`;
    slide.appendChild(counter);

    // Download button
    slide.appendChild(_makeDownloadBtn(item));

    // Bottom label bar
    const labelBar = document.createElement("div");
    labelBar.className = "gallery-slide-label";
    labelBar.innerHTML = `<span class="gallery-slide-label-text">${item.label}</span>`;
    slide.appendChild(labelBar);

    return slide;
  }

  // ── Build filmstrip thumbnail ──────────────────────────────────────────────
  function _buildThumb(item, index) {
    const thumb = document.createElement("div");
    thumb.className = "gallery-thumb";
    thumb.dataset.index = index;

    if (item.type === "video") {
      // Use a muted video element for the thumbnail; shows first frame
      const vid = document.createElement("video");
      vid.src = item.url;
      vid.muted = true;
      vid.playsInline = true;
      vid.preload = "metadata";
      // Seek to 0.5s to grab a representative frame rather than a black frame
      vid.addEventListener("loadedmetadata", () => { vid.currentTime = 0.5; }, { once: true });
      thumb.appendChild(vid);

      // Play icon overlay
      const playOverlay = document.createElement("div");
      playOverlay.className = "gallery-thumb-play";
      playOverlay.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z"/>
        </svg>`;
      thumb.appendChild(playOverlay);
    } else {
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = item.label;
      thumb.appendChild(img);
    }

    thumb.addEventListener("click", () => goTo(index));
    return thumb;
  }

  // ── Carousel navigation ───────────────────────────────────────────────────
  function goTo(index) {
    if (!els.carousel) return;
    _current = Math.max(0, Math.min(index, _items.length - 1));

    // Scroll carousel to the target slide
    const slideWidth = els.carousel.clientWidth;
    els.carousel.scrollTo({ left: _current * slideWidth, behavior: "smooth" });

    _syncUI();
  }

  function _syncUI() {
    // Thumbnails active state
    document.querySelectorAll(".gallery-thumb").forEach((t) => {
      t.classList.toggle("is-active", Number(t.dataset.index) === _current);
    });

    // Scroll active thumb into view within the filmstrip
    const activeThumb = els.filmstrip && els.filmstrip.querySelector(`.gallery-thumb[data-index="${_current}"]`);
    if (activeThumb) {
      activeThumb.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }

    // Arrow visibility
    if (els.navPrev) els.navPrev.hidden = _current === 0;
    if (els.navNext) els.navNext.hidden = _current === _items.length - 1;

    // Pause all videos except the one on the current slide; play it if ready
    document.querySelectorAll(".gallery-slide video[src]").forEach((v) => {
      const slideIndex = Number(v.closest(".gallery-slide").dataset.index);
      if (slideIndex === _current) {
        v.play().catch(() => {});
      } else {
        v.pause();
      }
    });
  }

  // Track slide index from native scroll (swipe)
  function _onCarouselScroll() {
    if (!els.carousel) return;
    const slideWidth = els.carousel.clientWidth;
    if (!slideWidth) return;
    const idx = Math.round(els.carousel.scrollLeft / slideWidth);
    if (idx !== _current) {
      _current = idx;
      _syncUI();
    }
  }

  // ── Render from session data ──────────────────────────────────────────────
  function render(data) {
    // Build items list: strip → individual photos → video
    _items = [];

    if (data.finalStripUrl) {
      _items.push({
        type:    "image",
        url:     data.finalStripUrl,
        label:   "Photo Strip",
        mimeExt: extOf(data.finalStripUrl, "jpg")
      });
    }

    const photoUrls = (data.individualPhotoUrls || []).filter(Boolean);
    photoUrls.forEach((url, i) => {
      _items.push({
        type:    "image",
        url,
        label:   `Photo ${i + 1}`,
        mimeExt: extOf(url, "jpg")
      });
    });

    if (data.finalStripVideoUrl) {
      _items.push({
        type:    "video",
        url:     data.finalStripVideoUrl,
        label:   "Video",
        mimeExt: extOf(data.finalStripVideoUrl, "webm")
      });
    }

    if (!_items.length) {
      // Nothing to show yet
      if (els.loading) {
        els.loading.innerHTML = `
          <div class="gallery-loading-spinner"></div>
          <span>Your gallery is still processing — check back in a moment.</span>`;
        els.loading.hidden = false;
      }
      return;
    }

    const total = _items.length;

    // Build slides
    _items.forEach((item, i) => {
      const slide = _buildSlide(item, i, total);
      els.carousel.appendChild(slide);
    });

    // Build filmstrip
    _items.forEach((item, i) => {
      const thumb = _buildThumb(item, i);
      els.filmstrip.appendChild(thumb);
    });

    // Arrow buttons
    if (els.navPrev) {
      els.navPrev.addEventListener("click", () => goTo(_current - 1));
    }
    if (els.navNext) {
      els.navNext.addEventListener("click", () => goTo(_current + 1));
    }

    // Native scroll → sync UI
    if (els.carousel) {
      els.carousel.addEventListener("scroll", _onCarouselScroll, { passive: true });
    }

    // Initial state
    _syncUI();

    // Show carousel area, hide loading
    if (els.loading) els.loading.hidden = true;
  }

  // ── Session ID from URL hash ──────────────────────────────────────────────
  function getSessionIdFromHash() {
    return window.location.hash.replace(/^#/, "").trim() || null;
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    const galleryId = getSessionIdFromHash();

    if (!galleryId) {
      if (els.loading) els.loading.hidden = true;
      if (els.notFound) els.notFound.hidden = false;
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

    if (!data) {
      if (els.loading) els.loading.hidden = true;
      if (els.notFound) els.notFound.hidden = false;
      return;
    }

    render(data);
  }

  init();
})();
