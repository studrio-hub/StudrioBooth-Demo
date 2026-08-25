/*
 * KEYCHAIN-ADDON.JS — Mini-Strip Keychain print compositor.
 *
 * WHAT THIS FILE DOES
 * ───────────────────
 * Provides keychainAddon.exportPrintPNG() — called by printing.js when
 * the guest selected a Keychain template from the Accessories category.
 *
 * The keychain sheet is a full 2400×3600 px canvas (same as the standard
 * 2×6 print sheet) divided as follows:
 *
 *   Left half  (X: 0–1199):
 *     Single 2×6 strip — 4 photo slots from KEYCHAIN_LAYOUT.stripPhotoSlots,
 *     the selected design's 2×6 overlay (left-strip portion), and a QR code.
 *
 *   Right half (X: 1200–2400):
 *     2 Mini-Strip Keychain frames side by side.
 *     Each frame: 4 photo slots drawn first, then the linked keychain
 *     template overlay (591×1795 px) composited on top at the frame's
 *     template position. The same overlay PNG is used for both frames.
 *
 * TEMPLATE LINKING
 * ────────────────
 * The selected design's keychainOverlayUrl field (resolved by asset-sync.js
 * from the keychain_overlay_path Supabase column) supplies the overlay PNG
 * for the Mini-Strip frames. If none is set, frames are printed photo-only.
 *
 * INTEGRATION
 * ───────────
 * printing.js._autoPrint() checks sessionState._isKeychain and calls
 * keychainAddon.exportPrintPNG() instead of the standard strip path.
 *
 * CANVAS LAYOUT (2400 × 3600 px @ 600 DPI)
 * ─────────────────────────────────────────
 * Left half  (X: 0–1199):
 *   Standard single 2×6 strip — 4 photo slots from KEYCHAIN_LAYOUT.stripPhotoSlots
 *   plus the selected design overlay (left-strip portion) + QR code.
 *
 * Right half (X: 1200–2400):
 *   2 Mini-Strip Keychain frames side by side:
 *     Frame 1 — template at X:1200, Y:903, W:591, H:1795
 *               photos at X:1241, Y: 957 / 1384.5 / 1811.38 / 2238.22
 *     Frame 2 — template at X:1809, Y:903, W:591, H:1795
 *               photos at X:1850, Y: 957 / 1384.5 / 1811.38 / 2238.22
 *   The same Mini-Strip template PNG (591×1795) is drawn at each frame's
 *   template position over the photos.
 *
 * All coordinates come from KEYCHAIN_LAYOUT in layout-config.js.
 */

"use strict";

const keychainAddon = (() => {

  /*
   * exportPrintPNG — composites the full 2400×3600 keychain print sheet.
   *
   * Left half  (X: 0–1199):  single 2×6 strip (photos + overlay + QR)
   * Right half (X: 1200–2400): 2 Mini-Strip Keychain frames side by side.
   *   Each frame: 4 photos drawn first, then the Mini-Strip template overlay
   *   (591×1795 px) composited on top at the frame's template position.
   *
   * Returns a Promise<Blob> PNG ready for printAlignment.sendPrintJob().
   */
  async function exportPrintPNG({ selectedShots, designId, qrText }) {
    if (typeof KEYCHAIN_LAYOUT === "undefined") {
      throw new Error("[keychainAddon] KEYCHAIN_LAYOUT not found — check layout-config.js load order.");
    }
    const layout = KEYCHAIN_LAYOUT;

    const canvas = document.createElement("canvas");
    canvas.width  = layout.canvasWidth;   // 2400
    canvas.height = layout.canvasHeight;  // 3600
    const ctx = canvas.getContext("2d");

    // White base — ensures unfilled areas are clean white.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Pre-load all selected photo images (via stripModule's shared cache).
    const photoImages = await Promise.all(
      (selectedShots || []).map((shot) =>
        shot && shot.imageUrl
          ? stripModule.loadImage(shot.imageUrl)
          : Promise.resolve(null)
      )
    );

    // ── LEFT HALF: single 2×6 strip ─────────────────────────────────────────

    layout.stripPhotoSlots.forEach((slot, i) => {
      const img = photoImages[layout.slotToPhotoIndex[i]];
      if (img) {
        stripModule.drawCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h);
      } else {
        _drawEmptySlot(ctx, slot.x, slot.y, slot.w, slot.h);
      }
    });

    // Design overlay — left-strip portion of the full-sheet overlay PNG.
    if (designId) {
      const design = stripModule.getDesign(designId);
      if (design) {
        const overlayPath = design.overlays && design.overlays["2x6"];
        if (overlayPath) {
          const overlayImg = await stripModule.loadImage(overlayPath);
          if (overlayImg) {
            const stripW = Math.round(canvas.width / 2); // 1200
            const isSingle = stripModule._isSingleStripOverlay(overlayImg, "2x6");
            if (isSingle) {
              // Single-strip upload: draw it at full strip width on the left half.
              ctx.drawImage(overlayImg, 0, 0, stripW, canvas.height);
            } else {
              // Full two-up overlay: sample only the left half (copy 0).
              const srcW = Math.round(overlayImg.naturalWidth / 2);
              ctx.drawImage(
                overlayImg,
                0, 0, srcW, overlayImg.naturalHeight,
                0, 0, stripW, canvas.height
              );
            }
          }
        }
      }
    }

    // QR code on the left strip at the spec coordinates.
    if (qrText && typeof generateQrCanvas === "function") {
      const qr = layout.stripQR;
      const qrCanvas = generateQrCanvas(qrText, qr.w, {
        correctLevel: typeof QRCode !== "undefined" ? QRCode.CorrectLevel.L : undefined,
        quietModules: 2
      });
      ctx.save();
      ctx.fillStyle = "#ffffff"; // white backing for contrast
      ctx.fillRect(qr.x, qr.y, qr.w, qr.h);
      ctx.restore();
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(qrCanvas, qr.x, qr.y, qr.w, qr.h);
      ctx.restore();
    }

    // ── RIGHT HALF: 2 Mini-Strip Keychain frames ─────────────────────────────

    // Resolve the linked Mini-Strip template overlay (optional).
    // Stored in the selected design's keychainOverlayUrl field,
    // populated by asset-sync.js from keychain_overlay_path in Supabase.
    // The same template PNG (591×1795) is drawn at each frame's position.
    let miniStripTemplateImg = null;
    if (designId) {
      const design = stripModule.getDesign(designId);
      if (design && design.keychainOverlayUrl) {
        try {
          miniStripTemplateImg = await stripModule.loadImage(design.keychainOverlayUrl);
        } catch (e) {
          console.warn("[keychainAddon] Could not load Mini-Strip template — printing without it:", e.message || e);
        }
      }
    }

    // Draw each Mini-Strip Keychain frame:
    //   1. Photos first (so the template overlay composites on top)
    //   2. Template overlay at the frame's template position
    layout.keychainFrames.forEach((frame) => {
      // 4 photos per frame — drawn before the overlay so the template sits on top.
      frame.photoSlots.forEach((slot, i) => {
        const img = photoImages[layout.slotToPhotoIndex[i]];
        if (img) {
          stripModule.drawCropFill(ctx, img, slot.x, slot.y, slot.w, slot.h);
        } else {
          _drawEmptySlot(ctx, slot.x, slot.y, slot.w, slot.h);
        }
      });

      // Mini-Strip template overlay — composited over photos for this frame.
      if (miniStripTemplateImg) {
        const t = frame.template;
        ctx.drawImage(miniStripTemplateImg, t.x, t.y, t.w, t.h);
      }
    });

    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  // Draws a faint outline for an empty/missing photo slot (consistent with strip.js).
  function _drawEmptySlot(ctx, x, y, w, h) {
    ctx.save();
    ctx.strokeStyle = "rgba(200,200,200,0.6)";
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
    ctx.restore();
  }

  // Ensure the keychain flag is always clean for each new session.
  // printing.js reads sessionState._isKeychain; app.js resets it in
  // resetSessionAndRestart(), but we also reset here on shooting:complete
  // as an extra safeguard so a previous session's state never bleeds in.
  document.addEventListener("shooting:complete", () => {
    // _isKeychain is set by _startShooting() in app.js based on the
    // template the guest chose. By the time shooting:complete fires it
    // is already correctly set — no action needed here beyond safety.
    // keychainAddonSelected is kept for backward compat with any external callers.
    sessionState.keychainAddonSelected = sessionState._isKeychain ? "replace" : false;
  });

  // Public API
  return {
    exportPrintPNG
  };

})();
