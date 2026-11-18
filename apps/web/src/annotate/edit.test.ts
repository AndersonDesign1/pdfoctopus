// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AnnotationInfo } from "@pdfoctopus/core";
import { describe, expect, it } from "vitest";
import { arrowDelta, hitTest, keepsAspect, MIN_SIZE, moveBox, resizeBox, sameBox } from "./edit";

const page = { width: 200, height: 100 };

function annotation(id: number, rect: AnnotationInfo["rect"], label = "rectangle"): AnnotationInfo {
  return {
    id,
    label,
    rect,
    color: null,
    text: null,
    canResize: true,
    canRecolor: true,
    canEditText: false,
  };
}

describe("hitTest", () => {
  const below = annotation(1, [10, 10, 100, 60]);
  const above = annotation(2, [50, 20, 80, 40]);

  it("picks the topmost annotation under the point", () => {
    expect(hitTest([below, above], [60, 30])?.id).toBe(2);
    expect(hitTest([below, above], [20, 30])?.id).toBe(1);
  });

  it("accepts clicks just outside a box, so thin lines can be picked", () => {
    expect(hitTest([below], [8, 30])?.id).toBe(1);
    expect(hitTest([below], [5, 30])).toBeNull();
  });

  it("finds nothing on an empty page", () => {
    expect(hitTest([], [0, 0])).toBeNull();
  });
});

describe("moveBox", () => {
  it("moves a box", () => {
    expect(moveBox([10, 10, 30, 20], 5, 7, page)).toEqual([15, 17, 35, 27]);
  });

  it("stops at the page's edges", () => {
    expect(moveBox([10, 10, 30, 20], -50, 500, page)).toEqual([0, 90, 20, 100]);
    expect(moveBox([10, 10, 30, 20], 500, -50, page)).toEqual([180, 0, 200, 10]);
  });
});

describe("resizeBox", () => {
  it("moves the bottom-right corner to the pointer", () => {
    expect(resizeBox([10, 10, 30, 20], [60, 50], page, false)).toEqual([10, 10, 60, 50]);
  });

  it("keeps a minimum size and stays on the page", () => {
    expect(resizeBox([10, 10, 30, 20], [0, 0], page, false)).toEqual([
      10,
      10,
      10 + MIN_SIZE,
      10 + MIN_SIZE,
    ]);
    expect(resizeBox([10, 10, 30, 20], [999, 999], page, false)).toEqual([10, 10, 200, 100]);
  });

  it("keeps proportions when asked", () => {
    const box = resizeBox([10, 10, 50, 30], [90, 0], page, true); // 2:1
    expect(box).toEqual([10, 10, 90, 50]);
    // Limited by the page's height: 90 tall at most, so 180 wide, but only 190 fits anyway.
    const big = resizeBox([10, 10, 50, 30], [999, 999], page, true);
    expect(big[3]).toBeLessThanOrEqual(100);
    expect((big[2] - big[0]) / (big[3] - big[1])).toBeCloseTo(2);
  });
});

describe("helpers", () => {
  it("keeps the proportions of stamps, not of shapes", () => {
    expect(keepsAspect({ label: "signature" })).toBe(true);
    expect(keepsAspect({ label: "stamp" })).toBe(true);
    expect(keepsAspect({ label: "rectangle" })).toBe(false);
  });

  it("maps arrow keys to steps", () => {
    expect(arrowDelta("ArrowLeft", false)).toEqual([-1, 0]);
    expect(arrowDelta("ArrowDown", true)).toEqual([0, 10]);
    expect(arrowDelta("a", false)).toBeNull();
  });

  it("compares boxes allowing for rounding", () => {
    expect(sameBox([0, 0, 1, 1], [0.001, 0, 1, 1])).toBe(true);
    expect(sameBox([0, 0, 1, 1], [0.5, 0, 1, 1])).toBe(false);
  });
});
