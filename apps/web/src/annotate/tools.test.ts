// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  clampPoint,
  cssColor,
  defaultTextRect,
  dragRect,
  isClick,
  TOOLS,
  thinStroke,
  toolById,
} from "./tools";

const page = { width: 400, height: 300 };

describe("annotation tools", () => {
  it("has one entry per tool, each findable by id", () => {
    const ids = TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(toolById(id).id).toBe(id);
  });

  it("writes colours for CSS", () => {
    expect(cssColor([1, 0.5, 0])).toBe("rgb(255 128 0)");
  });
});

describe("geometry", () => {
  it("turns a drag in any direction into a box on the page", () => {
    expect(dragRect([100, 80], [20, 10], page)).toEqual([20, 10, 100, 80]);
    expect(dragRect([-20, 250], [450, 400], page)).toEqual([0, 250, 400, 300]);
    expect(clampPoint([500, -5], page)).toEqual([400, 0]);
  });

  it("tells a click from a drag", () => {
    expect(isClick([10, 10], [11, 12])).toBe(true);
    expect(isClick([10, 10], [20, 10])).toBe(false);
  });

  it("gives a clicked text box a default size that stays on the page", () => {
    expect(defaultTextRect([50, 50], page)).toEqual([50, 50, 250, 80]);
    const [x0, y0, x1, y1] = defaultTextRect([390, 295], page);
    expect(x1).toBe(400);
    expect(y1).toBe(300);
    expect(x0).toBeGreaterThanOrEqual(0);
    expect(y0).toBeGreaterThanOrEqual(0);
    const tiny = defaultTextRect([0, 0], { width: 50, height: 10 });
    expect(tiny).toEqual([0, 0, 50, 10]);
  });

  it("thins a pen stroke but keeps its ends", () => {
    const slow = Array.from({ length: 100 }, (_, i) => [i * 0.1, 0] as [number, number]);
    const thin = thinStroke(slow);
    expect(thin.length).toBeLessThan(20);
    expect(thin[0]).toEqual([0, 0]);
    expect(thin[thin.length - 1]).toEqual(slow[slow.length - 1]);
    expect(thinStroke([])).toEqual([]);
    expect(thinStroke([[1, 1]])).toEqual([[1, 1]]);
  });
});
