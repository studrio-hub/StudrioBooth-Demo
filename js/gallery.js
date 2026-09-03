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
   * Every platform gets a standard <a download> blob trigger — this is what
   * actually saves the file to the device (Downloads on Android/desktop,
   * Files app on iOS 13+ that supports it).
   *
   * On iOS specifically we ALSO open the blob in a new tab so the guest has
   * a fallback: some iOS Safari versions silently ignore the download
   * attribute when the click happens after an async fetch (breaks the
   * "user gesture" chain Apple requires), so the anchor-download can
   * silently no-op there. Keeping the long-press-to-save tab open means the
   * guest can always save manually even when the automatic download doesn't
   * fire.
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

      // Always attempt the direct file download first — this is what
      // actually saves to Files/Downloads when the platform supports it.
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();

      if (IS_IOS) {
        // Keep the long-press fallback tab open alongside the download
        // attempt above, in case this iOS version ignores the download
        // attribute for blob URLs triggered after an async fetch.
        window.open(objUrl, "_blank");
        if (!_iosHintShown) {
          _iosHintShown = true;
          _showIosHint(item.type === "video");
        } else {
          showToast("Saving to Files — if nothing happens, long-press the media above");
        }
        setTimeout(() => URL.revokeObjectURL(objUrl), 90000);
      } else {
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
          We've started saving this to your <strong>Files</strong> app.
          ${isVideo
            ? "If nothing happens, the video also opened in a new tab — tap and hold it, then choose <strong>Save to Files</strong>."
            : "If nothing happens, the photo also opened in a new tab — tap and hold it, then choose <strong>Add to Photos</strong> or <strong>Save to Files</strong>."}
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
    // Hide loading immediately — we have data, whatever happens next
    if (els.loading) els.loading.hidden = true;

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
      // Session exists but no media URLs yet — show processing state, not "not found"
      if (els.loading) {
        els.loading.innerHTML = `
          <div class="gallery-loading-spinner"></div>
          <span>Your gallery is still processing —<br>check back in a moment.</span>`;
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

    // Arrow buttons — wire once, guard against double-wiring
    if (els.navPrev && !els.navPrev._wired) {
      els.navPrev._wired = true;
      els.navPrev.addEventListener("click", () => goTo(_current - 1));
    }
    if (els.navNext && !els.navNext._wired) {
      els.navNext._wired = true;
      els.navNext.addEventListener("click", () => goTo(_current + 1));
    }

    // Native scroll → sync UI
    if (els.carousel && !els.carousel._wired) {
      els.carousel._wired = true;
      els.carousel.addEventListener("scroll", _onCarouselScroll, { passive: true });
    }

    // Initial state
    _syncUI();
  }

  // ── Session ID from URL hash ──────────────────────────────────────────────
  function getSessionIdFromHash() {
    return window.location.hash.replace(/^#/, "").trim() || null;
  }

  // ── Show not-found state ──────────────────────────────────────────────────
  function showNotFound() {
    if (els.loading) els.loading.hidden = true;
    if (els.notFound) els.notFound.hidden = false;
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    const galleryId = getSessionIdFromHash();
    console.log("[gallery] Session ID from hash:", galleryId);

    if (!galleryId) {
      showNotFound();
      return;
    }

    // Check cloudStorage availability with diagnostics
    if (typeof cloudStorage === "undefined") {
      console.error("[gallery] cloudStorage is not defined — cloud-storage.js may not have loaded.");
      showNotFound();
      return;
    }

    const available = cloudStorage.isAvailable();
    console.log("[gallery] cloudStorage.isAvailable():", available);

    if (!available) {
      console.error("[gallery] cloudStorage reports unavailable — Supabase client may not have initialized. Check CLOUD_CONFIG / supabase credentials in cloud-storage.js.");
      showNotFound();
      return;
    }

    let data = null;
    try {
      data = await cloudStorage.getSession(galleryId);
      console.log("[gallery] getSession() returned:", data
        ? `id=${data.id}, stripUrl=${!!data.finalStripUrl}, videoUrl=${!!data.finalStripVideoUrl}, photos=${(data.individualPhotoUrls||[]).length}`
        : "null");
    } catch (e) {
      console.error("[gallery] getSession() threw:", e);
    }

    if (!data) {
      showNotFound();
      return;
    }

    render(data);
  }

  init();
})();
