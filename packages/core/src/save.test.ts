// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Saving more than once in a session. Each save must be a valid file on its own: the original
// bytes, untouched, plus one update holding every change since the file was opened. MuPDF
// 1.28 points a second save's trailer (/Prev) at where the first save's update would be had it
// been appended to the original file, which made later saves need repair, or not open at all.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { createBlankPdf, PdfEngine } from "./engine";

const generated = join(import.meta.dirname, "..", "..", "..", "fixtures", "generated");
const fixture = (name: string) => new Uint8Array(readFileSync(join(generated, name)));

const opened: PdfEngine[] = [];
afterEach(() => {
  for (const engine of opened.splice(0)) engine.close();
});

function open(bytes: Uint8Array): PdfEngine {
  const engine = new PdfEngine();
  opened.push(engine);
  engine.open(bytes);
  return engine;
}

/** Opens a saved file and reports whether MuPDF had to repair it, and each page's rotation. */
function inspect(bytes: Uint8Array): { repaired: boolean; rotations: number[] } {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    const rotations: number[] = [];
    for (let i = 0; i < pdf.countPages(); i++) {
      const r = pdf.findPage(i).getInheritable("Rotate");
      rotations.push(r.isNumber() ? r.asNumber() : 0);
    }
    return { repaired: pdf.wasRepaired(), rotations };
  } finally {
    doc.destroy();
  }
}

const files: [string, () => Uint8Array][] = [
  ["a simple file", () => createBlankPdf(2)],
  ["a file from Chromium", () => fixture("contract-chromium.pdf")],
  ["a file that already has updates", () => fixture("incremental-updates.pdf")],
  ["a signed file", () => fixture("signed.pdf")],
];

describe("saving more than once", () => {
  it.each(files)("keeps every save of %s valid", (_name, load) => {
    const original = load();
    const engine = open(original.slice());
    const pageCount = engine.pageCount;
    const expected = Array.from({ length: pageCount }, () => 0);

    engine.rotatePages([0], 90);
    expected[0] = 90;
    const first = engine.save();
    expect(inspect(first)).toEqual({ repaired: false, rotations: expected });

    // Saving again with no change in between (pressing Save twice, or Save then Save as).
    const again = engine.save();
    expect(inspect(again)).toEqual({ repaired: false, rotations: expected });

    // Another change, then save: it holds both changes.
    const last = pageCount - 1;
    engine.rotatePages([last], 180);
    expected[last] = (expected[last] as number) + 180;
    const third = engine.save();
    expect(inspect(third)).toEqual({ repaired: false, rotations: expected });

    // Every save starts with the original bytes, untouched.
    for (const saved of [first, again, third]) {
      expect(saved.subarray(0, original.length)).toEqual(original);
    }
  });

  it("keeps annotations through repeated saves", () => {
    const engine = open(createBlankPdf(1));
    engine.addAnnotation({
      kind: "rectangle",
      page: 0,
      rect: [10, 10, 50, 50],
      color: [1, 0, 0],
      width: 1,
    });
    engine.save();
    engine.addAnnotation({
      kind: "ellipse",
      page: 0,
      rect: [60, 10, 90, 50],
      color: [1, 0, 0],
      width: 1,
    });
    engine.save();
    const saved = engine.save();
    expect(inspect(saved).repaired).toBe(false);
    const reopened = open(saved);
    expect(reopened.renderPage(0, 0.5).width).toBeGreaterThan(0);
    const doc = mupdf.Document.openDocument(saved, "application/pdf");
    expect(doc.asPDF()?.findPage(0).get("Annots").length).toBe(2);
    doc.destroy();
  });
});
