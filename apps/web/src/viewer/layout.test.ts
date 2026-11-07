// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  anchorAt,
  CSS_PX_PER_PT,
  computeLayout,
  currentPage,
  fitScale,
  pageAtOffset,
  pageLeft,
  percentToScale,
  renderScale,
  scaleToPercent,
  scrollForAnchor,
  stepZoom,
  visibleRange,
} from "./layout";

const A4 = { width: 595, height: 842 };
const opts = { gap: 10, padding: 20 };

describe("computeLayout", () => {
  it("stacks pages with padding and gaps", () => {
    const layout = computeLayout([A4, A4, { width: 842, height: 595 }], 1, opts);
    expect(layout.tops).toEqual([20, 20 + 842 + 10, 20 + 2 * (842 + 10)]);
    expect(layout.totalHeight).toBe(20 + 842 + 10 + 842 + 10 + 595 + 20);
    expect(layout.totalWidth).toBe(842 + 40);
  });

  it("handles an empty document", () => {
    const layout = computeLayout([], 1, opts);
    expect(layout.totalHeight).toBe(40);
    expect(visibleRange(layout, 0, 500)).toEqual({ first: 0, last: -1 });
  });
});

describe("visibleRange and currentPage", () => {
  const pages = Array.from({ length: 500 }, () => A4);
  const layout = computeLayout(pages, 1, opts);

  it("finds the pages on screen", () => {
    expect(visibleRange(layout, 0, 900)).toEqual({ first: 0, last: 1 });
    const top100 = layout.tops[100] as number;
    expect(visibleRange(layout, top100, 400)).toEqual({ first: 100, last: 100 });
    // Scrolled into the gap below page 100: page 100 is no longer visible.
    expect(visibleRange(layout, top100 + 842 + 2, 100)).toEqual({ first: 101, last: 101 });
  });

  it("clamps to the document", () => {
    expect(visibleRange(layout, 1e9, 900)).toEqual({ first: 499, last: 499 });
    expect(pageAtOffset(layout, -50)).toBe(0);
  });

  it("reports the page that fills the view, not one that's nearly scrolled off", () => {
    expect(currentPage(layout, 0, 900)).toBe(0);
    const top10 = layout.tops[10] as number;
    // Page 10 starts 200 px down: page 9's last 190 px aren't enough to count.
    expect(currentPage(layout, top10 - 200, 900)).toBe(10);
    // Most of the view is still page 9.
    expect(currentPage(layout, top10 - 700, 900)).toBe(9);
  });

  it("agrees with go-to-page when many small pages fit on screen", () => {
    // 10% zoom: an A4 page is about 112 px tall, so 8 pages fit in a 900 px view.
    const tiny = computeLayout(pages, 0.1 * CSS_PX_PER_PT, opts);
    for (const target of [0, 1, 10, 250]) {
      const scrollTop = (tiny.tops[target] as number) - opts.padding;
      expect(currentPage(tiny, scrollTop, 900)).toBe(target);
    }
  });
});

describe("zoom anchoring", () => {
  it("keeps the point under the pointer in place, horizontally too", () => {
    const page = { width: 600, height: 800 };
    const viewportWidth = 1000;
    const before = computeLayout([page], 1, opts);
    // Pointer at x=750, y=300 in the viewport, not scrolled.
    const anchor = anchorAt(before, { top: 0, left: 0 }, viewportWidth, 750, 300);
    if (!anchor) throw new Error("no anchor");
    const pointOnPage = 750 - pageLeft(before, 0, viewportWidth);
    const after = computeLayout([page], 2, opts);
    const scroll = scrollForAnchor(after, anchor, viewportWidth);
    // The same point of the page, at double size, is back under the pointer.
    const screenX = pageLeft(after, 0, viewportWidth) + pointOnPage * 2 - scroll.left;
    expect(screenX).toBeCloseTo(750);
    const screenY = (after.tops[0] as number) + (300 - opts.padding) * 2 - scroll.top;
    expect(screenY).toBeCloseTo(300);
  });
});

describe("zoom anchoring in the gaps", () => {
  it("keeps a point between pages between the same pages", () => {
    const pages2 = [A4, A4];
    const before = computeLayout(pages2, 0.5, opts);
    // A point in the gap below page 0, 4 px under it.
    const gapY = (before.tops[0] as number) + (before.heights[0] as number) + 4;
    const anchor = anchorAt(before, { top: gapY - 100, left: 0 }, 1000, 500, 100);
    if (!anchor) throw new Error("no anchor");
    const after = computeLayout(pages2, 4, opts);
    const scroll = scrollForAnchor(after, anchor, 1000);
    const y = scroll.top + 100;
    // Still 4 px below page 0, so still in the gap (not on page 1).
    expect(y - ((after.tops[0] as number) + (after.heights[0] as number))).toBeCloseTo(4);
    expect(y).toBeLessThan(after.tops[1] as number);
  });
});

describe("zoom", () => {
  it("fits width and page", () => {
    const viewport = { width: 1000, height: 700 };
    expect(fitScale("fit-width", A4, viewport, opts)).toBeCloseTo(960 / 595);
    expect(fitScale("fit-page", A4, viewport, opts)).toBeCloseTo(660 / 842);
  });

  it("converts between scale and percent", () => {
    expect(scaleToPercent(CSS_PX_PER_PT)).toBe(100);
    expect(percentToScale(150)).toBeCloseTo(1.5 * CSS_PX_PER_PT);
  });

  it("steps through zoom levels", () => {
    expect(scaleToPercent(stepZoom(CSS_PX_PER_PT, 1))).toBe(110);
    expect(scaleToPercent(stepZoom(CSS_PX_PER_PT, -1))).toBe(90);
    // From an in-between zoom, go to the next step, not past it.
    expect(scaleToPercent(stepZoom(percentToScale(105), 1))).toBe(110);
    expect(scaleToPercent(stepZoom(percentToScale(800), 1))).toBe(800);
    // Just below a step (e.g. after wheel zooming) goes to that step, not past it.
    expect(scaleToPercent(stepZoom(percentToScale(109.95), 1))).toBe(110);
  });

  it("caps the render resolution", () => {
    expect(renderScale(A4, 1, 2)).toBe(2);
    const capped = renderScale(A4, 10, 2, 16_000_000);
    expect(A4.width * A4.height * capped * capped).toBeLessThanOrEqual(16_000_000 * 1.01);
    // A huge page still gets a positive scale.
    expect(renderScale({ width: 1e6, height: 1e6 }, 1, 2)).toBeGreaterThan(0);
  });
});
