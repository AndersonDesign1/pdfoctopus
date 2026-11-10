// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { describePages, parsePageRanges, splitEvery, splitSingle } from "./pageRanges";

describe("parsePageRanges", () => {
  it("reads pages, ranges and open-ended ranges (1-based in, 0-based out)", () => {
    expect(parsePageRanges("1-3, 5, 8-", 10)).toEqual([[0, 1, 2], [4], [7, 8, 9]]);
    expect(parsePageRanges(" -2 ; 4 – 4 ", 5)).toEqual([[0, 1], [3]]);
  });

  it("explains what's wrong", () => {
    expect(() => parsePageRanges("", 5)).toThrow(/at least one/);
    expect(() => parsePageRanges("abc", 5)).toThrow(/isn't a page/);
    expect(() => parsePageRanges("0", 5)).toThrow(/outside/);
    expect(() => parsePageRanges("4-6", 5)).toThrow(/outside/);
    expect(() => parsePageRanges("4-2", 5)).toThrow(/backwards/);
    expect(() => parsePageRanges("-", 5)).toThrow(/isn't a page/);
    expect(() => parsePageRanges("8-", 5)).toThrow(/outside/);
  });
});

describe("splitEvery and splitSingle", () => {
  it("groups pages, with a shorter last group", () => {
    expect(splitEvery(2, 5)).toEqual([[0, 1], [2, 3], [4]]);
    expect(splitSingle(3)).toEqual([[0], [1], [2]]);
    expect(() => splitEvery(0, 5)).toThrow(/1 or more/);
  });
});

describe("describePages", () => {
  it("names a group for a file name", () => {
    expect(describePages([4])).toBe("page-5");
    expect(describePages([0, 1, 2])).toBe("pages-1-3");
    expect(describePages([0, 2])).toBe("pages-1-etc");
  });
});
