// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { createBlankPdf, PdfEngine } from "./engine";
import { PasswordRequiredError } from "./errors";

const generated = join(import.meta.dirname, "..", "..", "..", "fixtures", "generated");
const fixture = (name: string) => new Uint8Array(readFileSync(join(generated, name)));

/**
 * A PDF whose page i (0-based) carries the word "mark<first + i>x", so pages can be told
 * apart (also from pages inserted from another marked PDF with a different `first`).
 */
function markedPdf(count: number, width = 300, height = 400, first = 0): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  try {
    const font = pdf.addSimpleFont(new mupdf.Font("Helvetica"));
    for (let i = 0; i < count; i++) {
      const resources = pdf.newDictionary();
      const fonts = pdf.newDictionary();
      fonts.put("F1", font);
      resources.put("Font", fonts);
      const page = pdf.addPage(
        [0, 0, width, height],
        0,
        resources,
        `BT /F1 20 Tf 40 200 Td (mark${first + i}x) Tj ET`,
      );
      pdf.insertPage(-1, page);
    }
    const buffer = pdf.saveToBuffer("");
    try {
      return buffer.asUint8Array().slice();
    } finally {
      buffer.destroy();
    }
  } finally {
    pdf.destroy();
  }
}

/** Which original page (by its mark) sits at each position; -1 for a page with no mark. */
function order(engine: PdfEngine): number[] {
  const count = engine.pageCount;
  const result = Array.from({ length: count }, () => -1);
  for (let mark = 0; mark < 50; mark++) {
    for (const hit of engine.search(`mark${mark}x`).hits) result[hit.page] = mark;
  }
  return result;
}

function open(bytes: Uint8Array, password?: string): PdfEngine {
  const engine = new PdfEngine();
  const result = engine.open(bytes);
  if (result.needsPassword && !engine.authenticate(password ?? "")) {
    throw new Error("wrong password");
  }
  return engine;
}

/** Reopen saved bytes in a fresh engine. */
function reopen(bytes: Uint8Array, password?: string): PdfEngine {
  return open(bytes, password);
}

describe("rotatePages", () => {
  it("rotates on top of the existing rotation and swaps the reported size", () => {
    const engine = open(markedPdf(3));
    const result = engine.rotatePages([0, 2], 90);
    expect(result.info.pages[0]).toEqual({ width: 400, height: 300 });
    expect(result.info.pages[1]).toEqual({ width: 300, height: 400 });
    expect(result.history).toEqual({
      canUndo: true,
      canRedo: false,
      undoLabel: "Rotate 2 pages",
      redoLabel: null,
    });
    engine.rotatePages([0], 270);
    expect(engine.info().pages[0]).toEqual({ width: 300, height: 400 });
    engine.rotatePages([1], -90);
    const saved = reopen(engine.save());
    expect(saved.info().pages.map((p) => p.width)).toEqual([300, 400, 400]);
  });

  it("is undone and redone", () => {
    const engine = open(markedPdf(2));
    engine.rotatePages([1], 180);
    expect(engine.undo()?.history.canRedo).toBe(true);
    const page = (engine as unknown as { doc: mupdf.Document }).doc.asPDF()?.findPage(1);
    expect(
      page?.getInheritable("Rotate").isNull() || page?.getInheritable("Rotate").asNumber() === 0,
    ).toBe(true);
    expect(engine.redo()?.history.undoLabel).toBe("Rotate 1 page");
    expect(page?.get("Rotate").asNumber()).toBe(180);
  });

  it("rejects pages that don't exist and odd angles", () => {
    const engine = open(markedPdf(2));
    expect(() => engine.rotatePages([2], 90)).toThrow(/doesn't exist/);
    expect(() => engine.rotatePages([], 90)).toThrow(/at least one/);
    expect(() => engine.rotatePages([0], 45 as 90)).toThrow(/90, 180 or 270/);
    expect(engine.history().canUndo).toBe(false);
  });
});

describe("deletePages", () => {
  it("deletes pages and undo puts the same pages back in place", () => {
    const engine = open(markedPdf(5));
    expect(engine.deletePages([3, 1, 1]).info.pageCount).toBe(3);
    expect(order(engine)).toEqual([0, 2, 4]);
    engine.undo();
    expect(order(engine)).toEqual([0, 1, 2, 3, 4]);
    engine.redo();
    expect(order(engine)).toEqual([0, 2, 4]);
    expect(order(reopen(engine.save()))).toEqual([0, 2, 4]);
  });

  it("refuses to delete every page", () => {
    const engine = open(markedPdf(2));
    expect(() => engine.deletePages([0, 1])).toThrow(/at least one page/);
    expect(engine.pageCount).toBe(2);
  });
});

describe("movePages", () => {
  it("moves a block of pages, keeping their order", () => {
    const engine = open(markedPdf(6));
    // Take pages 1 and 4 out (leaving 0 2 3 5) and put them at position 3.
    engine.movePages([4, 1], 3);
    expect(order(engine)).toEqual([0, 2, 3, 1, 4, 5]);
    engine.undo();
    expect(order(engine)).toEqual([0, 1, 2, 3, 4, 5]);
    engine.redo();
    expect(order(engine)).toEqual([0, 2, 3, 1, 4, 5]);
  });

  it("moves to the start and the end", () => {
    const engine = open(markedPdf(4));
    engine.movePages([3], 0);
    expect(order(engine)).toEqual([3, 0, 1, 2]);
    engine.movePages([0], 3);
    expect(order(engine)).toEqual([0, 1, 2, 3]);
    expect(order(reopen(engine.save()))).toEqual([0, 1, 2, 3]);
  });

  it("records nothing for a move that changes nothing", () => {
    const engine = open(markedPdf(4));
    engine.movePages([1, 2], 1);
    expect(engine.history().canUndo).toBe(false);
    expect(() => engine.movePages([0], 4)).toThrow(/out of range/);
  });
});

describe("insertBlankPages", () => {
  it("inserts blank pages the size of the neighbouring page", () => {
    const engine = open(markedPdf(2, 200, 100));
    const result = engine.insertBlankPages(1, 2);
    expect(result.info.pageCount).toBe(4);
    expect(result.info.pages[1]).toEqual({ width: 200, height: 100 });
    expect(order(engine)).toEqual([0, -1, -1, 1]);
    expect(result.history.undoLabel).toBe("Insert 2 blank pages");
    engine.undo();
    expect(order(engine)).toEqual([0, 1]);
    engine.redo();
    engine.insertBlankPages(4, 1, { width: 612, height: 792 });
    const saved = reopen(engine.save());
    expect(saved.info().pages[4]).toEqual({ width: 612, height: 792 });
    expect(Array.from(saved.renderPage(1, 0.2).pixels.slice(0, 4))).toEqual([255, 255, 255, 255]);
  });

  it("matches a rotated neighbour the way it's shown", () => {
    const engine = open(markedPdf(1, 200, 100));
    engine.rotatePages([0], 90);
    const result = engine.insertBlankPages(1);
    expect(result.info.pages[0]).toEqual({ width: 100, height: 200 });
    expect(result.info.pages[1]).toEqual({ width: 100, height: 200 });
  });

  it("rejects bad positions, counts and sizes", () => {
    const engine = open(markedPdf(2));
    expect(() => engine.insertBlankPages(3)).toThrow(/out of range/);
    expect(() => engine.insertBlankPages(0, 0)).toThrow(/between 1 and 1000/);
    expect(() => engine.insertBlankPages(0, 1, { width: 0, height: 10 })).toThrow(/size/);
  });
});

describe("insertPdfs", () => {
  it("inserts chosen pages from another PDF, and undo removes them", () => {
    const engine = open(markedPdf(3));
    const other = markedPdf(10);
    const result = engine.insertPdfs(1, [{ bytes: other, pages: [9, 7] }]);
    expect(result.info.pageCount).toBe(5);
    expect(order(engine)).toEqual([0, 9, 7, 1, 2]);
    engine.undo();
    expect(order(engine)).toEqual([0, 1, 2]);
    engine.redo();
    expect(order(reopen(engine.save()))).toEqual([0, 9, 7, 1, 2]);
  });

  it("merges several files at the end as one step", () => {
    const engine = open(createBlankPdf(1));
    const result = engine.insertPdfs(1, [
      { bytes: markedPdf(2) },
      { bytes: fixture("invoice.pdf") },
    ]);
    expect(result.info.pageCount).toBe(1 + 2 + 1);
    expect(result.history.undoLabel).toBe("Add 2 files");
    const hits = engine.search("northwind").hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.page === 3)).toBe(true);
    engine.undo();
    expect(engine.pageCount).toBe(1);
  });

  it("asks for the password of an encrypted file and leaves the document as it was", () => {
    const engine = open(markedPdf(2));
    const encrypted = fixture("encrypted-aes256.pdf");
    expect(() => engine.insertPdfs(2, [{ bytes: markedPdf(1) }, { bytes: encrypted }])).toThrow(
      PasswordRequiredError,
    );
    expect(order(engine)).toEqual([0, 1]);
    expect(engine.history().canUndo).toBe(false);
    engine.insertPdfs(2, [{ bytes: encrypted, password: "open-sesame" }]);
    expect(engine.pageCount).toBe(3);
  });

  it("rejects pages missing from the source", () => {
    const engine = open(markedPdf(2));
    expect(() => engine.insertPdfs(0, [{ bytes: markedPdf(2), pages: [2] }])).toThrow(
      /doesn't exist/,
    );
    expect(order(engine)).toEqual([0, 1]);
  });
});

describe("extractPages and splitPages", () => {
  it("extracts pages in the order given, without changing the document", () => {
    const engine = open(markedPdf(5));
    engine.rotatePages([3], 90);
    const extracted = reopen(engine.extractPages([3, 0]));
    expect(order(extracted)).toEqual([3, 0]);
    expect(extracted.info().pages[0]).toEqual({ width: 400, height: 300 });
    expect(engine.pageCount).toBe(5);
    expect(engine.history().undoLabel).toBe("Rotate 1 page");
  });

  it("splits into one file per group", () => {
    const engine = open(markedPdf(5));
    const parts = engine.splitPages([[0, 1], [2], [3, 4]]).map((b) => order(reopen(b)));
    expect(parts).toEqual([[0, 1], [2], [3, 4]]);
    expect(() => engine.splitPages([])).toThrow();
    expect(() => engine.extractPages([5])).toThrow(/doesn't exist/);
  });
});

describe("history", () => {
  it("clears redo after a new edit and resets when a file is opened", () => {
    const engine = open(markedPdf(3));
    engine.deletePages([0]);
    engine.rotatePages([0], 90);
    engine.undo();
    expect(engine.history().redoLabel).toBe("Rotate 1 page");
    engine.insertBlankPages(0);
    expect(engine.history().canRedo).toBe(false);
    expect(engine.undo()?.info.pageCount).toBe(2);
    expect(engine.undo()?.info.pageCount).toBe(3);
    expect(engine.undo()).toBeNull();
    engine.redo();
    engine.open(markedPdf(1));
    expect(engine.history()).toEqual({
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
    });
  });

  it("undoing everything restores the original page order after a long sequence", () => {
    const engine = open(markedPdf(8));
    engine.movePages([0, 1], 4);
    engine.deletePages([2, 5]);
    engine.insertBlankPages(3, 2);
    engine.insertPdfs(0, [{ bytes: markedPdf(1, 300, 400, 20) }]);
    engine.rotatePages([0, 1, 2], 180);
    engine.movePages([7], 0);
    while (engine.history().canUndo) engine.undo();
    expect(order(engine)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    while (engine.history().canRedo) engine.redo();
    const redone = order(engine);
    // The inserted page (mark 20) is in the redone order, moved to position 1 by the last move.
    expect(redone[1]).toBe(20);
    while (engine.history().canUndo) engine.undo();
    while (engine.history().canRedo) engine.redo();
    expect(order(engine)).toEqual(redone);
  });
});

describe("page tools on real files", () => {
  it("keep the original bytes when saving a signed file incrementally", () => {
    const original = fixture("signed.pdf");
    const engine = open(original.slice());
    engine.insertBlankPages(engine.pageCount);
    engine.rotatePages([0], 90);
    const saved = engine.save();
    expect(saved.slice(0, original.length)).toEqual(original);
    expect(reopen(saved).pageCount).toBe(engine.pageCount);
  });

  it("move and delete pages in a large nested page tree", () => {
    const engine = open(fixture("report-500-pages.pdf"));
    const sizes = engine.info().pages;
    engine.movePages([499], 0);
    engine.deletePages([250, 251]);
    const info = engine.info();
    expect(info.pageCount).toBe(498);
    expect(info.pages[0]).toEqual(sizes[499]);
    const saved = reopen(engine.save());
    expect(saved.pageCount).toBe(498);
    expect(saved.renderPage(0, 0.2).width).toBeGreaterThan(0);
  });

  it("work on an encrypted file and keep it encrypted", () => {
    const engine = open(fixture("encrypted-aes256.pdf"), "open-sesame");
    engine.insertBlankPages(1);
    const saved = engine.save();
    const check = new PdfEngine();
    expect(check.open(saved)).toEqual({ needsPassword: true });
    expect(check.authenticate("open-sesame")?.pageCount).toBe(2);
  });
});
