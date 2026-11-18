// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { textColor } from "./annotationObjects";

describe("textColor", () => {
  it("reads an RGB or grey fill colour", () => {
    expect(textColor("/Helv 12 Tf 1 0 0 rg")).toEqual([1, 0, 0]);
    expect(textColor("/Helv 12 Tf 0.5 g")).toEqual([0.5, 0.5, 0.5]);
  });

  it("accepts every form of PDF number", () => {
    expect(textColor("/Helv 12 Tf 1. .5 0 rg")).toEqual([1, 0.5, 0]);
    expect(textColor("/Helv 12 Tf +1 -0 0. rg")).toEqual([1, -0, 0]);
  });

  it("uses whichever colour operator comes last", () => {
    expect(textColor("1 0 0 rg 0 g /Helv 12 Tf")).toEqual([0, 0, 0]);
    expect(textColor("0 g 0 0 1 rg")).toEqual([0, 0, 1]);
  });

  it("finds nothing when there's no fill colour", () => {
    expect(textColor("/Helv 12 Tf")).toBeNull();
    expect(textColor("")).toBeNull();
    expect(textColor("0 0 1 RG")).toBeNull(); // a stroke colour, not the text's fill
  });
});
