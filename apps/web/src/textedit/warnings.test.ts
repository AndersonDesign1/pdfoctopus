// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ParagraphEditCheck, TextEditCheck } from "@pdfoctopus/core";
import { describe, expect, it } from "vitest";
import { editWarnings, paragraphWarnings } from "./warnings";

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

describe("paragraphWarnings", () => {
  const fits: ParagraphEditCheck = {
    font: "Liberation Serif",
    fallback: null,
    missing: [],
    lines: 3,
    oldLines: 3,
    fit: 4,
    overflow: false,
    splitWords: false,
  };

  it("says nothing when the new text fits", () => {
    expect(paragraphWarnings(fits, false, "Liberation Serif")).toEqual([]);
  });

  it("says plainly when the text no longer fits and what applying it anyway does", () => {
    const [line] = paragraphWarnings(
      { ...fits, lines: 6, overflow: true },
      false,
      "Liberation Serif",
    );
    expect(line).toBe(
      "The new text needs 6 lines, but only 4 fit in the paragraph's space. If you apply it anyway, the last 2 lines will overlap what's below the paragraph. Nothing else on the page moves to make room.",
    );
    expect(paragraphWarnings({ ...fits, lines: 5, overflow: true }, false, "X")[0]).toContain(
      "the last line will overlap",
    );
  });

  it("names a stand-in font for the paragraph, a word too wide and a signed file", () => {
    const all = paragraphWarnings(
      { ...fits, font: "Helvetica", fallback: "Helvetica", missing: ["é"], splitWords: true },
      true,
      "CMR10",
    );
    expect(all).toHaveLength(3);
    expect(all[0]).toContain("so the paragraph will use Helvetica instead");
    expect(all[1]).toMatch(/split across lines between letters/);
    expect(all[2]).toMatch(/digitally signed/);
  });
});
