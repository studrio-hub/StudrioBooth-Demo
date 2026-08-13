/*
 * LAYOUT-CONFIG.JS
 * Exact pixel-perfect print layout definitions. DO NOT approximate,
 * auto-space, or redistribute these — they are final coordinates.
 * Units: px @ 600 DPI. Canvas is 2400 x 3600 for both formats.
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
  }
};