// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Page labels follow their pages when pages are deleted, moved or inserted, and undo puts
// them back as they were.

import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { PdfEngine } from "./engine";

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

type Range = [start: number, style?: string, prefix?: string, first?: number];

/** A PDF of `count` pages, each showing its own number, with these label ranges. */
function labelledPdf(count: number, ranges: Range[] | null): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  const fonts = pdf.newDictionary();
  fonts.put("F1", pdf.addSimpleFont(new mupdf.Font("Helvetica")));
  for (let i = 0; i < count; i++) {
    const resources = pdf.newDictionary();
    resources.put("Font", fonts);
    const content = `BT /F1 20 Tf 40 150 Td (Sheet ${i + 1}) Tj ET`;
    pdf.insertPage(-1, pdf.addPage([0, 0, 300, 300], 0, resources, content));
  }
  if (ranges) {
    const nums = pdf.newArray();
    for (const [start, style, prefix, first] of ranges) {
      const dict = pdf.newDictionary();
      if (style) dict.put("S", pdf.newName(style));
      if (prefix) dict.put("P", pdf.newString(prefix));
      if (first) dict.put("St", first);
      nums.push(start);
      nums.push(dict);
    }
    const tree = pdf.newDictionary();
    tree.put("Nums", nums);
    pdf.getTrailer().get("Root").put("PageLabels", pdf.addObject(tree));
  }
  const out = pdf.saveToBuffer("").asUint8Array().slice();
  pdf.destroy();
  return out;
}

/** Labels and the text each page shows, read back from a saved copy. */
function readBack(engine: PdfEngine, incremental = false) {
  const doc = mupdf.Document.openDocument(engine.save({ incremental }), "application/pdf");
  try {
    expect((doc.asPDF() as mupdf.PDFDocument).wasRepaired()).toBe(false);
    const labels: string[] = [];
    const sheets: string[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      labels.push(page.getLabel());
      sheets.push(
        page
          .toStructuredText("preserve-whitespace")
          .asText()
          .trim()
          .replace(/^Sheet /, ""),
      );
      page.destroy();
    }
    return { labels: labels.join(","), sheets: sheets.join(",") };
  } finally {
    doc.destroy();
  }
}

// i, ii, iii, 1, 2, 3
const FRONT_MATTER: Range[] = [
  [0, "r"],
  [3, "D"],
];

describe("page labels", () => {
  it("renumbers a section when one of its pages is deleted", () => {
    const engine = open(labelledPdf(6, FRONT_MATTER));
    expect(readBack(engine).labels).toBe("i,ii,iii,1,2,3");
    engine.deletePages([1]);
    expect(readBack(engine)).toEqual({ labels: "i,ii,1,2,3", sheets: "1,3,4,5,6" });
    engine.undo();
    expect(readBack(engine).labels).toBe("i,ii,iii,1,2,3");
    engine.redo();
    expect(readBack(engine).labels).toBe("i,ii,1,2,3");
  });

  it("keeps the next section starting at the same page after a deletion", () => {
    const engine = open(labelledPdf(6, FRONT_MATTER));
    engine.deletePages([3]);
    expect(readBack(engine)).toEqual({ labels: "i,ii,iii,1,2", sheets: "1,2,3,5,6" });
  });

  it("keeps moved pages in their section, numbering each section in order", () => {
    const engine = open(labelledPdf(6, FRONT_MATTER));
    engine.movePages([5], 0);
    expect(readBack(engine)).toEqual({ labels: "1,i,ii,iii,2,3", sheets: "6,1,2,3,4,5" });
    engine.undo();
    expect(readBack(engine)).toEqual({ labels: "i,ii,iii,1,2,3", sheets: "1,2,3,4,5,6" });
  });

  it("numbers inserted pages with the section before them", () => {
    const engine = open(labelledPdf(6, FRONT_MATTER));
    engine.insertBlankPages(4, 2);
    expect(readBack(engine).labels).toBe("i,ii,iii,1,2,3,4,5");
    engine.undo();
    // At the start there's no page before: they join the first section.
    engine.insertBlankPages(0);
    expect(readBack(engine).labels).toBe("i,ii,iii,iv,1,2,3");
    engine.undo();
    engine.insertPdfs(6, [{ bytes: labelledPdf(2, [[0, "A"]]) }]);
    expect(readBack(engine).labels).toBe("i,ii,iii,1,2,3,4,5");
  });

  it("keeps prefixes and start numbers", () => {
    // A-5, A-6, A-7, then B (prefix only).
    const engine = open(
      labelledPdf(4, [
        [0, "D", "A-", 5],
        [3, undefined, "Back cover"],
      ]),
    );
    expect(readBack(engine).labels).toBe("A-5,A-6,A-7,Back cover");
    engine.deletePages([0]);
    expect(readBack(engine).labels).toBe("A-5,A-6,Back cover");
    engine.movePages([2], 0);
    expect(readBack(engine).labels).toBe("Back cover,A-5,A-6");
  });

  it("saves the new labels incrementally", () => {
    const engine = open(labelledPdf(6, FRONT_MATTER));
    engine.deletePages([0]);
    expect(readBack(engine, true).labels).toBe("i,ii,1,2,3");
  });

  it("leaves a document without labels without them", () => {
    const engine = open(labelledPdf(3, null));
    engine.deletePages([0]);
    // MuPDF adds labels when it moves or inserts pages ("1, 1" here); they're taken away.
    expect(engine.movePages([1], 0).info.labels).toEqual([null, null]);
    expect(readBack(engine).labels).toBe("1,2");
    engine.undo();
    expect(readBack(engine).labels).toBe("1,2");
    engine.redo();
    engine.insertBlankPages(0);
    expect(readBack(engine).labels).toBe("1,2,3");
    const doc = mupdf.Document.openDocument(engine.save(), "application/pdf");
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    expect(pdf.getTrailer().get("Root").get("PageLabels").isDictionary()).toBe(false);
    doc.destroy();
  });

  it("copes with a label tree that skips the first pages or has stray keys", () => {
    // No range for pages 0-1 (shown as plain numbers, as MuPDF does); a key past the end is
    // ignored.
    const engine = open(
      labelledPdf(4, [
        [2, "D"],
        [99, "R"],
      ]),
    );
    expect(readBack(engine).labels).toBe("1,2,1,2");
    engine.deletePages([0]);
    expect(readBack(engine).labels).toBe("1,1,2");
  });
});
