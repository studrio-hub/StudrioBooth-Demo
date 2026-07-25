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
    // 8 slots = 2 identical strips; strip 2 is strip 1 shifted +1200px on X
    photoSlots: [
      { x: 52,   y: 286.22,  w: 1094, h: 766.77 },
      { x: 52,   y: 1088.47, w: 1094, h: 766.77 },
      { x: 52,   y: 1890.72, w: 1094, h: 766.77 },
      { x: 52,   y: 2692.97, w: 1094, h: 766.77 },
      { x: 1252, y: 286.22,  w: 1094, h: 766.77 },
      { x: 1252, y: 1088.47, w: 1094, h: 766.77 },
      { x: 1252, y: 1890.72, w: 1094, h: 766.77 },
      { x: 1252, y: 2692.97, w: 1094, h: 766.77 }
    ],
    // which selected photo (0-3) goes in each slot above
    slotToPhotoIndex: [0, 1, 2, 3, 0, 1, 2, 3]
  },

  "4x6": {
    canvasWidth: 2400,
    canvasHeight: 3600,
    dpi: 600,
    photoSlots: [
      { x: 57.5,    y: 312.78,  w: 1133.27, h: 1563.7 },
      { x: 1213.25, y: 312.78,  w: 1133.27, h: 1563.7 },
      { x: 57.5,    y: 1890.72, w: 1133.27, h: 1563.7 },
      { x: 1213.25, y: 1890.72, w: 1133.27, h: 1563.7 }
    ],
    slotToPhotoIndex: [0, 1, 2, 3]
  }
};