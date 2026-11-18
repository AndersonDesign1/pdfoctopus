// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  clampRect,
  contentBounds,
  fitWithin,
  hasTransparency,
  initialRect,
  MIN_STAMP_SIZE,
  padBox,
  placementKey,
  removeBackground,
  resizeRect,
  smoothStroke,
  strokeWidth,
} from "./ink";

const pt = (x: number, y: number, pressure = 0.5) => ({ x, y, pressure });

describe("smoothStroke", () => {
  it("gives nothing for no points, and a dot for one", () => {
    expect(smoothStroke([])).toEqual([]);
    const [dot] = smoothStroke([pt(3, 4)]);
    expect(dot?.from).toEqual(dot?.to);
  });

  it("starts and ends where the pen did, and joins its curves end to end", () => {
    const points = [pt(0, 0), pt(10, 0), pt(20, 10), pt(30, 10), pt(40, 0)];
    const segments = smoothStroke(points);
    expect(segments[0]?.from).toMatchObject({ x: 0, y: 0 });
    expect(segments[segments.length - 1]?.to).toMatchObject({ x: 40, y: 0 });
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]?.from).toEqual(segments[i - 1]?.to);
    }
    // Interior points steer the curve rather than being passed through exactly.
    expect(segments.map((s) => s.control)).toContainEqual(points[2]);
  });

  it("varies the width with pen pressure, within limits", () => {
    expect(strokeWidth(2, 0.5)).toBeCloseTo(2);
    expect(strokeWidth(2, 1)).toBeGreaterThan(strokeWidth(2, 0.2));
    expect(strokeWidth(2, 5)).toBe(strokeWidth(2, 1));
    expect(strokeWidth(2, -1)).toBeGreaterThan(0);
  });
});

/** A width×height RGBA image filled with one colour. */
function image(width: number, height: number, rgba = [255, 255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return data;
}

function setPixel(data: Uint8ClampedArray, width: number, x: number, y: number, rgba: number[]) {
  data.set(rgba, (y * width + x) * 4);
}

describe("contentBounds and padBox", () => {
  it("finds the box around the visible pixels", () => {
    const data = image(10, 8, [0, 0, 0, 0]);
    setPixel(data, 10, 2, 3, [0, 0, 0, 255]);
    setPixel(data, 10, 6, 5, [0, 0, 0, 255]);
    expect(contentBounds(data, 10, 8)).toEqual({ x: 2, y: 3, width: 5, height: 3 });
    expect(contentBounds(image(4, 4, [0, 0, 0, 0]), 4, 4)).toBeNull();
  });

  it("pads without leaving the image", () => {
    expect(padBox({ x: 1, y: 1, width: 3, height: 3 }, 4, 10, 6)).toEqual({
      x: 0,
      y: 0,
      width: 8,
      height: 6,
    });
  });
});

describe("removeBackground", () => {
  it("makes paper transparent and keeps the ink, even on grey paper", () => {
    const w = 20;
    const h = 10;
    const data = image(w, h, [200, 200, 195, 255]); // a photo's greyish paper
    for (let x = 5; x < 15; x++) setPixel(data, w, x, 5, [20, 30, 120, 255]); // blue ink
    setPixel(data, w, 3, 3, [190, 190, 185, 255]); // a slight shadow
    removeBackground(data, w, h);
    const alpha = (x: number, y: number) => data[(y * w + x) * 4 + 3];
    expect(alpha(0, 0)).toBe(0);
    expect(alpha(3, 3)).toBe(0);
    expect(alpha(10, 5)).toBe(255);
    // The ink keeps its colour.
    expect(Array.from(data.slice((5 * w + 10) * 4, (5 * w + 10) * 4 + 3))).toEqual([20, 30, 120]);
  });

  it("gives edges partial transparency with the paper taken out of their colour", () => {
    const w = 10;
    const data = image(w, 3, [240, 240, 240, 255]);
    setPixel(data, w, 5, 1, [180, 180, 180, 255]); // a half-covered edge pixel
    removeBackground(data, w, 3);
    const i = (1 * w + 5) * 4;
    expect(data[i + 3]).toBeGreaterThan(0);
    expect(data[i + 3]).toBeLessThan(255);
    expect(data[i] as number).toBeLessThan(180);
  });

  it("takes the paper's tint out of edge pixels, not just its brightness", () => {
    const w = 10;
    const paper = [250, 235, 190, 255]; // yellowish paper
    const data = image(w, 3, paper);
    // An edge pixel: a little black ink over that paper (paper × 0.75).
    setPixel(data, w, 5, 1, [187, 176, 142, 255]);
    removeBackground(data, w, 3);
    const i = (1 * w + 5) * 4;
    expect(data[i + 3]).toBeGreaterThan(0);
    expect(data[i + 3]).toBeLessThan(255);
    const [r, g, b] = [data[i] as number, data[i + 1] as number, data[i + 2] as number];
    // The ink comes out close to neutral grey. Un-mixing with the paper's brightness alone
    // (the same value for all three channels) leaves it strongly yellow: a spread of ~97.
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(40);
  });

  it("knows when an image already has no background", () => {
    expect(hasTransparency(image(2, 2))).toBe(false);
    expect(hasTransparency(image(2, 2, [0, 0, 0, 0]))).toBe(true);
  });
});

describe("placing a stamp", () => {
  const a4 = { width: 595, height: 842 };

  it("sizes each kind sensibly, keeping proportions, centred on the page", () => {
    const sig = initialRect(a4, 3, "signature");
    expect(sig.width).toBe(170);
    expect(sig.height).toBeCloseTo(170 / 3);
    expect(sig.left + sig.width / 2).toBeCloseTo(a4.width / 2);
    expect(sig.top + sig.height / 2).toBeCloseTo(a4.height / 2);
    expect(initialRect(a4, 1, "initials").width).toBe(60);
  });

  it("goes where the user clicked, but never off the page", () => {
    const r = initialRect(a4, 3, "signature", { x: 590, y: 5 });
    expect(r.left + r.width).toBeLessThanOrEqual(a4.width);
    expect(r.top).toBe(0);
  });

  it("fits on tiny pages and copes with a bad aspect ratio", () => {
    const tiny = { width: 4, height: 4 };
    const r = initialRect(tiny, 3, "signature");
    expect(r.width).toBeLessThanOrEqual(4);
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(initialRect(a4, Number.NaN, "initials").height).toBe(60);
  });

  it("keeps moved stamps inside the page, shrinking ones that are too big", () => {
    expect(clampRect({ left: -10, top: 900, width: 100, height: 50 }, a4)).toEqual({
      left: 0,
      top: 792,
      width: 100,
      height: 50,
    });
    const big = clampRect({ left: 0, top: 0, width: 1190, height: 100 }, a4);
    expect(big.width).toBe(595);
    expect(big.height).toBe(50);
  });

  it("resizes keeping proportions, between the minimum size and the page edge", () => {
    const rect = { left: 500, top: 100, width: 60, height: 20 };
    expect(resizeRect(rect, 90, a4)).toMatchObject({ width: 90, height: 30 });
    expect(resizeRect(rect, 1000, a4).width).toBe(95);
    expect(resizeRect(rect, 1, a4).height).toBe(MIN_STAMP_SIZE);
  });

  it("scales down but never up", () => {
    expect(fitWithin(100, 50, 400, 400)).toEqual({ width: 100, height: 50 });
    expect(fitWithin(800, 400, 400, 400)).toEqual({ width: 400, height: 200 });
  });
});

describe("placementKey", () => {
  const page = { width: 595, height: 842 };
  const rect = { left: 100, top: 100, width: 60, height: 20 };

  it("moves with the arrows, further with Shift, and never off the page", () => {
    expect(placementKey("ArrowRight", false, rect, page)).toEqual({
      type: "change",
      rect: { ...rect, left: 101 },
    });
    expect(placementKey("ArrowUp", true, rect, page)).toEqual({
      type: "change",
      rect: { ...rect, top: 90 },
    });
    const atEdge = { ...rect, left: 0 };
    expect(placementKey("ArrowLeft", true, atEdge, page)).toEqual({ type: "change", rect: atEdge });
  });

  it("resizes with + and -, applies with Enter, cancels with Escape, and ignores the rest", () => {
    const bigger = placementKey("+", false, rect, page);
    expect(bigger?.type === "change" && bigger.rect.width).toBeCloseTo(66);
    const smaller = placementKey("-", false, rect, page);
    expect(smaller?.type === "change" && smaller.rect.height).toBeLessThan(20);
    expect(placementKey("Enter", false, rect, page)).toEqual({ type: "apply" });
    expect(placementKey("Escape", false, rect, page)).toEqual({ type: "cancel" });
    expect(placementKey("a", false, rect, page)).toBeNull();
  });
});
