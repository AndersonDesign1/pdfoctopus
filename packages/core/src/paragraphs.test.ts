// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Paragraphs (Phase 6, step 2): finding them on the fixtures (and not merging headings, table
// cells or columns into them), and editing one: the new text flows over the paragraph's lines
// in its font, from the same left edge, on the same baselines, justified when it was; nothing
// outside the paragraph changes (text or pixels); the file saves incrementally; undo puts the
// exact bytes back; text that no longer fits is flagged and can still be applied.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { PdfEngine } from "./engine";
import { joinLines, type ParagraphInfo, paragraphEditLooksRight } from "./paragraphs";
import type { TextLineInfo } from "./textEdit";
import { standardFontInfo } from "./textFonts";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const fixture = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));

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

/** The paragraph whose text starts with `start`. */
function paragraph(engine: PdfEngine, start: string, page = 0): ParagraphInfo {
  const found = engine.listTextLines(page).paragraphs.find((p) => p.text.startsWith(start));
  if (!found) throw new Error(`No paragraph starting "${start}"`);
  return found;
}

const linesOf = (engine: PdfEngine, page = 0) => engine.listTextLines(page).lines;
const key = (l: TextLineInfo) => `${l.text}|${l.rect.map((v) => v.toFixed(2)).join(",")}`;

/** The page's decoded content streams, joined. */
function contentBytes(bytes: Uint8Array, page = 0): string {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    const contents = pdf.findPage(page).get("Contents");
    const streams = contents.isArray()
      ? Array.from({ length: contents.length }, (_, i) => contents.get(i))
      : [contents];
    return streams.map((s) => s.readStream().asString()).join("\n");
  } finally {
    doc.destroy();
  }
}

interface Render {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

/** How many pixels differ between two renders, and how many of those are outside a box. */
function changedOutside(a: Render, b: Render, box: readonly number[]) {
  let changed = 0;
  let outside = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (
        a.pixels[i] === b.pixels[i] &&
        a.pixels[i + 1] === b.pixels[i + 1] &&
        a.pixels[i + 2] === b.pixels[i + 2]
      ) {
        continue;
      }
      changed++;
      if (
        x + 1 < (box[0] as number) ||
        x > (box[2] as number) ||
        y + 1 < (box[1] as number) ||
        y > (box[3] as number)
      ) {
        outside++;
      }
    }
  }
  return { changed, outside };
}

const grow = (r: readonly number[], m: number, down = 0) => [
  (r[0] as number) - m,
  (r[1] as number) - m,
  (r[2] as number) + m,
  (r[3] as number) + m + down,
];

const same = (a: Render, b: Render) => Buffer.from(a.pixels).equals(Buffer.from(b.pixels));

// -------------------------------------------------------------------------------------------
// Finding paragraphs

describe("finding paragraphs", () => {
  it("finds the body paragraphs of the LibreOffice contract, not its headings", () => {
    const engine = open(fixture("generated/contract-libreoffice.pdf"));
    const { lines, paragraphs } = engine.listTextLines(0);
    expect(paragraphs).toHaveLength(5);
    const services = paragraph(engine, "The Provider will deliver");
    expect(services).toMatchObject({ align: "justify", editable: true, reason: null });
    expect(services.lines).toHaveLength(3);
    const box = [72.1, 277.9, 526.3, 329.0];
    for (let i = 0; i < 4; i++) expect(services.rect[i]).toBeCloseTo(box[i] as number, 0);
    // A list item with a hanging second line is one paragraph; the items before it aren't.
    const late = paragraph(engine, "3. Late payments");
    expect(late.lines.map((id) => lines[id]?.text.trim())).toEqual([
      expect.stringMatching(/^3\. Late payments/),
      "whichever is lower.",
    ]);
    expect(paragraphs.some((p) => p.text.startsWith("1. The Client"))).toBe(false);
    // Headings belong to no paragraph.
    const inParagraph = new Set(paragraphs.flatMap((p) => p.lines));
    for (const heading of ["SERVICES AGREEMENT", "1. Services", "2. Term", "4. Confidentiality"]) {
      const line = lines.find((l) => l.text.trim() === heading);
      expect(line, heading).toBeDefined();
      expect(inParagraph.has((line as TextLineInfo).id), heading).toBe(false);
    }
    // The opening paragraph has a bold name in it: found, but only editable line by line.
    const opening = paragraph(engine, "This Services Agreement");
    expect(opening.lines).toHaveLength(4);
    expect(opening.editable).toBe(false);
    expect(opening.reason).toMatch(/more than one font/);
    expect(lines.filter((l) => opening.lines.includes(l.id)).every((l) => l.editable)).toBe(true);
  });

  it("finds the same paragraphs in the Chromium contract, without the page number", () => {
    const engine = open(fixture("generated/contract-chromium.pdf"));
    const { lines, paragraphs } = engine.listTextLines(0);
    expect(paragraphs).toHaveLength(6);
    expect(paragraph(engine, "The Provider will deliver").lines).toHaveLength(3);
    expect(paragraph(engine, "Each Party will keep").lines).toHaveLength(4);
    const number = lines.find((l) => l.text.trim() === "1") as TextLineInfo;
    expect(paragraphs.some((p) => p.lines.includes(number.id))).toBe(false);
    expect(paragraphs.every((p) => p.align === "justify")).toBe(true);
  });

  it("keeps table cells and headers out of paragraphs on the invoice", () => {
    const engine = open(fixture("generated/invoice.pdf"));
    const { lines, paragraphs } = engine.listTextLines(0);
    const inParagraph = new Set(paragraphs.flatMap((p) => p.lines));
    for (const cell of [
      "Description",
      "A4 copy paper, 80 gsm, box of 5 reams",
      "A3 recycled paper, 100 gsm, ream",
      "Delivery (zone B)",
      "$980.00",
      "INVOICE",
      "Northwind Paper Co.",
    ]) {
      const line = lines.find((l) => l.text === cell) as TextLineInfo;
      expect(line, cell).toBeDefined();
      expect(inParagraph.has(line.id), cell).toBe(false);
    }
    // The block of dates on the right is lined up on the right.
    expect(paragraph(engine, "Date: 3 November 2026").align).toBe("right");
  });

  it("finds TeX paragraphs by their indented first lines, one column at a time", () => {
    const engine = open(fixture("third-party/py-pdf/026-latex-multicolumn_multicolumn.pdf"));
    const { lines, paragraphs } = engine.listTextLines(0);
    expect(paragraphs.length).toBeGreaterThanOrEqual(7);
    const lorem = paragraph(engine, "Lorem ipsum dolor sit amet");
    expect(lorem.lines).toHaveLength(18);
    expect(lorem.align).toBe("justify");
    // A word broken at the end of a line is joined up.
    expect(lorem.text).toContain("consectetuer adipiscing elit.");
    expect(paragraph(engine, "Nam dui ligula").lines).toHaveLength(11);
    // No paragraph has lines from both columns, or the heading.
    for (const p of paragraphs) {
      const lefts = p.lines.map((id) => (lines[id] as TextLineInfo).rect[0]);
      expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThan(15);
    }
    const abstract = lines.find((l) => l.text.trim() === "Abstract") as TextLineInfo;
    expect(paragraphs.some((p) => p.lines.includes(abstract.id))).toBe(false);

    const tex = open(fixture("third-party/py-pdf/004-pdflatex-4-pages_pdflatex-4-pages.pdf"));
    const page = tex.listTextLines(0);
    expect(page.paragraphs).toHaveLength(1);
    expect(page.paragraphs[0]?.lines).toHaveLength(44);
    const folio = page.lines.find((l) => l.text.trim() === "1") as TextLineInfo;
    expect(page.paragraphs[0]?.lines.includes(folio.id)).toBe(false);
  });

  it("joins lines with spaces and mends words broken with a hyphen", () => {
    expect(joinLines(["adip-", "iscing elit ", " and so"])).toBe("adipiscing elit and so");
    expect(joinLines(["the year 2026-", "27"])).toBe("the year 2026- 27");
    expect(joinLines(["Non-", "Disclosure"])).toBe("Non- Disclosure");
  });
});

// -------------------------------------------------------------------------------------------
// Editing a paragraph on the fixtures

interface Geometry {
  left: number;
  right: number;
  baseline: number;
}

/** Each line of a paragraph: where its text starts and ends, and its baseline (bottom edge). */
function geometry(engine: PdfEngine, p: ParagraphInfo, page = 0): Geometry[] {
  const lines = linesOf(engine, page);
  return p.lines.map((id) => {
    const l = lines[id] as TextLineInfo;
    return { left: l.rect[0], right: l.rect[2], baseline: l.rect[3] };
  });
}

/** The lines inside a box, top to bottom. */
function linesIn(engine: PdfEngine, box: readonly number[], page = 0): TextLineInfo[] {
  return linesOf(engine, page)
    .filter(
      (l) =>
        l.rect[1] >= (box[1] as number) - 0.5 &&
        l.rect[3] <= (box[3] as number) + 0.5 &&
        l.rect[0] >= (box[0] as number) - 0.5 &&
        l.rect[2] <= (box[2] as number) + 0.5,
    )
    .sort((a, b) => a.rect[1] - b.rect[1]);
}

describe("editing a justified paragraph", () => {
  const name = "generated/contract-libreoffice.pdf";
  const start = "The Provider will deliver";

  it("flows shorter text over fewer lines, justified, and changes nothing else", () => {
    const original = fixture(name);
    const engine = open(original);
    const target = paragraph(engine, start);
    const old = geometry(engine, target);
    const before = linesOf(engine);
    const renderBefore = engine.renderPage(0, 1);
    const words = target.text.split(" ");
    const text = words.slice(0, Math.floor(words.length * 0.6)).join(" ");

    const check = engine.checkParagraphEdit(0, target.id, target.text, text);
    expect(check).toMatchObject({ oldLines: 3, lines: 2, overflow: false, fallback: null });
    expect(engine.history().canUndo).toBe(false);
    const result = engine.editParagraph(0, target.id, target.text, text);
    expect(result.history.undoLabel).toBe("Edit text");

    const after = linesOf(engine);
    const inBox = linesIn(engine, target.rect);
    expect(inBox.map((l) => l.text.trim()).join(" ")).toBe(text);
    expect(inBox).toHaveLength(2);
    // Same left edge and baselines; the first line justified to the paragraph's right edge.
    expect(inBox[0]?.rect[0]).toBeCloseTo(old[0]?.left as number, 1);
    expect(inBox[1]?.rect[0]).toBeCloseTo(old[1]?.left as number, 1);
    expect(inBox[0]?.rect[3]).toBeCloseTo(old[0]?.baseline as number, 1);
    expect(inBox[1]?.rect[3]).toBeCloseTo(old[1]?.baseline as number, 1);
    // The old lines' right edges include a trailing space; the new text ends at the last letter.
    expect(Math.abs((inBox[0]?.rect[2] as number) - 522.3)).toBeLessThan(0.6);
    expect(inBox[1]?.rect[2]).toBeLessThan(400);
    // Every line outside the paragraph: same text, same place.
    const outside = (lines: TextLineInfo[], skip: Set<number>) =>
      lines
        .filter((l) => !skip.has(l.id))
        .map(key)
        .sort();
    expect(outside(after, new Set(inBox.map((l) => l.id)))).toEqual(
      outside(before, new Set(target.lines)),
    );
    // Pixels change only inside the paragraph's box.
    const diff = changedOutside(renderBefore, engine.renderPage(0, 1), grow(target.rect, 2));
    expect(diff.changed).toBeGreaterThan(500);
    expect(diff.outside).toBe(0);

    // Saved after the original bytes; reopens cleanly with the new text.
    const saved = engine.save();
    expect(Buffer.from(saved.subarray(0, original.length)).equals(Buffer.from(original))).toBe(
      true,
    );
    const doc = mupdf.Document.openDocument(saved, "application/pdf");
    expect(doc.asPDF()?.wasRepaired()).toBe(false);
    doc.destroy();
    const reopened = open(saved);
    expect(paragraph(reopened, start).text).toBe(text);

    // Undo: the original content, byte for byte, and the same render.
    engine.undo();
    expect(contentBytes(engine.save())).toBe(contentBytes(original));
    expect(same(engine.renderPage(0, 1), renderBefore)).toBe(true);
    expect(linesOf(engine).map(key)).toEqual(before.map(key));
  });

  it("flows longer text into the room below, keeping the spacing", () => {
    const original = fixture(name);
    const engine = open(original);
    const target = paragraph(engine, start);
    const old = geometry(engine, target);
    const spacing = (old[2]?.baseline as number) - (old[1]?.baseline as number);
    const renderBefore = engine.renderPage(0, 1);
    // About a line more: still fits above the next heading.
    const text = `${target.text} The Provider will also keep the Client informed of progress every month.`;
    const check = engine.checkParagraphEdit(0, target.id, target.text, text);
    expect(check).toMatchObject({ oldLines: 3, lines: 4, fit: 4, overflow: false });
    engine.editParagraph(0, target.id, target.text, text);

    const box = grow(target.rect, 0.5, spacing);
    const inBox = linesIn(engine, box);
    expect(inBox).toHaveLength(4);
    expect(inBox.map((l) => l.text.trim()).join(" ")).toBe(text);
    for (let i = 0; i < 4; i++) {
      expect(inBox[i]?.rect[0]).toBeCloseTo(old[0]?.left as number, 1);
      expect(inBox[i]?.rect[3]).toBeCloseTo((old[0]?.baseline as number) + i * spacing, 1);
    }
    // Justified: every line but the last ends at the same place.
    for (let i = 0; i < 3; i++)
      expect(Math.abs((inBox[i]?.rect[2] as number) - 522.3)).toBeLessThan(0.6);
    const diff = changedOutside(renderBefore, engine.renderPage(0, 1), grow(box, 2));
    expect(diff.outside).toBe(0);
    expect(paragraph(engine, start).lines).toHaveLength(4);
    engine.undo();
    expect(contentBytes(engine.save())).toBe(contentBytes(original));
  });

  it("does the same in the Chromium contract, whose letters are placed one by one", () => {
    const original = fixture("generated/contract-chromium.pdf");
    const engine = open(original);
    const target = paragraph(engine, "Each Party will keep");
    const old = geometry(engine, target);
    const renderBefore = engine.renderPage(0, 1);
    const text = target.text.replace(
      "secret and use it only to",
      "confidential and use it only to",
    );
    engine.editParagraph(0, target.id, target.text, text);
    const inBox = linesIn(engine, grow(target.rect, 0.5));
    expect(inBox.map((l) => l.text.trim()).join(" ")).toBe(text);
    expect(inBox.length).toBe(4);
    for (let i = 0; i < inBox.length; i++) {
      expect(inBox[i]?.rect[0]).toBeCloseTo(old[i]?.left as number, 1);
      expect(inBox[i]?.rect[3]).toBeCloseTo(old[i]?.baseline as number, 1);
    }
    for (let i = 0; i < inBox.length - 1; i++) {
      expect(Math.abs((inBox[i]?.rect[2] as number) - 534)).toBeLessThan(0.6);
    }
    expect(
      changedOutside(renderBefore, engine.renderPage(0, 1), grow(target.rect, 2)).outside,
    ).toBe(0);
    engine.undo();
    expect(contentBytes(engine.save())).toBe(contentBytes(original));
  });
});

describe("editing a left-aligned paragraph", () => {
  const name = "generated/report-500-pages.pdf";
  const start = "This quarterly operations report";

  it("keeps it ragged, from the same left edge, and only its box changes", () => {
    const original = fixture(name);
    const engine = open(original);
    const target = paragraph(engine, start);
    expect(target.align).toBe("left");
    const old = geometry(engine, target);
    const renderBefore = engine.renderPage(0, 1);
    // Its own words: the file's font has only the letters it uses.
    const text = target.text.split(" ").slice(0, 9).join(" ");
    const check = engine.checkParagraphEdit(0, target.id, target.text, text);
    expect(check, JSON.stringify(check)).toMatchObject({
      lines: 1,
      overflow: false,
      fallback: null,
    });
    engine.editParagraph(0, target.id, target.text, text);
    const inBox = linesIn(engine, grow(target.rect, 0.5));
    expect(inBox).toHaveLength(1);
    expect(inBox[0]?.text.trim()).toBe(text);
    expect(inBox[0]?.rect[0]).toBeCloseTo(old[0]?.left as number, 1);
    expect(inBox[0]?.rect[3]).toBeCloseTo(old[0]?.baseline as number, 1);
    const diff = changedOutside(renderBefore, engine.renderPage(0, 1), grow(target.rect, 2));
    expect(diff.outside).toBe(0);
    const saved = engine.save();
    expect(Buffer.from(saved.subarray(0, original.length)).equals(Buffer.from(original))).toBe(
      true,
    );
    engine.undo();
    expect(contentBytes(engine.save())).toBe(contentBytes(original));
    expect(same(engine.renderPage(0, 1), renderBefore)).toBe(true);
  });

  it("keeps line breaks typed, and leaves the same text where it was", () => {
    const engine = open(fixture(name));
    const target = paragraph(engine, start);
    const before = linesOf(engine).map(key);
    // The same text again changes nothing.
    engine.editParagraph(0, target.id, target.text, target.text);
    expect(engine.history().canUndo).toBe(false);
    engine.editParagraph(0, target.id, target.text, "First line.\nSecond line.\n\nFourth line.");
    const inBox = linesIn(engine, grow(target.rect, 0.5));
    expect(inBox.map((l) => l.text.trim())).toEqual([
      "First line.",
      "Second line.",
      "Fourth line.",
    ]);
    inBox.forEach((l, i) => {
      expect(l.rect[0]).toBeCloseTo(target.rect[0], 1);
      // Each on the paragraph's next baseline: the empty line is left blank.
      if (i > 0) expect(l.rect[3]).toBeGreaterThan((inBox[i - 1] as TextLineInfo).rect[3] + 5);
    });
    engine.undo();
    expect(linesOf(engine).map(key)).toEqual(before);
  });
});

describe("text that no longer fits", () => {
  it("is flagged before it's applied, and can be applied anyway", () => {
    const original = fixture("generated/contract-libreoffice.pdf");
    const engine = open(original);
    const target = paragraph(engine, "The Provider will deliver");
    const heading = linesOf(engine).find((l) => l.text.trim() === "2. Term") as TextLineInfo;
    const text = `${target.text} ${target.text}`;
    const check = engine.checkParagraphEdit(0, target.id, target.text, text);
    expect(check.overflow).toBe(true);
    expect(check.fit).toBe(4);
    expect(check.lines).toBeGreaterThan(check.fit);
    // Applied anyway: the paragraph runs on over the heading below; nothing else moved, which
    // the engine checked glyph by glyph before keeping the edit.
    const renderBefore = engine.renderPage(0, 1);
    engine.editParagraph(0, target.id, target.text, text);
    const spacing = 19.2;
    const below = [
      target.rect[0],
      target.rect[1],
      target.rect[2],
      target.rect[3] + (check.lines - 3) * spacing,
    ];
    expect(changedOutside(renderBefore, engine.renderPage(0, 1), grow(below, 2)).outside).toBe(0);
    expect(heading.rect[1]).toBeLessThan(below[3] as number);
    engine.undo();
    expect(contentBytes(engine.save())).toBe(contentBytes(original));
  });

  it("is refused when it would run off the bottom of the page", () => {
    const engine = open(fixture("generated/contract-libreoffice.pdf"));
    const target = paragraph(engine, "Each Party will keep");
    const text = Array.from({ length: 12 }, () => target.text).join(" ");
    expect(() => engine.checkParagraphEdit(0, target.id, target.text, text)).toThrow(
      /bottom of the page/,
    );
  });
});

describe("what can't be edited as a paragraph", () => {
  it("refuses a paragraph with a bold word, but its lines can still be edited", () => {
    const engine = open(fixture("generated/contract-libreoffice.pdf"));
    const opening = paragraph(engine, "This Services Agreement");
    expect(() => engine.editParagraph(0, opening.id, opening.text, "Short.")).toThrow(
      /more than one font/,
    );
    const line = linesOf(engine).find((l) => l.text.startsWith("Client are each")) as TextLineInfo;
    engine.editTextLine(0, line.id, line.text, "Client are each a Party.");
    expect(linesOf(engine).some((l) => l.text === "Client are each a Party.")).toBe(true);
  });

  it("catches a stale paragraph, bad characters and text that's too long", () => {
    const engine = open(fixture("generated/contract-libreoffice.pdf"));
    const target = paragraph(engine, "The Provider will deliver");
    expect(() => engine.editParagraph(0, target.id, "Something else", "x")).toThrow(/has changed/);
    expect(() => engine.checkParagraphEdit(0, target.id, target.text, "東京")).toThrow(
      /Chinese, Japanese and Korean/,
    );
    expect(() => engine.checkParagraphEdit(0, target.id, target.text, "a\u0007b")).toThrow(
      /can't be written/,
    );
    expect(() => engine.checkParagraphEdit(0, target.id, target.text, "Жук")).toThrow(
      /can't be written in this paragraph/,
    );
    expect(() =>
      engine.checkParagraphEdit(0, target.id, target.text, "word ".repeat(2001)),
    ).toThrow(/too long/);
  });

  it("refuses an edit whose result would move anything else", () => {
    const engine = open(fixture("generated/contract-libreoffice.pdf"));
    // biome-ignore lint/suspicious/noExplicitAny: reaching the cached analysis for the check.
    const analysis = (engine as any).lineAnalysis(0);
    const target = paragraph(engine, "The Provider will deliver");
    const plan = {
      check: { overflow: false, oldLines: 3 },
      newLines: [],
      region: [0, 0, 0, 0],
      // biome-ignore lint/suspicious/noExplicitAny: only the fields the check reads.
    } as any;
    const glyphs = analysis.glyphs as { x: number; y: number }[];
    expect(paragraphEditLooksRight(analysis, target.id, plan, glyphs as never, analysis.raw)).toBe(
      true,
    );
    // One glyph elsewhere nudged a little: refused.
    const outside = glyphs.findIndex((g: { x: number; y: number }) => g.y < target.rect[1] - 20);
    const moved = glyphs.map((g, i) => (i === outside ? { ...g, x: g.x + 0.3 } : g));
    expect(paragraphEditLooksRight(analysis, target.id, plan, moved as never, analysis.raw)).toBe(
      false,
    );
  });
});

// -------------------------------------------------------------------------------------------
// Made-up pages, for alignment and for lines added under a paragraph

/** A 400 × 400 page with Helvetica (F1). */
function makePdf(content: string): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  try {
    const helv = pdf.newDictionary();
    helv.put("Type", pdf.newName("Font"));
    helv.put("Subtype", pdf.newName("Type1"));
    helv.put("BaseFont", pdf.newName("Helvetica"));
    helv.put("Encoding", pdf.newName("WinAnsiEncoding"));
    const fonts = pdf.newDictionary();
    fonts.put("F1", pdf.addObject(helv));
    const resources = pdf.newDictionary();
    resources.put("Font", fonts);
    pdf.insertPage(-1, pdf.addPage([0, 0, 400, 400], 0, resources, content));
    return pdf.saveToBuffer("").asUint8Array().slice();
  } finally {
    pdf.destroy();
  }
}

describe("made-up paragraphs", () => {
  it("draws lines added under the last one and puts the text position back", () => {
    // The last line's operator also draws "Far" well to the right, and "More" follows it with
    // no move of its own: both must stay exactly where they were.
    const engine = open(
      makePdf(
        "BT /F1 10 Tf 12 TL 40 360 Td (The first line of a short paragraph) Tj T* " +
          "(and its second line, a little shorter) Tj T* " +
          "[(and the end.) -16000 (Far)] TJ (More) Tj ET",
      ),
    );
    const target = paragraph(engine, "The first line");
    expect(target.lines).toHaveLength(3);
    const far = linesOf(engine).find((l) => l.text.includes("Far")) as TextLineInfo;
    expect(far).toBeDefined();
    const text = `${target.text} It now runs on for a good deal longer than it did before, over more lines.`;
    const check = engine.checkParagraphEdit(0, target.id, target.text, text);
    expect(check.lines).toBeGreaterThan(3);
    expect(check.overflow).toBe(false);
    engine.editParagraph(0, target.id, target.text, text);
    const after = linesOf(engine);
    // MuPDF may now read "Far" and "More" as two lines (text is drawn between them), but
    // together they cover exactly the same box.
    const parts = after.filter((l) => l.rect[0] > 200);
    expect(parts.map((l) => l.text.trim()).join("")).toBe("FarMore");
    const box = [
      Math.min(...parts.map((l) => l.rect[0])),
      Math.min(...parts.map((l) => l.rect[1])),
      Math.max(...parts.map((l) => l.rect[2])),
      Math.max(...parts.map((l) => l.rect[3])),
    ];
    for (let i = 0; i < 4; i++) expect(box[i]).toBeCloseTo(far.rect[i] as number, 3);
    const inBox = linesIn(engine, [30, 0, 260, 400]);
    expect(inBox.map((l) => l.text.trim()).join(" ")).toBe(text);
    // Evenly spaced, 12 points apart, from the same left edge.
    inBox.forEach((l, i) => {
      expect(l.rect[0]).toBeCloseTo(40, 1);
      expect(l.rect[3] - (inBox[0] as TextLineInfo).rect[3]).toBeCloseTo(12 * i, 1);
    });
  });

  it("lines new text up on the right or the centre when the paragraph was", () => {
    const helvetica = standardFontInfo("Helvetica");
    const width = (t: string) =>
      [...t].reduce((w, c) => w + helvetica.width(helvetica.encode(c) ?? 32) / 100, 0);
    const placed = (lines: string[], x: (w: number) => number) =>
      lines
        .map((t, i) => `1 0 0 1 ${x(width(t)).toFixed(3)} ${360 - 12 * i} Tm (${t}) Tj`)
        .join(" ");
    const right = open(
      makePdf(
        `BT /F1 10 Tf ${placed(["Right aligned text that", "lines up on the right", "side here."], (w) => 360 - w)} ET`,
      ),
    );
    const r = paragraph(right, "Right aligned");
    expect(r.align).toBe("right");
    const edge = Math.max(...r.lines.map((id) => (linesOf(right)[id] as TextLineInfo).rect[2]));
    right.editParagraph(0, r.id, r.text, "Now a different text, still lined up on the right side.");
    for (const l of linesIn(right, grow(r.rect, 60))) {
      expect(Math.abs(l.rect[2] - edge)).toBeLessThan(0.6);
    }

    const centre = open(
      makePdf(
        `BT /F1 10 Tf ${placed(["A centred heading line", "and its second one"], (w) => 200 - w / 2)} ET`,
      ),
    );
    const c = paragraph(centre, "A centred");
    expect(c.align).toBe("centre");
    const mid = (l: TextLineInfo) => (l.rect[0] + l.rect[2]) / 2;
    const middle = mid(linesOf(centre)[c.lines[0] as number] as TextLineInfo);
    centre.editParagraph(0, c.id, c.text, "Centred text\nstays centred");
    const done = linesIn(centre, [0, 0, 400, 400]);
    expect(done.map((l) => l.text.trim())).toEqual(["Centred text", "stays centred"]);
    for (const l of done) expect(Math.abs(mid(l) - middle)).toBeLessThan(1.5);
  });
});
