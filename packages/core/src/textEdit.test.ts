// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Editing a line of text in place (Phase 6, step 1). On the fixtures: the new text is on the
// page and the old isn't, every other line is where it was, only pixels around the line change,
// saving appends to the file, and undo puts the original content back byte for byte. On small
// made-up pages: each kind of text that is refused, and the operators that are rewritten.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { PdfEngine, type TextEditResult } from "./engine";
import { contentLines, type TextLineInfo, uprightRectangle } from "./textEdit";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const fixture = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));

const opened: PdfEngine[] = [];
afterEach(() => {
  for (const engine of opened.splice(0)) engine.close();
});

function open(bytes: Uint8Array, password?: string): PdfEngine {
  const engine = new PdfEngine();
  opened.push(engine);
  const result = engine.open(bytes);
  if (result.needsPassword) engine.authenticate(password ?? "");
  return engine;
}

function lineWith(engine: PdfEngine, text: string, page = 0): TextLineInfo {
  const line = engine.listTextLines(page).lines.find((l) => l.text === text);
  if (!line) throw new Error(`No line "${text}"`);
  return line;
}

function edit(engine: PdfEngine, from: string, to: string, page = 0): TextEditResult {
  const line = lineWith(engine, from, page);
  return engine.editTextLine(page, line.id, line.text, to);
}

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

/** Pixels that differ between two renders, outside a box (in points at scale 1). */
function changedOutside(
  a: { width: number; height: number; pixels: Uint8ClampedArray },
  b: { width: number; height: number; pixels: Uint8ClampedArray },
  box: readonly number[],
): { changed: number; outside: number } {
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

const union = (a: readonly number[], b: readonly number[], margin: number) => [
  Math.min(a[0] as number, b[0] as number) - margin,
  Math.min(a[1] as number, b[1] as number) - margin,
  Math.max(a[2] as number, b[2] as number) + margin,
  Math.max(a[3] as number, b[3] as number) + margin,
];

describe("editing a line on the invoice", () => {
  it("changes only that line, saves incrementally, and undo restores the exact content", () => {
    const original = fixture("generated/invoice.pdf");
    const engine = open(original);
    const before = engine.listTextLines(0).lines;
    expect(before.length).toBeGreaterThan(50);
    expect(before.every((l) => l.editable)).toBe(true);
    const target = lineWith(engine, "Northwind Paper Co.");
    expect(target).toMatchObject({ rotation: 0, bold: true, font: "DejaVu Sans Bold" });
    const renderBefore = engine.renderPage(0, 1);

    const result = edit(engine, "Northwind Paper Co.", "Northwind Paper Ltd.");
    expect(result.history.undoLabel).toBe("Edit text");
    expect(result.check).toMatchObject({ fallback: null, missing: [], tooWide: false });

    const after = engine.listTextLines(0).lines;
    const edited = after.find((l) => l.text === "Northwind Paper Ltd.");
    expect(edited).toBeDefined();
    expect(after.some((l) => l.text === "Northwind Paper Co.")).toBe(false);
    // Every other line: same text, same place.
    const others = (lines: TextLineInfo[], skip: string) =>
      lines
        .filter((l) => l.text !== skip)
        .map(key)
        .sort();
    expect(others(after, "Northwind Paper Ltd.")).toEqual(others(before, "Northwind Paper Co."));
    // Same start, same baseline.
    expect(edited?.rect[0]).toBeCloseTo(target.rect[0], 2);
    expect(edited?.rect[3]).toBeCloseTo(target.rect[3], 2);

    // Only pixels around the line change.
    const renderAfter = engine.renderPage(0, 1);
    const diff = changedOutside(
      renderBefore,
      renderAfter,
      union(target.rect, edited?.rect ?? target.rect, 2),
    );
    expect(diff.changed).toBeGreaterThan(50);
    expect(diff.outside).toBe(0);

    // Saved as an update after the original bytes, and it reopens cleanly with the new text.
    const saved = engine.save();
    expect(saved.length).toBeGreaterThan(original.length);
    expect(Buffer.from(saved.subarray(0, original.length)).equals(Buffer.from(original))).toBe(
      true,
    );
    const reopened = open(saved);
    const doc = mupdf.Document.openDocument(saved, "application/pdf");
    expect(doc.asPDF()?.wasRepaired()).toBe(false);
    doc.destroy();
    expect(reopened.listTextLines(0).lines.map((l) => l.text)).toContain("Northwind Paper Ltd.");

    // Undo: the page's content is the original, byte for byte.
    engine.undo();
    expect(engine.listTextLines(0).lines.map(key)).toEqual(before.map(key));
    const undone = engine.save();
    expect(contentBytes(undone)).toBe(contentBytes(original));
    const renderUndone = engine.renderPage(0, 1);
    expect(Buffer.from(renderUndone.pixels).equals(Buffer.from(renderBefore.pixels))).toBe(true);
    // Redo brings the edit back.
    engine.redo();
    expect(engine.listTextLines(0).lines.map((l) => l.text)).toContain("Northwind Paper Ltd.");
  });

  it("falls back to a standard font when the embedded subset lacks a character, and says so", () => {
    const engine = open(fixture("generated/invoice.pdf"));
    const line = lineWith(engine, "7 Sample Road");
    const check = engine.checkTextEdit(0, line.id, line.text, "7 Ünique Röad");
    expect(check.fallback).toBe("Helvetica");
    expect(check.missing).toEqual(expect.arrayContaining(["Ü", "ö"]));
    // Checking changes nothing.
    expect(engine.history().canUndo).toBe(false);

    const result = engine.editTextLine(0, line.id, line.text, "7 Ünique Röad");
    expect(result.check.fallback).toBe("Helvetica");
    expect(engine.listTextLines(0).lines.map((l) => l.text)).toContain("7 Ünique Röad");
    const saved = engine.save();
    const doc = mupdf.Document.openDocument(saved, "application/pdf");
    try {
      const fonts = (doc.asPDF() as mupdf.PDFDocument).findPage(0).get("Resources").get("Font");
      const names: string[] = [];
      fonts.forEach((f) => {
        names.push(f.get("BaseFont").asName());
      });
      expect(names).toContain("Helvetica");
    } finally {
      doc.destroy();
    }
    // Text the subset has stays in the embedded font.
    const plain = lineWith(engine, "Riverton 98765");
    expect(engine.checkTextEdit(0, plain.id, plain.text, "Riverton 56789").fallback).toBeNull();
  });

  it("refuses characters no font here can write", () => {
    const engine = open(fixture("generated/invoice.pdf"));
    const line = lineWith(engine, "7 Sample Road");
    expect(() => engine.editTextLine(0, line.id, line.text, "Жук")).toThrow(/can't be written/);
    expect(() => engine.editTextLine(0, line.id, line.text, "two\nlines")).toThrow(/one line/);
    expect(() => engine.editTextLine(0, line.id, line.text, "東京")).toThrow(
      /no standard font for Chinese, Japanese or Korean/,
    );
    expect(() => engine.editTextLine(0, line.id, line.text, "שלום")).toThrow(
      /only be written in a line that already reads right to left/,
    );
    expect(() => engine.editTextLine(0, line.id, line.text, "a\u202eb")).toThrow(
      /direction of text/,
    );
    expect(engine.history().canUndo).toBe(false);
  });

  it("warns when the new text runs into the next column", () => {
    const engine = open(fixture("generated/invoice.pdf"));
    const line = lineWith(engine, "Description");
    const long = "Description of every item supplied this month in great detail";
    const check = engine.checkTextEdit(0, line.id, line.text, long);
    expect(check.tooWide).toBe(true);
    expect(check.width).toBeGreaterThan(check.room);
    expect(engine.checkTextEdit(0, line.id, line.text, "Item").tooWide).toBe(false);
  });

  it("catches a stale line list", () => {
    const engine = open(fixture("generated/invoice.pdf"));
    const line = lineWith(engine, "7 Sample Road");
    expect(() => engine.editTextLine(0, line.id, "Something else", "x")).toThrow(/has changed/);
    edit(engine, "7 Sample Road", "8 Sample Road");
    expect(() => engine.editTextLine(0, line.id, "7 Sample Road", "9 Sample Road")).toThrow(
      /has changed/,
    );
  });

  it("can empty a line", () => {
    const engine = open(fixture("generated/invoice.pdf"));
    edit(engine, "PO ref: PO-88213", "");
    expect(engine.listTextLines(0).lines.some((l) => l.text.includes("PO-88213"))).toBe(false);
  });
});

describe("editing other producers' files", () => {
  it.each([
    ["generated/contract-libreoffice.pdf", 0],
    ["generated/contract-chromium.pdf", 0],
    ["generated/contract-chromium.pdf", 1],
    ["third-party/py-pdf/001-trivial_minimal-document.pdf", 0],
    ["third-party/py-pdf/006-pdflatex-outline_pdflatex-outline.pdf", 0],
  ])("%s page %i: a body line changes and nothing else moves", (name, page) => {
    const original = fixture(name);
    const engine = open(original);
    const before = engine.listTextLines(page).lines;
    // The longest editable line, usually a line of body text.
    const target = before
      .filter((l) => l.editable)
      .sort((a, b) => b.text.length - a.text.length)[0] as TextLineInfo;
    expect(target).toBeDefined();
    const words = target.text.trim().split(/\s+/);
    // Shorter than the line, so it fits wherever the line is.
    const replacement = `${words.slice(0, -1).join(" ")}.`;
    const renderBefore = engine.renderPage(page, 1);
    engine.editTextLine(page, target.id, target.text, replacement);
    const after = engine.listTextLines(page).lines;
    const edited = after.find(
      (l) => l.text.replace(/\s+/g, "") === replacement.replace(/\s+/g, ""),
    );
    expect(edited, `"${replacement}" not found`).toBeDefined();
    const rest = (lines: TextLineInfo[], skip: TextLineInfo | undefined) =>
      lines
        .filter((l) => l !== skip)
        .map(key)
        .sort();
    expect(rest(after, edited)).toEqual(rest(before, target));
    const diff = changedOutside(
      renderBefore,
      engine.renderPage(page, 1),
      union(target.rect, edited?.rect ?? target.rect, 2),
    );
    expect(diff.outside).toBe(0);
    const saved = engine.save();
    expect(Buffer.from(saved.subarray(0, original.length)).equals(Buffer.from(original))).toBe(
      true,
    );
    engine.undo();
    expect(contentBytes(engine.save(), page)).toBe(contentBytes(original, page));
  });

  it("refuses vertical CJK text and scanned text layers; signed files need no special path", () => {
    // Horizontal CJK lines can be edited (scripts.test.ts); the vertical block can't.
    const cjk = open(fixture("generated/cjk-text.pdf")).listTextLines(0);
    const vertical = cjk.lines.filter((l) => l.rect[1] > 480);
    expect(vertical.length).toBeGreaterThan(50);
    expect(vertical.every((l) => !l.editable && /vertical writing/.test(l.reason ?? ""))).toBe(
      true,
    );

    const scan = open(
      fixture("third-party/internet-archive/scan-typed-business-letter-1902.pdf"),
    ).listTextLines(0);
    expect(scan.lines.length).toBeGreaterThan(0);
    expect(scan.lines.every((l) => !l.editable && /invisible/.test(l.reason ?? ""))).toBe(true);

    expect(open(fixture("generated/signed.pdf")).listTextLines(0).signed).toBe(true);
    expect(open(fixture("generated/invoice.pdf")).listTextLines(0).signed).toBe(false);
  });

  it("refuses files that don't allow changes until their permissions are unlocked", () => {
    const engine = open(fixture("generated/restricted-permissions.pdf"));
    const { lines } = engine.listTextLines(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => !l.editable && /doesn't allow changes/.test(l.reason ?? ""))).toBe(
      true,
    );
    const line = lines[0] as TextLineInfo;
    expect(() => engine.editTextLine(0, line.id, line.text, "x")).toThrow(/doesn't allow changes/);
    expect(engine.unlockPermissions("owner-secret")).not.toBeNull();
    expect(engine.listTextLines(0).lines.some((l) => l.editable)).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------
// Made-up pages, for each case on its own

interface PageSpec {
  content: string | string[];
  rotate?: 0 | 90 | 180 | 270;
}

/** A 400 × 400 page with Helvetica (F1), a Type 3 font (F3) and a form XObject with text (X1). */
function makePdf({ content, rotate = 0 }: PageSpec): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  try {
    const helv = pdf.newDictionary();
    helv.put("Type", pdf.newName("Font"));
    helv.put("Subtype", pdf.newName("Type1"));
    helv.put("BaseFont", pdf.newName("Helvetica"));
    helv.put("Encoding", pdf.newName("WinAnsiEncoding"));
    const fonts = pdf.newDictionary();
    fonts.put("F1", pdf.addObject(helv));

    // F2: a simple font that only has a space and the letters A to H (not embedded).
    const small = pdf.newDictionary();
    small.put("Type", pdf.newName("Font"));
    small.put("Subtype", pdf.newName("TrueType"));
    small.put("BaseFont", pdf.newName("SmallTestFont"));
    small.put("FirstChar", 32);
    small.put("LastChar", 72);
    const smallWidths = pdf.newArray();
    for (let code = 32; code <= 72; code++) smallWidths.push(code === 32 ? 250 : 600);
    small.put("Widths", smallWidths);
    const smallEncoding = pdf.newDictionary();
    const smallDiff = pdf.newArray();
    smallDiff.push(32);
    smallDiff.push(pdf.newName("space"));
    smallDiff.push(65);
    for (const name of ["A", "B", "C", "D", "E", "F", "G", "H"]) smallDiff.push(pdf.newName(name));
    smallEncoding.put("Differences", smallDiff);
    small.put("Encoding", smallEncoding);
    fonts.put("F2", pdf.addObject(small));

    const glyph = pdf.addStream("1000 0 0 0 750 750 d1 0 0 750 750 re f", pdf.newDictionary());
    const procs = pdf.newDictionary();
    procs.put("a", glyph);
    const t3 = pdf.newDictionary();
    t3.put("Type", pdf.newName("Font"));
    t3.put("Subtype", pdf.newName("Type3"));
    const bbox = pdf.newArray();
    for (const v of [0, 0, 750, 750]) bbox.push(v);
    t3.put("FontBBox", bbox);
    const fm = pdf.newArray();
    for (const v of [0.001, 0, 0, 0.001, 0, 0]) fm.push(v);
    t3.put("FontMatrix", fm);
    t3.put("CharProcs", procs);
    const enc = pdf.newDictionary();
    const diff = pdf.newArray();
    diff.push(97);
    diff.push(pdf.newName("a"));
    enc.put("Differences", diff);
    t3.put("Encoding", enc);
    t3.put("FirstChar", 97);
    t3.put("LastChar", 97);
    const widths = pdf.newArray();
    widths.push(1000);
    t3.put("Widths", widths);
    const tu = pdf.addStream(
      "/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <61> <0061> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
      pdf.newDictionary(),
    );
    t3.put("ToUnicode", tu);
    fonts.put("F3", pdf.addObject(t3));

    const formResources = pdf.newDictionary();
    formResources.put("Font", fonts);
    const formDict = pdf.newDictionary();
    formDict.put("Type", pdf.newName("XObject"));
    formDict.put("Subtype", pdf.newName("Form"));
    const fbox = pdf.newArray();
    for (const v of [0, 0, 400, 400]) fbox.push(v);
    formDict.put("BBox", fbox);
    formDict.put("Resources", formResources);
    const form = pdf.addStream("BT /F1 12 Tf 40 40 Td (Inside a form) Tj ET", formDict);
    const xobjects = pdf.newDictionary();
    xobjects.put("X1", form);

    const resources = pdf.newDictionary();
    resources.put("Font", fonts);
    resources.put("XObject", xobjects);
    const parts = Array.isArray(content) ? content : [content];
    const page = pdf.addPage([0, 0, 400, 400], rotate, resources, parts[0] as string);
    if (parts.length > 1) {
      const array = pdf.newArray();
      for (const part of parts) array.push(pdf.addStream(part, pdf.newDictionary()));
      page.put("Contents", array);
    }
    pdf.insertPage(-1, page);
    return pdf.saveToBuffer("").asUint8Array().slice();
  } finally {
    pdf.destroy();
  }
}

/** Why a line (found by how it starts: MuPDF leaves out clipped letters) can't be edited. */
function reasonFor(spec: PageSpec, start: string): string | null {
  const engine = open(makePdf(spec));
  const line = engine.listTextLines(0).lines.find((l) => l.text.startsWith(start));
  if (!line) throw new Error(`No line starting "${start}"`);
  return line.reason;
}

function expectSameRect(a: readonly number[] | undefined, b: readonly number[] | undefined) {
  expect(a).toHaveLength(4);
  for (let i = 0; i < 4; i++) expect(a?.[i]).toBeCloseTo(b?.[i] as number, 3);
}

describe("what can't be edited, and why", () => {
  it("refuses invisible, clipping, slanted, clipped, Type 3 and form XObject text", () => {
    expect(
      reasonFor({ content: "BT /F1 12 Tf 3 Tr 50 300 Td (Hidden words) Tj ET" }, "Hidden words"),
    ).toMatch(/invisible/);
    expect(
      reasonFor(
        { content: "BT /F1 12 Tf 7 Tr 50 300 Td (Clip words) Tj ET 0 0 400 400 re f" },
        "Clip words",
      ),
    ).toMatch(/clipping/);
    expect(
      reasonFor(
        { content: "BT /F1 12 Tf 1 0 0.4 1 50 300 Tm (Slanted words) Tj ET" },
        "Slanted words",
      ),
    ).toMatch(/slanted/);
    expect(
      reasonFor(
        { content: "BT /F1 12 Tf -1 0 0 1 300 300 Tm (Mirrored words) Tj ET" },
        "Mirrored words",
      ),
    ).toMatch(/mirrored/);
    expect(
      reasonFor(
        { content: "q 50 295 30 20 re W n BT /F1 12 Tf 50 300 Td (Clipped words) Tj ET Q" },
        "Cli",
      ),
    ).toMatch(/clipped/);
    expect(reasonFor({ content: "BT /F3 12 Tf 50 300 Td (aaa) Tj ET" }, "aaa")).toMatch(/Type 3/);
    expect(reasonFor({ content: "/X1 Do" }, "Inside a form")).toMatch(/form XObject/);
  });

  it("refuses text whose operator is split across content streams", () => {
    const spec = { content: ["BT /F1 12 Tf 50 300 Td (Split show)", "Tj ET"] };
    expect(reasonFor(spec, "Split show")).toMatch(/couldn't be/);
  });

  it("lists nothing editable on a page whose content can't be read, without throwing", () => {
    const engine = open(
      makePdf({ content: "BT /F1 12 Tf 50 300 Td (Fine) Tj ET 1 0 0 1 0 0 cm cm" }),
    );
    const { lines } = engine.listTextLines(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => !l.editable && /couldn't be read/.test(l.reason ?? ""))).toBe(true);
  });

  it("allows text clipped by a box around it, and a page-wide clip", () => {
    const engine = open(
      makePdf({ content: "q 0 0 400 400 re W n BT /F1 12 Tf 50 300 Td (Inside the clip) Tj ET Q" }),
    );
    expect(lineWith(engine, "Inside the clip").editable).toBe(true);
  });
});

describe("clipping shapes", () => {
  it("knows an upright rectangle from other shapes", () => {
    const square: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
    ];
    expect(uprightRectangle(square)).toBe(true);
    expect(uprightRectangle([...square, [0, 0]])).toBe(true);
    expect(uprightRectangle(square.slice(0, 3))).toBe(false);
    expect(
      uprightRectangle([
        [0, 0],
        [10, 2],
        [8, 12],
        [-2, 10],
      ]),
    ).toBe(false);
    expect(
      uprightRectangle([
        [0, 0],
        [10, 0],
        [0, 5],
        [10, 5],
      ]),
    ).toBe(false);
  });

  const triangle = (text: string) =>
    `q 0 0 m 400 0 l 400 400 l h W n BT /F1 12 Tf 250 100 Td (${text}) Tj ET Q`;
  const curve = (text: string) =>
    `q 200 0 m 400 0 400 200 400 200 c 400 400 200 400 200 400 c 0 400 0 200 0 200 c 0 0 200 0 200 0 c h W n BT /F1 12 Tf 150 200 Td (${text}) Tj ET Q`;

  it.each([
    ["a diagonal clip", triangle],
    ["a curved clip", curve],
  ])("under %s, allows the same length or shorter but refuses longer text", (_name, make) => {
    const engine = open(makePdf({ content: make("Clipped") }));
    const line = lineWith(engine, "Clipped");
    expect(line.editable).toBe(true);
    expect(() => engine.editTextLine(0, line.id, line.text, "Clipped and much longer")).toThrow(
      /can't be longer than the old/,
    );
    edit(engine, "Clipped", "Clips");
    expect(lineWith(engine, "Clips").editable).toBe(true);
  });

  it("lets text grow under an upright rectangle drawn with lines, as with re", () => {
    const engine = open(
      makePdf({
        content: "q 0 0 m 400 0 l 400 400 l 0 400 l h W n BT /F1 12 Tf 50 300 Td (Boxed) Tj ET Q",
      }),
    );
    edit(engine, "Boxed", "Boxed in, and longer");
    expect(lineWith(engine, "Boxed in, and longer").editable).toBe(true);
  });
});

describe("how lines are rewritten", () => {
  it("keeps later text in the same text object where it was", () => {
    const engine = open(
      makePdf({ content: "BT /F1 12 Tf 50 300 Td (Short) Tj [-15000] TJ (Far away) Tj ET" }),
    );
    const far = lineWith(engine, "Far away");
    edit(engine, "Short", "A good deal longer");
    expectSameRect(lineWith(engine, "Far away").rect, far.rect);
    expect(engine.listTextLines(0).lines.map((l) => l.text)).toContain("A good deal longer");
  });

  it("edits one cell of a table drawn by a single TJ", () => {
    const engine = open(
      makePdf({ content: "BT /F1 10 Tf 40 300 Td [(Alpha) -12000 (Beta) -12000 (Gamma)] TJ ET" }),
    );
    const alpha = lineWith(engine, "Alpha");
    const gamma = lineWith(engine, "Gamma");
    edit(engine, "Beta", "Betamax");
    expectSameRect(lineWith(engine, "Alpha").rect, alpha.rect);
    expectSameRect(lineWith(engine, "Gamma").rect, gamma.rect);
    expect(lineWith(engine, "Betamax").editable).toBe(true);
    const content = contentBytes(engine.save());
    expect(content).toContain("BT /F1 10 Tf 40 300 Td ");
    expect(content).not.toContain("(Beta)");
  });

  it("keeps the line moves of ' and \" operators", () => {
    const engine = open(
      makePdf({
        content: "BT /F1 12 Tf 16 TL 50 300 Td (One) Tj (Two) ' 2 0.5 (Three) \" (Four) ' ET",
      }),
    );
    const before = engine.listTextLines(0).lines;
    edit(engine, "Two", "Second");
    edit(engine, "Three", "3rd");
    const after = engine.listTextLines(0).lines;
    const four = (lines: TextLineInfo[]) => lines.find((l) => l.text === "Four")?.rect;
    expectSameRect(four(after), four(before));
    const second = after.find((l) => l.text === "Second");
    const two = before.find((l) => l.text === "Two");
    expect(second?.rect[0]).toBeCloseTo(two?.rect[0] as number, 3);
    expect(second?.rect[3]).toBeCloseTo(two?.rect[3] as number, 3);
  });

  it("drops actual-text marks that would still give the old words", () => {
    const engine = open(
      makePdf({
        content:
          "BT /F1 12 Tf 50 300 Td (Of) Tj /Span <</ActualText (fi)>> BDC (X) Tj EMC (ce) Tj ET",
      }),
    );
    expect(lineWith(engine, "Office").editable).toBe(true);
    edit(engine, "Office", "Studio");
    const lines = engine.listTextLines(0).lines.map((l) => l.text);
    expect(lines).toContain("Studio");
    expect(lines.join(" ")).not.toContain("fi");
    expect(contentBytes(engine.save())).not.toContain("ActualText");
  });

  it("rewrites only the content stream that has the line", () => {
    const original = makePdf({
      content: [
        "q BT /F1 12 Tf 50",
        "300 Td (First stream) Tj ET Q",
        "BT /F1 12 Tf 50 250 Td (Last stream) Tj ET",
      ],
    });
    const engine = open(original);
    edit(engine, "Last stream", "Final stream");
    const saved = engine.save();
    const read = (bytes: Uint8Array) => {
      const doc = mupdf.Document.openDocument(bytes, "application/pdf");
      const contents = (doc.asPDF() as mupdf.PDFDocument).findPage(0).get("Contents");
      const out = Array.from({ length: contents.length }, (_, i) => ({
        num: contents.get(i).asIndirect(),
        text: contents.get(i).readStream().asString(),
      }));
      doc.destroy();
      return out;
    };
    const [a, b, c] = read(saved);
    const [oa, ob, oc] = read(original);
    expect([a?.num, b?.num]).toEqual([oa?.num, ob?.num]);
    expect(c?.num).not.toBe(oc?.num);
    expect(c?.text).toContain("BT /F1 12 Tf 50 250 Td ");
    expect(lineWith(engine, "First stream").editable).toBe(true);
  });

  it("edits text on a rotated page and text turned on its side", () => {
    const rotated = open(
      makePdf({ content: "BT /F1 12 Tf 50 300 Td (On a turned page) Tj ET", rotate: 90 }),
    );
    const line = lineWith(rotated, "On a turned page");
    expect(line.editable).toBe(true);
    expect(line.rotation).toBe(90);
    edit(rotated, "On a turned page", "Still on a turned page");
    expect(rotated.listTextLines(0).lines.map((l) => l.text)).toContain("Still on a turned page");

    const sideways = open(
      makePdf({ content: "BT /F1 12 Tf 0 1 -1 0 200 50 Tm (Up the side) Tj ET" }),
    );
    expect(lineWith(sideways, "Up the side")).toMatchObject({ editable: true, rotation: 270 });
  });

  it("keeps the line's word spacing when a standard font stands in", () => {
    const engine = open(makePdf({ content: "BT /F2 12 Tf 4 Tw 50 300 Td (ABC DEF) Tj ET" }));
    const line = lineWith(engine, "ABC DEF");
    // "x" isn't in the font, so the whole line is written in Helvetica.
    const check = engine.checkTextEdit(0, line.id, line.text, "ABC Dex");
    expect(check.fallback).toBe("Helvetica");
    // Helvetica: A 667, B 667, C 722, space 278, D 722, e 556, x 500; plus 4 for the space.
    const helvetica = ((667 + 667 + 722 + 278 + 722 + 556 + 500) * 12) / 1000;
    expect(check.width).toBeCloseTo(helvetica + 4, 2);
    engine.editTextLine(0, line.id, line.text, "ABC Dex");
    const doc = mupdf.Document.openDocument(engine.save(), "application/pdf");
    try {
      const page = (doc.asPDF() as mupdf.PDFDocument).loadPage(0);
      const chars = contentLines(page).flatMap((l) => l.chars);
      page.destroy();
      const d = chars.find((c) => c.c === "D");
      // "ABC " is 28.008 pt in Helvetica at 12 pt, and the space gets the 4 pt of Tw.
      expect(d?.x).toBeCloseTo(50 + 28.008 + 4, 2);
    } finally {
      doc.destroy();
    }
  });

  it("writes word spacing and character spacing as the line had them", () => {
    const engine = open(
      makePdf({ content: "BT /F1 12 Tf 0.5 Tc 4 Tw 50 300 Td (Spaced out) Tj ET" }),
    );
    const before = lineWith(engine, "Spaced out");
    edit(engine, "Spaced out", "Spaced out");
    // No change, no step.
    expect(engine.history().canUndo).toBe(false);
    edit(engine, "Spaced out", "Spaced  out");
    const after = engine.listTextLines(0).lines.find((l) => l.text.startsWith("Spaced"));
    // Wider by one space (3.336 pt at 12 pt), plus 0.5 for Tc and 4 for Tw.
    expect((after?.rect[2] as number) - (before.rect[2] as number)).toBeCloseTo(3.336 + 0.5 + 4, 1);
  });
});

describe("every fixture", () => {
  it("lists the lines of the first pages of every fixture without throwing, quickly", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const list = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) return n === "scripts" ? [] : list(p);
        return n.endsWith(".pdf") ? [p] : [];
      });
    const passwords: Record<string, string> = {
      "encrypted-aes256.pdf": "open-sesame",
      "encrypted-rc4-40.pdf": "open-sesame",
      "005-libreoffice-writer-password_libreoffice-writer-password.pdf": "openpassword",
    };
    let pages = 0;
    let editable = 0;
    const start = performance.now();
    for (const path of list(fixtures)) {
      const engine = new PdfEngine();
      try {
        const result = engine.open(new Uint8Array(readFileSync(path)));
        if (
          result.needsPassword &&
          !engine.authenticate(passwords[path.split("/").pop() as string] ?? "")
        ) {
          continue;
        }
      } catch {
        continue; // Files that can't be opened at all are covered by fixtures.test.ts.
      }
      try {
        let count = 0;
        try {
          count = engine.pageCount;
        } catch {
          continue;
        }
        for (let page = 0; page < Math.min(count, 2); page++) {
          let lines: TextLineInfo[];
          try {
            lines = engine.listTextLines(page).lines;
          } catch (err) {
            // Only "not a PDF" is acceptable (an HTML file named .pdf).
            expect((err as Error).message).toMatch(/Not a PDF/);
            continue;
          }
          pages++;
          editable += lines.filter((l) => l.editable).length;
          for (const l of lines) expect(l.editable || (l.reason?.length ?? 0) > 10).toBe(true);
        }
      } finally {
        engine.close();
      }
    }
    expect(pages).toBeGreaterThan(80);
    expect(editable).toBeGreaterThan(2000);
    expect(performance.now() - start).toBeLessThan(60_000);
  }, 120_000);

  it.each([
    "generated/invoice.pdf",
    "generated/contract-libreoffice.pdf",
    "generated/contract-chromium.pdf",
    "generated/report-500-pages.pdf",
    "third-party/py-pdf/004-pdflatex-4-pages_pdflatex-4-pages.pdf",
    "third-party/py-pdf/011-google-doc-document_google-doc-document.pdf",
    "third-party/py-pdf/026-latex-multicolumn_multicolumn.pdf",
    "public-domain/irs-form-w9.pdf",
  ])(
    "%s: editing each line changes pixels only around it",
    (name) => {
      const engine = open(fixture(name));
      const before = engine.listTextLines(0).lines;
      const base = engine.renderPage(0, 1);
      const editable = before.filter((l) => l.editable && l.text.trim().length > 1);
      // At most 25 lines per file, spread over the page, to keep the test quick.
      const step = Math.max(1, Math.ceil(editable.length / 25));
      let edited = 0;
      for (let i = 0; i < editable.length; i += step) {
        const line = editable[i] as TextLineInfo;
        // Letters the font may not have, so some lines use the standard font.
        const replacement = `${line.text.trim().slice(0, -1)}Q~`;
        try {
          engine.editTextLine(0, line.id, line.text, replacement);
        } catch (err) {
          // A line in a box that clips it (a table cell) can't grow past the box.
          expect((err as Error).message).toMatch(/its end would be hidden/);
          continue;
        }
        const after = engine.listTextLines(0).lines;
        const found = after.filter((l) =>
          l.text.replace(/\s+/g, "").includes(replacement.replace(/\s+/g, "")),
        );
        expect(found.length, `${name}: "${replacement}"`).toBeGreaterThan(0);
        const box = found.reduce((r, l) => union(r, l.rect, 0), union(line.rect, line.rect, 0));
        const diff = changedOutside(base, engine.renderPage(0, 1), union(box, box, 2));
        expect(diff.outside, `${name}: "${line.text}"`).toBe(0);
        engine.undo();
        edited++;
      }
      expect(edited).toBeGreaterThan(0);
      expect(engine.listTextLines(0).lines.map(key)).toEqual(before.map(key));
    },
    60_000,
  );
});
