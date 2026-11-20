// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { chosenPages } from "./ExportDialog";

describe("chosenPages", () => {
  const base = { pageCount: 5, current: 2, selected: [4, 1], range: "" };

  it("gives all pages, this page or the selected pages in order", () => {
    expect(chosenPages("all", base)).toEqual([0, 1, 2, 3, 4]);
    expect(chosenPages("current", base)).toEqual([2]);
    expect(chosenPages("selected", base)).toEqual([1, 4]);
  });

  it("reads a range, each page once, in the order typed", () => {
    expect(chosenPages("range", { ...base, range: "4-5, 1, 4" })).toEqual([3, 4, 0]);
    expect(chosenPages("range", { ...base, range: "3-" })).toEqual([2, 3, 4]);
  });

  it("explains a range it can't read", () => {
    expect(() => chosenPages("range", { ...base, range: "" })).toThrow(/at least one page/);
    expect(() => chosenPages("range", { ...base, range: "9" })).toThrow(/outside/);
    expect(() => chosenPages("range", { ...base, range: "x" })).toThrow(/isn't a page/);
  });
});
