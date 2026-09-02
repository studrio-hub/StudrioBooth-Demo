/*
 * FLIPBOOK-LAYOUT-CONFIG.JS
 *
 * Real spec (replaces the earlier placeholder; updated with the final
 * exact coordinates for the Flipbook Update pass). Confirmed structure:
 *   - 2 printed A4 sheets total, each a 2-column × 5-row grid of 10 equal
 *     photo slots (791.01 × 576.02 px). Guests/staff cut the sheets apart
 *     into 20 individual physical pages after printing.
 *   - A4 Page 1 sheet: slot 0 = Cover Page, slots 1–9 = flipbook pages 1–9
 *     (→ extracted-frame indices 0–8).
 *   - A4 Page 2 sheet: slots 0–9 = flipbook pages 10–19
 *     (→ extracted-frame indices 9–18).
 *   - Canvas is A4 @ 300 DPI = 2480 × 3508 px (matches the given
 *     coordinates' margins exactly).
 *
 * The Cover Page slot does NOT get a video frame — it gets the separate
 * "Cover Page Template" image (a small cover-art asset), cropped-to-fill
 * just like a photo would be. The two per-sheet overlay images
 * (a4Page1Url / a4Page2Url) are drawn on top of the whole sheet last, same
 * draw order as every other multi-slot format in layout-config.js.
 */

const FLIPBOOK_TOTAL_FRAMES = 19; // extracted video frames = inner pages
const FLIPBOOK_TOTAL_PAGES  = FLIPBOOK_TOTAL_FRAMES + 1; // + cover

const SLOT_W = 791.01;
const SLOT_H = 576.02;

const FLIPBOOK_LAYOUT_CONFIG = {
  canvasWidth: 2480,
  canvasHeight: 3508,
  dpi: 300,

  sheets: {
    a4Page1: {
      slots: [
        { label: "cover",  frameIndex: null, x: 289,  y: 96,   w: SLOT_W, h: SLOT_H },
        { label: "page1",  frameIndex: 0,    x: 289,  y: 764,  w: SLOT_W, h: SLOT_H },
        { label: "page2",  frameIndex: 1,    x: 289,  y: 1432, w: SLOT_W, h: SLOT_H },
        { label: "page3",  frameIndex: 2,    x: 289,  y: 2100, w: SLOT_W, h: SLOT_H },
        { label: "page4",  frameIndex: 3,    x: 289,  y: 2768, w: SLOT_W, h: SLOT_H },
        { label: "page5",  frameIndex: 4,    x: 1352, y: 96,   w: SLOT_W, h: SLOT_H },
        { label: "page6",  frameIndex: 5,    x: 1352, y: 764,  w: SLOT_W, h: SLOT_H },
        { label: "page7",  frameIndex: 6,    x: 1352, y: 1432, w: SLOT_W, h: SLOT_H },
        { label: "page8",  frameIndex: 7,    x: 1352, y: 2100, w: SLOT_W, h: SLOT_H },
        { label: "page9",  frameIndex: 8,    x: 1352, y: 2768, w: SLOT_W, h: SLOT_H }
      ]
    },
    a4Page2: {
      slots: [
        { label: "page10", frameIndex: 9,  x: 289,  y: 96,   w: SLOT_W, h: SLOT_H },
        { label: "page11", frameIndex: 10, x: 289,  y: 764,  w: SLOT_W, h: SLOT_H },
        { label: "page12", frameIndex: 11, x: 289,  y: 1432, w: SLOT_W, h: SLOT_H },
        { label: "page13", frameIndex: 12, x: 289,  y: 2100, w: SLOT_W, h: SLOT_H },
        { label: "page14", frameIndex: 13, x: 289,  y: 2768, w: SLOT_W, h: SLOT_H },
        { label: "page15", frameIndex: 14, x: 1352, y: 96,   w: SLOT_W, h: SLOT_H },
        { label: "page16", frameIndex: 15, x: 1352, y: 764,  w: SLOT_W, h: SLOT_H },
        { label: "page17", frameIndex: 16, x: 1352, y: 1432, w: SLOT_W, h: SLOT_H },
        { label: "page18", frameIndex: 17, x: 1352, y: 2100, w: SLOT_W, h: SLOT_H },
        { label: "page19", frameIndex: 18, x: 1352, y: 2768, w: SLOT_W, h: SLOT_H }
      ]
    }
  },

  /*
   * previewFrame — the widget used on the Video Selection page and the
   * Print & QR page's video loop to show a single page-shaped preview of
   * the (looping) selected clip. Not a print canvas — an on-screen frame.
   * `slot` is where the cropped-fill video sits inside the outer frame
   * (the remaining border area is left for a decorative frame graphic).
   * Its slot dimensions are intentionally their own numbers (790.66 ×
   * 576.45), not the print-sheet SLOT_W/SLOT_H (791.01 × 576.02) — close
   * but distinct per spec, so don't merge them.
   */
  previewFrame: {
    w: 1060,
    h: 666,
    dpi: 300,
    slot: { x: 223.91, y: 44.53, w: 790.66, h: 576.45 }
  }
};

const flipbookLayout = {
  /* Which sheet + slot rect a given extracted-frame index (0-based, 0..18)
     prints on. */
  getPageSlot(frameIndex) {
    for (const sheetKey of ["a4Page1", "a4Page2"]) {
      const slot = FLIPBOOK_LAYOUT_CONFIG.sheets[sheetKey].slots.find(
        (s) => s.frameIndex === frameIndex
      );
      if (slot) return { sheet: sheetKey, ...slot };
    }
    return null;
  },

  getCoverSlot() {
    const slot = FLIPBOOK_LAYOUT_CONFIG.sheets.a4Page1.slots.find((s) => s.label === "cover");
    return slot ? { sheet: "a4Page1", ...slot } : null;
  },

  getSheet(sheetKey) {
    return FLIPBOOK_LAYOUT_CONFIG.sheets[sheetKey] || null;
  }
};
