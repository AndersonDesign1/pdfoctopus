// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TextEditCheck } from "@pdfoctopus/core";
import { describe, expect, it } from "vitest";
import { editWarnings } from "./warnings";

const plain: TextEditCheck = {
  font: "DejaVu Sans",
  fallback: null,
  missing: [],
  tooWide: false,
  mixedFonts: false,
  width: 50,
  room: 200,
};

describe("editWarnings", () => {
  it("says nothing when the edit is straightforward", () => {
    expect(editWarnings(plain, false, "DejaVu Sans")).toEqual([]);
  });

  it("names the missing characters and the font used instead", () => {
    const [line] = editWarnings(
      { ...plain, font: "Helvetica", fallback: "Helvetica", missing: ["é", "ß"] },
      false,
      "DejaVu Sans",
    );
    expect(line).toBe(
      "DejaVu Sans in this file doesn't include “é” and “ß”, so the line will use Helvetica instead. It may look a little different.",
    );
    const [some] = editWarnings(
      { ...plain, fallback: "Helvetica", missing: ["−"] },
      false,
      "DejaVu Sans",
    );
    expect(some).toContain("doesn't include “−”, so those characters will use Helvetica");
  });

  it("warns about text that's too long, mixed fonts and signatures", () => {
    const all = editWarnings({ ...plain, tooWide: true, mixedFonts: true }, true, "DejaVu Sans");
    expect(all).toHaveLength(3);
    expect(all[0]).toMatch(/longer than the space/);
    expect(all[1]).toMatch(/more than one font/);
    expect(all[2]).toMatch(/digitally signed/);
  });
});
