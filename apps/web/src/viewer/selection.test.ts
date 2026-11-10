// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  clampSelection,
  clickSelection,
  dropIndexAt,
  EMPTY_SELECTION,
  moveTarget,
  selectAll,
  selectRun,
  targetPages,
} from "./selection";

describe("clickSelection", () => {
  it("selects one page on a plain click", () => {
    const s = clickSelection({ pages: [1, 2], anchor: 1 }, 5);
    expect(s).toEqual({ pages: [5], anchor: 5 });
  });

  it("toggles with Ctrl/Cmd", () => {
    let s = clickSelection(EMPTY_SELECTION, 3, { toggle: true });
    s = clickSelection(s, 1, { toggle: true });
    expect(s.pages).toEqual([1, 3]);
    s = clickSelection(s, 3, { toggle: true });
    expect(s.pages).toEqual([1]);
  });

  it("selects a range with Shift, from the anchor either way", () => {
    const start = clickSelection(EMPTY_SELECTION, 4);
    expect(clickSelection(start, 7, { range: true }).pages).toEqual([4, 5, 6, 7]);
    expect(clickSelection(start, 2, { range: true }).pages).toEqual([2, 3, 4]);
    const kept = clickSelection({ pages: [0], anchor: 4 }, 5, { range: true, toggle: true });
    expect(kept.pages).toEqual([0, 4, 5]);
  });

  it("treats Shift without an anchor as a plain click", () => {
    expect(clickSelection(EMPTY_SELECTION, 2, { range: true }).pages).toEqual([2]);
  });
});

describe("helpers", () => {
  it("selects all, a run, and clamps after pages are removed", () => {
    expect(selectAll(3).pages).toEqual([0, 1, 2]);
    expect(selectRun(4, 2)).toEqual({ pages: [4, 5], anchor: 4 });
    expect(clampSelection({ pages: [1, 5, 6], anchor: 6 }, 6)).toEqual({
      pages: [1, 5],
      anchor: null,
    });
  });

  it("targets the selection, or the current page", () => {
    expect(targetPages(EMPTY_SELECTION, 3)).toEqual([3]);
    expect(targetPages({ pages: [0, 2], anchor: 0 }, 3)).toEqual([0, 2]);
  });
});

describe("moveTarget", () => {
  it("counts the drop position without the moved pages", () => {
    // Pages 1 and 4 of 0..5 dropped before page 4 → after 0, 2, 3.
    expect(moveTarget([4, 1], 4)).toBe(3);
    expect(moveTarget([3], 0)).toBe(0);
    expect(moveTarget([0], 4)).toBe(3);
  });

  it("returns null when the pages would stay where they are", () => {
    expect(moveTarget([2], 2)).toBeNull();
    expect(moveTarget([2], 3)).toBeNull();
    expect(moveTarget([1, 2], 1)).toBeNull();
    expect(moveTarget([1, 3], 2)).toBe(1);
  });
});

describe("dropIndexAt", () => {
  it("finds the gap under the pointer", () => {
    const tops = [0, 100, 200];
    const heights = [80, 80, 80];
    expect(dropIndexAt(10, tops, heights)).toBe(0);
    expect(dropIndexAt(50, tops, heights)).toBe(1);
    expect(dropIndexAt(239, tops, heights)).toBe(2);
    expect(dropIndexAt(250, tops, heights)).toBe(3);
  });
});
