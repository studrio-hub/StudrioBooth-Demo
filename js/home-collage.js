/*
 * HOME-COLLAGE.JS — Editorial video collage for the Home page.
 *
 * Reads from HOME_VIDEOS (home-videos.config.js).
 *
 * Each card holds TWO stacked <video> elements (A and B layers).
 * Every ROTATE_INTERVAL ms, the inactive layer loads the next random
 * video, then crossfades in while the active layer fades out.
 * This gives smooth, flicker-free rotation with no black frames.
 *
 * All cards are landscape (matching the source videos).
 * Cards overlap intentionally for a dense editorial collage feel.
 * Size range: ~8% (tiny accent) to ~28% (large hero) of screen width.
 */

const homeCollage = (() => {
  const VIDEO_BASE      = "assets/designs/home-videos/";
  const MAX_CARDS       = 26;       // dense — all slots used
  const ROTATE_INTERVAL = 3000;     // ms between video swaps per card
  const FADE_DURATION   = 600;      // ms crossfade (must match CSS transition)
  const FLOAT_VARIANTS  = 4;

  /*
   * SLOT LAYOUT — 26 cards, all landscape.
   * The protected center zone (logo + Start button) is roughly:
   *   left: 28–72%,  top: 32–68%
   * Everything outside is densely tiled with overlapping cards.
   *
   * Widths range from 8% (tiny) to 28% (large hero).
   * Cards intentionally bleed off edges and overlap each other.
   * z-index is set per card so larger cards sit behind smaller ones.
   */
  const SLOTS = [
    // ── TOP BAND (top: -5 to 28) ─────────────────────────────────────────
    // Hero — top-left bleeds off edge
    { left: -3,  top: -4,  width: 28, aspect: "16/9", z: 1 },
    // Medium — top-left area
    { left: 18,  top:  2,  width: 16, aspect: "4/3",  z: 3 },
    // Small accent — overlaps the medium
    { left: 27,  top: -2,  width: 10, aspect: "16/9", z: 4 },
    // Center-top left
    { left: 20,  top: 18,  width: 13, aspect: "16/9", z: 2 },
    // Center-top right
    { left: 63,  top: 16,  width: 14, aspect: "16/9", z: 2 },
    // Medium top-right area
    { left: 68,  top: -1,  width: 15, aspect: "4/3",  z: 3 },
    // Hero — top-right bleeds off edge
    { left: 77,  top: -3,  width: 26, aspect: "16/9", z: 1 },
    // Tiny accent straddling center-top
    { left: 37,  top:  4,  width:  9, aspect: "16/9", z: 5 },
    { left: 51,  top:  2,  width:  9, aspect: "16/9", z: 5 },

    // ── LEFT BAND (left: -5 to 28) ───────────────────────────────────────
    // Large left-center
    { left: -2,  top: 28,  width: 22, aspect: "16/9", z: 2 },
    // Medium left — overlaps large
    { left:  3,  top: 52,  width: 17, aspect: "4/3",  z: 3 },
    // Small accent left
    { left: 15,  top: 38,  width: 11, aspect: "16/9", z: 4 },

    // ── RIGHT BAND (left: 70 to 105) ─────────────────────────────────────
    // Large right-center
    { left: 76,  top: 27,  width: 22, aspect: "16/9", z: 2 },
    // Medium right — overlaps large
    { left: 78,  top: 52,  width: 18, aspect: "4/3",  z: 3 },
    // Small accent right
    { left: 70,  top: 38,  width: 11, aspect: "16/9", z: 4 },

    // ── BOTTOM BAND (top: 65 to 108) ─────────────────────────────────────
    // Hero — bottom-left bleeds off
    { left: -2,  top: 72,  width: 26, aspect: "16/9", z: 1 },
    // Medium bottom-left
    { left: 17,  top: 68,  width: 15, aspect: "4/3",  z: 3 },
    // Small accent bottom-left
    { left: 24,  top: 82,  width: 10, aspect: "16/9", z: 4 },
    // Center-bottom left
    { left: 20,  top: 60,  width: 12, aspect: "16/9", z: 2 },
    // Center-bottom right
    { left: 64,  top: 59,  width: 13, aspect: "16/9", z: 2 },
    // Small accent bottom-right
    { left: 63,  top: 80,  width: 10, aspect: "16/9", z: 4 },
    // Medium bottom-right
    { left: 72,  top: 68,  width: 15, aspect: "4/3",  z: 3 },
    // Hero — bottom-right bleeds off
    { left: 78,  top: 73,  width: 26, aspect: "16/9", z: 1 },

    // ── TINY ACCENT FILLS — bottom center gap ────────────────────────────
    { left: 36,  top: 82,  width:  8, aspect: "16/9", z: 5 },
    { left: 52,  top: 83,  width:  9, aspect: "16/9", z: 5 },

    // ── CORNER OVERLAP — adds depth at corners ───────────────────────────
    { left: 10,  top: 20,  width: 14, aspect: "16/9", z: 2 },
  ];

  // ── State ─────────────────────────────────────────────────────────────────
  let _filenames    = [];
  let _rotateTimers = []; // one interval per card
  let _cards        = []; // { el, videoA, videoB, activeLayer: "A"|"B" }
  let _usedIndices  = new Set(); // track recently used to avoid repeats

  // ── Helpers ───────────────────────────────────────────────────────────────
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Pick a random filename, avoiding the last N used globally
  function _pickRandom() {
    if (_filenames.length === 0) return null;
    // Reset avoidance when pool is exhausted
    if (_usedIndices.size >= _filenames.length) _usedIndices.clear();

    let idx;
    let attempts = 0;
    do {
      idx = Math.floor(Math.random() * _filenames.length);
      attempts++;
    } while (_usedIndices.has(idx) && attempts < 30);

    _usedIndices.add(idx);
    return _filenames[idx];
  }

  // Load a video src and return a promise that resolves when it can play
  function _loadVideo(videoEl, filename) {
    return new Promise((resolve) => {
      videoEl.src = VIDEO_BASE + filename;
      videoEl.load();
      const onReady = () => {
        videoEl.removeEventListener("canplay", onReady);
        resolve();
      };
      videoEl.addEventListener("canplay", onReady);
      // Fallback: resolve after 1.5s even if canplay never fires
      setTimeout(resolve, 1500);
    });
  }

  // ── Card rotation ─────────────────────────────────────────────────────────
  // Each card has two video layers (A on top of B).
  // Active layer plays and is opacity:1. Inactive layer is opacity:0.
  // On rotate: load next video into inactive layer → crossfade → swap roles.

  async function _rotateCard(cardState) {
    const { videoA, videoB } = cardState;
    const incoming = cardState.activeLayer === "A" ? videoB : videoA;
    const outgoing = cardState.activeLayer === "A" ? videoA : videoB;

    const next = _pickRandom();
    if (!next) return;

    // Load into the hidden (inactive) layer silently
    incoming.src = VIDEO_BASE + next;
    incoming.load();
    incoming.muted = true;
    incoming.loop  = true;

    // Wait for it to be ready (or timeout)
    await new Promise(resolve => {
      const done = () => { incoming.removeEventListener("canplay", done); resolve(); };
      incoming.addEventListener("canplay", done);
      setTimeout(resolve, 1500);
    });

    incoming.play().catch(() => {});

    // Crossfade: bring incoming to 1, push outgoing to 0
    incoming.style.opacity = "1";
    outgoing.style.opacity = "0";

    // After fade completes, pause outgoing to save resources
    setTimeout(() => {
      outgoing.pause();
      cardState.activeLayer = cardState.activeLayer === "A" ? "B" : "A";
    }, FADE_DURATION);
  }

  // ── Build ─────────────────────────────────────────────────────────────────
  function _build() {
    _teardown();

    const container = document.getElementById("homeCollageContainer");
    if (!container) return;
    container.innerHTML = "";

    _filenames = (typeof HOME_VIDEOS !== "undefined" && Array.isArray(HOME_VIDEOS))
      ? HOME_VIDEOS : [];

    if (_filenames.length === 0) {
      console.warn("[homeCollage] HOME_VIDEOS is empty — add filenames to home-videos.config.js");
      return;
    }

    // Use all slots every time — layout is fixed, only video content is random
    const slots = SLOTS;

    slots.forEach((slot, i) => {
      const floatId = (i % FLOAT_VARIANTS) + 1;

      // Card wrapper
      const card = document.createElement("div");
      card.className = `home-card home-card-float-${floatId}`;
      card.style.cssText = [
        `left:${slot.left}%`,
        `top:${slot.top}%`,
        `width:${slot.width}%`,
        `aspect-ratio:${slot.aspect}`,
        `z-index:${slot.z || 1}`,
        `animation-delay:${(Math.random() * 6).toFixed(2)}s`,
        `animation-duration:${(7 + Math.random() * 5).toFixed(2)}s`,
      ].join(";");

      // Layer A (starts active/visible)
      const videoA = document.createElement("video");
      videoA.className   = "home-card-layer home-card-layer-a";
      videoA.muted       = true;
      videoA.loop        = true;
      videoA.playsInline = true;
      videoA.preload     = "none";
      videoA.setAttribute("playsinline", "");
      videoA.setAttribute("muted", "");
      videoA.style.opacity = "1";

      // Layer B (starts hidden)
      const videoB = document.createElement("video");
      videoB.className   = "home-card-layer home-card-layer-b";
      videoB.muted       = true;
      videoB.loop        = true;
      videoB.playsInline = true;
      videoB.preload     = "none";
      videoB.setAttribute("playsinline", "");
      videoB.setAttribute("muted", "");
      videoB.style.opacity = "0";

      card.appendChild(videoB); // B underneath
      card.appendChild(videoA); // A on top
      container.appendChild(card);

      const cardState = { el: card, videoA, videoB, activeLayer: "A" };
      _cards.push(cardState);

      // Load initial video into layer A
      const first = _pickRandom();
      if (first) {
        videoA.src = VIDEO_BASE + first;
        videoA.load();
        videoA.play().catch(() => {});
      }

      // Stagger rotation start so all cards don't swap at the same moment
      const stagger = i * (ROTATE_INTERVAL / slots.length);
      const timer = setTimeout(() => {
        _rotateCard(cardState);
        // After first staggered rotation, run on a fixed interval
        const interval = setInterval(() => _rotateCard(cardState), ROTATE_INTERVAL);
        _rotateTimers.push(interval);
      }, stagger);
      _rotateTimers.push(timer);
    });
  }

  // ── Teardown ──────────────────────────────────────────────────────────────
  function _teardown() {
    _rotateTimers.forEach(t => { clearInterval(t); clearTimeout(t); });
    _rotateTimers = [];
    _cards = [];
    _usedIndices.clear();
  }

  function _pause() {
    _teardown();
    document.querySelectorAll("#homeCollageContainer video").forEach(v => v.pause());
  }

  function _resume() {
    // Rebuild from scratch for a fresh layout on return
    _build();
  }

  return {
    init()    { _build(); },
    rebuild() { _build(); },
    pause:    _pause,
    resume:   _resume
  };
})();
