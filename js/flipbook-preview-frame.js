/*
 * FLIPBOOK-PREVIEW-FRAME.JS
 *
 * Shared widget for showing a single looping video cropped into a
 * page-shaped rectangle, per FLIPBOOK_LAYOUT_CONFIG.previewFrame:
 *   outer frame: 1060 × 666 (the widget's aspect ratio)
 *   inner slot:  790.66 × 576.45 at (223.91, 44.53) — where the video sits
 *
 * Used in two places:
 *   - Video Selection page (flipbook-selection.js) — shows the currently
 *     chosen clip so the guest can confirm their pick.
 *   - Print & QR page (printing.js's _renderVideoLoop) — shows the
 *     selected clip looping while the sheets print.
 *
 * Both call flipbookPreviewFrame.render(containerEl, clip) with a
 * { videoUrl } clip descriptor (or null to clear the frame).
 *
 * The decorative border area (everything outside the inner video slot) is
 * filled by the admin-uploaded "Flipbook Overlay" (Admin Panel → Flipbook
 * template → Preview Frame Overlay), sourced via flipbookGenerator's
 * getTemplateUrls().previewUrl seam and drawn as a full-frame <img> layer
 * on top of the video. No-ops (leaves the border blank) if no overlay has
 * been uploaded for the selected design.
 */

const flipbookPreviewFrame = {
  render(containerEl, clip) {
    if (!containerEl) return;
    containerEl.innerHTML = "";

    const { w, h, slot } = FLIPBOOK_LAYOUT_CONFIG.previewFrame;

    const frame = document.createElement("div");
    frame.className = "flipbook-preview-frame-widget";
    frame.style.aspectRatio = `${w} / ${h}`;

    const video = document.createElement("video");
    video.className = "flipbook-preview-frame-video";
    video.style.left   = `${(slot.x / w) * 100}%`;
    video.style.top    = `${(slot.y / h) * 100}%`;
    video.style.width  = `${(slot.w / w) * 100}%`;
    video.style.height = `${(slot.h / h) * 100}%`;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;

    if (clip && clip.videoUrl) {
      video.src = clip.videoUrl;
      video.addEventListener("loadeddata", () => video.play().catch(() => {}));
    }

    frame.appendChild(video);

    // Decorative overlay (admin-uploaded Flipbook Overlay), drawn full-frame
    // on top of the video — see file header. Optional: no image if unset.
    const overlayUrl = (typeof flipbookGenerator !== "undefined")
      ? flipbookGenerator.getTemplateUrls().previewUrl
      : null;
    if (overlayUrl) {
      const overlayImg = document.createElement("img");
      overlayImg.className = "flipbook-preview-frame-overlay";
      overlayImg.src = overlayUrl;
      overlayImg.alt = "";
      frame.appendChild(overlayImg);
    }

    containerEl.appendChild(frame);
  }
};
