/*
 * LAYOUT-CONFIG.JS
 * Exact pixel-perfect print layout definitions. DO NOT approximate,
 * auto-space, or redistribute these — they are final coordinates.
 * Units: px @ 600 DPI. Canvas is 2400 x 3600 for both formats.
 *
 * ROTATION SUPPORT
 * Slots with `angle: 90` are drawn rotated 90° clockwise.
 * The canvas renderer (strip.js drawRotatedCropFill) handles this via
 * ctx.save() / ctx.translate() / ctx.rotate() / ctx.restore().
 * x, y, w, h are the bounding box on the final canvas (pre-rotation frame).
 * The image is cropped-to-fill within that bounding box then rotated.
 *
 * PER-SLOT photoIndex
 * New frame types use `photoIndex` directly on each slot so the same 4 photos
 * can be repeated across multiple sub-frames. Legacy "2x6" and "4x6" use the
 * shared `slotToPhotoIndex` array instead; both are supported by the renderer.
 */

const LAYOUT_CONFIGS = {
  "2x6": {
    canvasWidth: 2400,
    canvasHeight: 3600,
    dpi: 600,
    slotCornerRadiusPct: 6,
    // 8 slots = 2 identical strips side by side.
    // Strip 2 (slots 5–8) is strip 1 (slots 1–4) shifted +1200px on X.
    photoSlots: [
      { x: 65,    y: 311.09,  w: 1070.01, h: 757.62 },
      { x: 65,    y: 1109.28, w: 1070.01, h: 757.62 },
      { x: 65,    y: 1906.25, w: 1070.01, h: 757.62 },
      { x: 65,    y: 2703.25, w: 1070.01, h: 757.62 },
      { x: 1265,  y: 311.09,  w: 1070.01, h: 757.62 },
      { x: 1265,  y: 1109.28, w: 1070.01, h: 757.62 },
      { x: 1265,  y: 1906.25, w: 1070.01, h: 757.62 },
      { x: 1265,  y: 2703.25, w: 1070.01, h: 757.62 }
    ],
    // which selected photo (0-3) goes in each slot above
    slotToPhotoIndex: [0, 1, 2, 3, 0, 1, 2, 3]
  },

  "4x6": {
    canvasWidth: 2400,
    canvasHeight: 3600,
    dpi: 600,
    slotCornerRadiusPct: 6,
    // Exact print coordinates per spec (px @ 600dpi, 2400x3600 canvas):
    // Photo 1: W=1124.25  H=1497.58  X=60       Y=318
    // Photo 2: W=1124.25  H=1497.58  X=1215.75  Y=318
    // Photo 3: W=1124.25  H=1497.58  X=60        Y=1967.41
    // Photo 4: W=1124.25  H=1497.58  X=1215.75  Y=1967.41
    photoSlots: [
      { x: 60,      y: 318,     w: 1124.25, h: 1497.58 },
      { x: 1215.75, y: 318,     w: 1124.25, h: 1497.58 },
      { x: 60,      y: 1967.41, w: 1124.25, h: 1497.58 },
      { x: 1215.75, y: 1967.41, w: 1124.25, h: 1497.58 }
    ],
    slotToPhotoIndex: [0, 1, 2, 3]
  },

  // ─────────────────────────────────────────────────────────────────────────
  // NEW FRAME FORMATS
  // All on 2400 × 3600 px @ 600 DPI canvas. copies: 1 = no side-by-side mirror.
  // mm → px at 600 DPI: 1 mm = 600/25.4 ≈ 23.622 px
  // ─────────────────────────────────────────────────────────────────────────

  /*
   * LONG DUO
   * Frame 1 — Left strip: 4 photos (W=1026, H=808.66 px)
   * Frame 2 — Right top pair: 2 photos (W=926.99, H=706.58 px)
   * Frame 3 — Right bottom pair: 2 photos (same size as Frame 2)
   */
  "long-duo": {
    canvasWidth: 2400,
    canvasHeight: 3600,
    dpi: 600,
    slotCornerRadiusPct: 4,
    copies: 1,
    // QR: W=250, H=250, X=914.5, Y=31.59 (Frame 1, top-right of left strip)
    qrPlacements: [{ x: 914.5, y: 31.59, w: 250, h: 250 }],
    photoSlots: [
      // Frame 1 — large left strip
      { x: 87,   y: 178,  w: 1026,    h: 808.66, photoIndex: 0 },
      { x: 87,   y: 1030, w: 1026,    h: 808.66, photoIndex: 1 },
      { x: 87,   y: 1881, w: 1026,    h: 808.66, photoIndex: 2 },
      { x: 87,   y: 2731, w: 1026,    h: 808.66, photoIndex: 3 },
      // Frame 2 — right top pair
      { x: 1347, y: 247,  w: 926.99,  h: 706.58, photoIndex: 0 },
      { x: 1347, y: 992,  w: 926.99,  h: 706.58, photoIndex: 1 },
      // Frame 3 — right bottom pair
      { x: 1347, y: 1977, w: 926.99,  h: 706.58, photoIndex: 2 },
      { x: 1347, y: 2722, w: 926.99,  h: 706.58, photoIndex: 3 }
    ],
    slotToPhotoIndex: [0, 1, 2, 3, 0, 1, 2, 3]
  },

  /*
   * LONG MINI
   * Frame 1  — Left strip: 4 large photos (W=1026, H=808.66 px)
   * Frame 2  — Right upper col 1 (X=1241): 4 medium photos (W=508.98, H=397.36 px)
   * Frame 3  — Right upper col 2 (X=1850): same 4 medium photos
   * Frame 4  — 4 tiny photos rotated 90°, row 1 at Y=1840 (visible W=265.5, H=340.09 px)
   * Frame 5  — 4 tiny photos rotated 90°, row 2 at Y=2255
   */
  "long-mini": {
    canvasWidth: 2400,
    canvasHeight: 3600,
    dpi: 600,
    slotCornerRadiusPct: 4,
    copies: 1,
    // QR: W=250, H=250, X=914.5, Y=31.59 (top-right of left strip)
    qrPlacements: [{ x: 914.5, y: 31.59, w: 250, h: 250 }],
    photoSlots: [
      // Frame 1 — large left strip
      { x: 87,   y: 178,    w: 1026,    h: 808.66, photoIndex: 0 },
      { x: 87,   y: 1030,   w: 1026,    h: 808.66, photoIndex: 1 },
      { x: 87,   y: 1881,   w: 1026,    h: 808.66, photoIndex: 2 },
      { x: 87,   y: 2731,   w: 1026,    h: 808.66, photoIndex: 3 },
      // Frame 2 — right upper, column 1 (X=1241)
      { x: 1241, y: 105,    w: 508.98,  h: 397.36, photoIndex: 0 },
      { x: 1241, y: 523.63, w: 508.98,  h: 397.36, photoIndex: 1 },
      { x: 1241, y: 942,    w: 508.98,  h: 397.36, photoIndex: 2 },
      { x: 1241, y: 1360,   w: 508.98,  h: 397.36, photoIndex: 3 },
      // Frame 3 — right upper, column 2 (X=1850)
      { x: 1850, y: 105,    w: 508.98,  h: 397.36, photoIndex: 0 },
      { x: 1850, y: 523.63, w: 508.98,  h: 397.36, photoIndex: 1 },
      { x: 1850, y: 942,    w: 508.98,  h: 397.36, photoIndex: 2 },
      { x: 1850, y: 1360,   w: 508.98,  h: 397.36, photoIndex: 3 },
      // Frame 4 — tiny rotated 90°, row 1 (Y=1840), right to left
      // w/h are the intended visible size (265.5 wide x 340.09 tall); x/y
      // are offset by ±(h-w)/2 to compensate for drawRotatedCropFill
      // transposing the box under 90° rotation (see Frame 1 note above),
      // so the rendered box lands exactly on the template's cutout.
      { x: 2026.705, y: 1877.295, w: 340.09,  h: 265.5,  angle: 90, photoIndex: 0 },
      { x: 1747.705, y: 1877.295, w: 340.09,  h: 265.5,  angle: 90, photoIndex: 1 },
      { x: 1467.705, y: 1877.295, w: 340.09,  h: 265.5,  angle: 90, photoIndex: 2 },
      { x: 1187.705, y: 1877.295, w: 340.09,  h: 265.5,  angle: 90, photoIndex: 3 },
      // Frame 5 — tiny rotated 90°, row 2 (Y=2255), right to left
      { x: 2026.705, y: 2292.295, w: 340.09,  h: 265.5,  angle: 90, photoIndex: 0 },
      { x: 1747.705, y: 2292.295, w: 340.09,  h: 265.5,  angle: 90, photoIndex: 1 },
      { x: 1467.705, y: 2292.295, w: 340.09,  h: 265.5,  angle: 90, photoIndex: 2 },
      { x: 1187.705, y: 2292.295, w: 340.09,  h: 265.5,  angle: 90, photoIndex: 3 }
    ],
    slotToPhotoIndex: [0,1,2,3, 0,1,2,3, 0,1,2,3, 0,1,2,3, 0,1,2,3]
  },

  /*
   * FILM DUO
   * Frame 1  — Left strip: 4 photos rotated 90° (visible W=956.08, H=802.21 px)
   * Frame 2  — Right upper 2×2 grid (W=466.72, H=650.01 px)
   * Frame 3  — Right lower 2×2 grid (same size as Frame 2)
   */
  "film-duo": {
    canvasWidth: 2400,
    canvasHeight: 3600,
    dpi: 600,
    slotCornerRadiusPct: 4,
    copies: 1,
    // QR: W=250, H=250, X=903.91, Y=3309.97, Angle=90° (bottom of left strip)
    qrPlacements: [{ x: 903.91, y: 3309.97, w: 250, h: 250, angle: 90 }],
    photoSlots: [
      // Frame 1 — left strip, rotated 90°
      // drawRotatedCropFill rotates the w×h box around its own center, so for
      // a 90° rotation the box that ends up VISIBLE on the canvas has its
      // width/height transposed (world_w=h, world_h=w) and its center
      // shifts unless x/y are compensated. w/h below are correct (956.08 is
      // the intended visible width, 802.21 the visible height); x/y are
      // offset by ±(h-w)/2 so the rendered box lands exactly on the
      // template's cutout at x=86.47, y=121.5/972.72/1823.91/2675.13.
      { x: 163.405, y: 44.565,   w: 802.21, h: 956.08, angle: 90, photoIndex: 0 },
      { x: 163.405, y: 895.785,  w: 802.21, h: 956.08, angle: 90, photoIndex: 1 },
      { x: 163.405, y: 1746.975, w: 802.21, h: 956.08, angle: 90, photoIndex: 2 },
      { x: 163.405, y: 2598.195, w: 802.21, h: 956.08, angle: 90, photoIndex: 3 },
      // Frame 2 — right upper 2×2 grid
      { x: 1329,   y: 292,  w: 466.72, h: 650.01, photoIndex: 0 },
      { x: 1836,   y: 292,  w: 466.72, h: 650.01, photoIndex: 1 },
      { x: 1329,   y: 993,  w: 466.72, h: 650.01, photoIndex: 2 },
      { x: 1836,   y: 993,  w: 466.72, h: 650.01, photoIndex: 3 },
      // Frame 3 — right lower 2×2 grid
      { x: 1329,   y: 2020, w: 466.72, h: 650.01, photoIndex: 0 },
      { x: 1836,   y: 2020, w: 466.72, h: 650.01, photoIndex: 1 },
      { x: 1329,   y: 2721, w: 466.72, h: 650.01, photoIndex: 2 },
      { x: 1836,   y: 2721, w: 466.72, h: 650.01, photoIndex: 3 }
    ],
    slotToPhotoIndex: [0,1,2,3, 0,1,2,3, 0,1,2,3]
  },

  /*
   * WIDE MINI
   * Frame 1  — Upper 2×2 grid of large landscape photos (W=1091.89, H=756.48 px)
   * Frame 2  — Right lower pair: 4 medium photos rotated 90° (visible W=440.19, H=664.07 px)
   * Frame 3  — Left lower pair: 4 medium photos rotated 90° (same size)
   */
  "wide-mini": {
    canvasWidth: 2400,
    canvasHeight: 3600,
    dpi: 600,
    slotCornerRadiusPct: 4,
    copies: 1,
    // QR: W=250, H=250, X=2111.38, Y=47.59 (top-right of canvas)
    qrPlacements: [{ x: 2111.38, y: 47.59, w: 250, h: 250 }],
    photoSlots: [
      // Frame 1 — upper 2×2 grid
      { x: 87.75,   y: 155.59, w: 1091.89, h: 756.48, photoIndex: 0 },
      { x: 1223.56, y: 155.59, w: 1091.89, h: 756.48, photoIndex: 1 },
      { x: 87.75,   y: 951.94, w: 1091.89, h: 756.48, photoIndex: 2 },
      { x: 1223.56, y: 951.94, w: 1091.89, h: 756.48, photoIndex: 3 },
      // Frame 2 — right lower, rotated 90°
      // w/h are the intended visible size (440.19 wide x 664.07 tall); x/y
      // are offset by ±(h-w)/2 to compensate for drawRotatedCropFill
      // transposing the box under 90° rotation (see Frame 1 note, film-duo),
      // so the rendered box lands exactly on the template's cutout.
      { x: 1640.06, y: 2137.94,  w: 664.07,  h: 440.19, angle: 90, photoIndex: 0 },
      { x: 1640.06, y: 2821.94,  w: 664.07,  h: 440.19, angle: 90, photoIndex: 1 },
      { x: 1177.06, y: 2137.94,  w: 664.07,  h: 440.19, angle: 90, photoIndex: 2 },
      { x: 1177.06, y: 2821.94,  w: 664.07,  h: 440.19, angle: 90, photoIndex: 3 },
      // Frame 3 — left lower, rotated 90°
      { x: 529.06,  y: 2137.94,  w: 664.07,  h: 440.19, angle: 90, photoIndex: 0 },
      { x: 529.06,  y: 2821.94,  w: 664.07,  h: 440.19, angle: 90, photoIndex: 1 },
      { x: 66.06,   y: 2137.94,  w: 664.07,  h: 440.19, angle: 90, photoIndex: 2 },
      { x: 66.06,   y: 2821.94,  w: 664.07,  h: 440.19, angle: 90, photoIndex: 3 }
    ],
    slotToPhotoIndex: [0,1,2,3, 0,1,2,3, 0,1,2,3]
  }
};

/*
 * KEYCHAIN_LAYOUT
 * Mini-Strip Keychain add-on layout — rendered onto the same 2400×3600 canvas
 * as the 2×6 print sheet.
 *
 * Output breakdown:
 *   Left half  (X: 0–1199)   — single 2×6 strip (4 photos + overlay + QR code)
 *   Right half (X: 1200–2400) — 2 Mini-Strip Keychain frames side by side
 *
 * Canvas: 2400 × 3600 px @ 600 DPI.
 *
 * 2×6 strip (left half):
 *   Photo slots use the spec-exact coordinates for the LEFT strip only
 *   (identical to LAYOUT_CONFIGS["2x6"].photoSlots slots 0–3).
 *   QR code: W=250, H=250, X=881, Y=33.09.
 *
 * Mini-Strip Keychain frames (right half):
 *   2 frames side by side (1st at X≈1200, 2nd at X≈1809).
 *   Each frame template: 591×1795 px, placed at the coordinates below.
 *   Each frame contains all 4 selected photos at its own slot positions.
 *
 *   Frame template positions:
 *     1st Mini-Strip template: W=591, H=1795, X=1200, Y=903
 *     2nd Mini-Strip template: W=591, H=1795, X=1809, Y=903
 *
 *   Photo slot positions (per spec, px @ 600 DPI):
 *     1st frame: X=1241 for all photos
 *     2nd frame: X=1850 for all photos
 *
 * TEMPLATE OVERLAY:
 *   The linked keychain overlay (keychain_overlay_path / keychainOverlayUrl)
 *   is a single Mini-Strip template PNG at 591×1795 px, applied to BOTH
 *   frames at their respective positions. Upload one template in the Admin
 *   Panel and it is used for both frames automatically.
 */
const KEYCHAIN_LAYOUT = {
  canvasWidth:  2400,
  canvasHeight: 3600,
  dpi: 600,

  // Left strip: 2×6 photo positions (left strip only, as per spec)
  stripPhotoSlots: [
    { x: 65,   y: 311.09,  w: 1070.01, h: 757.62 },
    { x: 65,   y: 1109.28, w: 1070.01, h: 757.62 },
    { x: 65,   y: 1906.25, w: 1070.01, h: 757.62 },
    { x: 65,   y: 2703.25, w: 1070.01, h: 757.62 }
  ],
  stripQR: { x: 881, y: 33.09, w: 250, h: 250 },

  // Mini-Strip template dimensions (used to draw the overlay on each frame)
  miniStripTemplate: { w: 591, h: 1795 },

  // Two mini-strip keychain frames (exact spec coordinates)
  keychainFrames: [
    // 1st Mini-Strip Frame
    {
      // Template overlay position on the canvas
      template: { x: 1200, y: 903, w: 591, h: 1795 },
      // 4 photo slots (drawn before the template overlay)
      photoSlots: [
        { x: 1241, y: 957,     w: 508.98, h: 405.78 },
        { x: 1241, y: 1384.5,  w: 508.98, h: 405.78 },
        { x: 1241, y: 1811.38, w: 508.98, h: 405.78 },
        { x: 1241, y: 2238.22, w: 508.98, h: 405.78 }
      ]
    },
    // 2nd Mini-Strip Frame
    {
      // Template overlay position on the canvas
      template: { x: 1809, y: 903, w: 591, h: 1795 },
      // 4 photo slots (drawn before the template overlay)
      photoSlots: [
        { x: 1850, y: 957,     w: 508.98, h: 405.78 },
        { x: 1850, y: 1384.5,  w: 508.98, h: 405.78 },
        { x: 1850, y: 1811.38, w: 508.98, h: 405.78 },
        { x: 1850, y: 2238.22, w: 508.98, h: 405.78 }
      ]
    }
  ],

  // Photo index for each slot in each keychain frame (always 0→3, same photos)
  slotToPhotoIndex: [0, 1, 2, 3]
};
