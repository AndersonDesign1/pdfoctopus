// SPDX-License-Identifier: AGPL-3.0-or-later

import { MAX_STAMP_TEXT } from "@pdfoctopus/core";
import { describe, expect, it } from "vitest";
import { STAMP_PRESETS, stampTextProblem } from "./textStampPreview";

describe("stampTextProblem", () => {
  it("accepts Latin text, accents and punctuation", () => {
    expect(stampTextProblem("APPROVED")).toBeNull();
    expect(stampTextProblem("Payé – no")).not.toBeNull(); // an en dash isn't in the fonts
    expect(stampTextProblem("Payé - reçu, 18/11 (#42)")).toBeNull();
  });

  it("names a character the stamp can't show", () => {
    expect(stampTextProblem("OK ✓")).toMatch(/"✓"/);
    expect(stampTextProblem("承認")).toMatch(/"承"/);
  });

  it("offers only presets the engine accepts", () => {
    for (const p of STAMP_PRESETS) {
      expect(stampTextProblem(p.text)).toBeNull();
      expect(p.text.length).toBeLessThanOrEqual(MAX_STAMP_TEXT);
    }
  });
});
