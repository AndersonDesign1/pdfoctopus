// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  CSS_PX_PER_PT,
  computeLayout,
  currentPage,
  fitScale,
  pageAtOffset,
  percentToScale,
  renderScale,
  scaleToPercent,
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

  it("reports the page a third of the way down the viewport", () => {
    expect(currentPage(layout, 0, 900)).toBe(0);
    expect(currentPage(layout, (layout.tops[10] as number) - 200, 900)).toBe(10);
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
  });

  it("caps the render resolution", () => {
    expect(renderScale(A4, 1, 2)).toBe(2);
    const capped = renderScale(A4, 10, 2, 16_000_000);
    expect(A4.width * A4.height * capped * capped).toBeLessThanOrEqual(16_000_000 * 1.01);
  });
});
