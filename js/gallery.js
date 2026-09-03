/*
 * GALLERY.JS — FotoShare-style carousel gallery for g/index.html.
 *
 * Media items shown (in order):
 *   1. Photo strip (finalStripUrl)          → label "Photo Strip"
 *   2. Individual photos × up to 4          → label "Photo 1" … "Photo 4"
 *   3. Stitched video (finalStripVideoUrl)  → label "Video"
 *
 * Each item has a prominent download button (top-right corner).
 *
 * Download behavior — identical on every platform, no UA branching:
 *   fetch the file → get a blob → hand it to saveBlob(), which prefers the
 *   Web Share API (navigator.share with a File) when the browser supports
 *   sharing files, and falls back to a plain <a download> blob trigger
 *   everywhere else (mainly desktop browsers, which don't support sharing
 *   files). Web Share is what gives iOS a genuine native "Save Image" /
 *   "Save Video" action — no new tab, no long-press, no custom hint sheet.
 *
 * Carousel: horizontal scroll-snap + arrow buttons + filmstrip thumbnails.
 * Swipe works natively via CSS scroll-snap; arrows call scrollTo().
 *
 * URL format: https://studrio.cc/g/#<sessionId>
 */

(function () {
  "use strict";

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
   * Same fetch → blob → save call on every platform; no UA branching, no
   * popup, no instructions. saveBlob() below is what actually adapts to
   * what the platform supports.
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
      const filename = `studrio-${item.label.replace(/\s+/g, "-").toLowerCase()}.${item.mimeExt}`;
      await saveBlob(blob, filename, item.type);
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

  /*
   * Saves an already-fetched blob to the device.
   *
   * Minor Fix — iOS: the previous version opened the blob in a new tab and
   * showed a "long-press → Add to Photos / Save to Files" hint sheet,
   * because a plain <a download> click doesn't reliably save on iOS
   * Safari. Popping a tab after an async fetch also broke the user-gesture
   * chain half the time, so guests saw the hint but nothing actually saved.
   *
   * Real fix: hand the file straight to the OS via the Web Share API
   * (navigator.share with a File). Where that's supported — iOS Safari and
   * Android Chrome both support sharing files — it opens the native share
   * sheet with a genuine "Save Image" / "Save to Photos" action, no custom
   * message needed at all. Desktop browsers generally don't support
   * sharing files, so they transparently fall through to the same
   * <a download> blob trigger every platform already used for the normal
   * (non-iOS) case. Same button, same click handler, same code path
   * everywhere — only the OS-level save mechanism adapts.
   */
  async function saveBlob(blob, filename, type) {
    try {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          return; // saved via the native share sheet
        } catch (err) {
          // AbortError = the guest dismissed the share sheet themselves —
          // that's a cancel, not a failure; don't fall back or show an error.
          if (err && err.name === "AbortError") return;
          // Any other share failure: fall through to the anchor download.
        }
      }
    } catch (e) {
      // File/share construction unsupported in this browser — fall through.
    }

    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking too soon can truncate the save on slower devices or large
    // video files, before the browser's own download manager has finished
    // reading it — give it headroom.
    setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
    showToast(type === "video" ? "Video saved" : "Photo saved");
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

      /*
       * Minor Fix — video long-press only showed a preview, no save option:
       * long-pressing a bare <video> gives a much more limited context menu
       * on mobile than long-pressing a real link to the same file does.
       * Wrap it in an <a> pointing at the actual remote URL (not a blob) so
       * long-press recognizes it as a downloadable file and offers "Save
       * Video" / "Download Linked File" — the same way photos already
       * work via their plain <img>. The click handler below prevents the
       * link from actually navigating on a normal tap (so tapping play/
       * scrub on the native controls doesn't accidentally open a new tab);
       * it has no effect on the OS's own long-press context menu, which is
       * driven by the href, not by this click handler.
       */
      const videoLink = document.createElement("a");
      videoLink.href = item.url;
      videoLink.target = "_blank";
      videoLink.rel = "noopener";
      videoLink.className = "gallery-slide-media-link";
      videoLink.addEventListener("click", (e) => e.preventDefault());
      videoLink.appendChild(mediaEl);
      slide.appendChild(videoLink);
    } else {
      mediaEl = document.createElement("img");
      mediaEl.src = item.url;
      mediaEl.alt = item.label;
      slide.appendChild(mediaEl);
    }

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
