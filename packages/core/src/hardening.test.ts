// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression tests for the bugs the fuzzer (fuzz/, fuzz.test.ts) found: each builds the
// smallest file that showed one and checks it's now handled with a message, not a crash, a
// hang or an internal error.

import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { MAX_STREAMS, namesIn } from "./drawingDepth";
import { createBlankPdf, engineTroubles, onEngineTrouble, PdfEngine } from "./engine";
import { errorMessage } from "./errors";
import { onePage, type RawObject, rawPdf, stream } from "./fuzz/rawPdf";
import {
  MAX_OBJECT_NESTING,
  MAX_OBJECT_STREAM_BYTES,
  objectNesting,
  TOO_COMPLEX_MESSAGE,
  TOO_DEEP_MESSAGE,
} from "./nesting";
import { DAMAGED_PAGE_TREE } from "./pageTree";

const CATALOG = "<</Type /Catalog /Pages 2 0 R>>";

/** The engine still opens, renders and saves a good file. */
function stillWorks(engine: PdfEngine) {
  engine.open(createBlankPdf(1, 200, 100));
  expect(engine.renderPage(0, 0.5).width).toBe(100);
  expect(engine.save().length).toBeGreaterThan(0);
  engine.close();
}

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("a missing object in a chain of lookups", () => {
  it("gives null instead of throwing a TypeError", () => {
    const missing = mupdf.PDFObject.Null;
    expect(missing.get("Root").get("Pages").isNull()).toBe(true);
    expect(missing.resolve().isNull()).toBe(true);
    expect(missing.getInheritable("Resources").isNull()).toBe(true);
    const put = errorOf(() => missing.put("A", 1));
    expect(put).toBeInstanceOf(Error);
    expect(put).not.toBeInstanceOf(TypeError);
  });

  it("opens a file whose catalog is missing with an ordinary error or no pages", () => {
    // Found by the fuzzer: reading the page labels did trailer.get("Root").get("PageLabels"),
    // and MuPDF.js's shared null object threw "TypeError: null is not an object".
    // No catalog anywhere, and no cross-reference table: MuPDF repairs it without a /Root.
    const bytes = rawPdf(["<</Type /Pages /Kids [2 0 R] /Count 1>>", "<</Type /Page>>"], {
      noXref: true,
    });
    const engine = new PdfEngine();
    const err = errorOf(() => engine.open(bytes));
    if (err !== undefined) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TypeError);
    }
    engine.close();
    stillWorks(engine);
  });
});

/** A page drawing a chain of `depth` form XObjects (or tiling patterns), each using the next. */
function nestedDrawings(kind: "form" | "pattern", depth: number): Uint8Array {
  const use = (n: number) =>
    kind === "form"
      ? { res: `/XObject <</X ${n} 0 R>>`, draw: "/X Do" }
      : { res: `/Pattern <</P ${n} 0 R>>`, draw: "/Pattern cs /P scn 0 0 10 10 re f" };
  const first = use(5);
  const objects: RawObject[] = [
    CATALOG,
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    `<</Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources <<${first.res}>>>>`,
    stream("", first.draw),
  ];
  for (let i = 0; i < depth; i++) {
    const last = i === depth - 1;
    const next = use(6 + i);
    const res = last ? "" : `/Resources <<${next.res}>>`;
    const draw = last ? "0 0 10 10 re f" : next.draw;
    objects.push(
      kind === "form"
        ? stream(`/Type /XObject /Subtype /Form /BBox [0 0 10 10] ${res}`, draw)
        : stream(
            `/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 ${res}`,
            draw,
          ),
    );
  }
  return rawPdf(objects);
}

describe("drawings nested too deeply for MuPDF", () => {
  // Found by the fuzzer: a 1 KB file whose pattern fills with itself, or about 30 nested forms
  // or patterns, overflowed MuPDF's WebAssembly stack and killed the engine.
  it("refuses a pattern that fills with itself, and the engine survives", () => {
    const bytes = rawPdf([
      CATALOG,
      "<</Type /Pages /Kids [3 0 R] /Count 1>>",
      "<</Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources <</Pattern <</P 5 0 R>>>>>>",
      stream("", "/Pattern cs /P scn 0 0 100 100 re f"),
      stream(
        "/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources <</Pattern <</P 5 0 R>>>>",
        "/Pattern cs /P scn 0 0 10 10 re f",
      ),
    ]);
    const engine = new PdfEngine();
    engine.open(bytes);
    expect(() => engine.renderPage(0, 0.5)).toThrow(/can't be shown safely.*contains itself/);
    expect(() => engine.exportPage(0, { format: "text" })).toThrow(/can't be shown safely/);
    expect(() => engine.listTextLines(0)).toThrow(/can't be shown safely/);
    expect(engine.search("x").hits).toEqual([]);
    // Saving doesn't draw, so it still works.
    expect(engine.save().length).toBeGreaterThan(0);
    engine.close();
    stillWorks(engine);
  });

  it.each(["form", "pattern"] as const)("refuses 40 nested %ss but shows 10", (kind) => {
    const engine = new PdfEngine();
    engine.open(nestedDrawings(kind, 40));
    expect(() => engine.renderPage(0, 1)).toThrow(/nested too deeply/);
    engine.open(nestedDrawings(kind, 10));
    expect(engine.renderPage(0, 1).width).toBe(100);
    engine.close();
    stillWorks(engine);
  });

  it("doesn't count resources a drawing has but doesn't use", () => {
    // A shared resource dictionary that lists every form, each form included, is common.
    const shared = "<</XObject <</A 5 0 R /B 6 0 R>>>>";
    const bytes = rawPdf([
      CATALOG,
      "<</Type /Pages /Kids [3 0 R] /Count 1>>",
      "<</Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources 7 0 R>>",
      stream("", "/A Do"),
      stream("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources 7 0 R", "/B Do"),
      stream("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources 7 0 R", "0 0 5 5 re f"),
      shared,
    ]);
    const engine = new PdfEngine();
    engine.open(bytes);
    expect(engine.renderPage(0, 1).width).toBe(100);
    engine.close();
  });

  it("checks annotation appearances too", () => {
    const objects: RawObject[] = [
      CATALOG,
      "<</Type /Pages /Kids [3 0 R] /Count 1>>",
      "<</Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Annots [4 0 R]>>",
      "<</Type /Annot /Subtype /Square /Rect [0 0 50 50] /AP <</N 5 0 R>>>>",
      stream(
        "/Type /XObject /Subtype /Form /BBox [0 0 50 50] /Resources <</XObject <</S 5 0 R>>>>",
        "/S Do",
      ),
    ];
    const engine = new PdfEngine();
    engine.open(rawPdf(objects));
    expect(() => engine.renderPage(0, 1)).toThrow(/can't be shown safely/);
    engine.close();
  });

  // From review: only the first 10,000 content streams were checked, so a deep pattern drawn
  // by the next one went unseen and the page passed.
  it("refuses a page with more content streams than it can check", () => {
    const deep = nestedDrawings("pattern", 40);
    const text = new TextDecoder("latin1").decode(deep);
    // Many references to nothing (harmless, MuPDF skips them), then the stream with the chain.
    const harmless = `${"9999 0 R ".repeat(MAX_STREAMS)}4 0 R`;
    const patched = text.replace("/Contents 4 0 R", `/Contents [${harmless}]`);
    const engine = new PdfEngine();
    engine.open(Uint8Array.from(patched, (c) => c.charCodeAt(0)));
    expect(() => engine.renderPage(0, 1)).toThrow(/too complex to check/);
    engine.close();
    stillWorks(engine);
  });

  it("reads names with escapes", () => {
    const bytes = new TextEncoder().encode("/A#20B Do (/notaname) /Pattern cs /P1 scn");
    expect([...namesIn(bytes)]).toEqual(["A B", "notaname", "Pattern", "P1"]);
  });
});

describe("objects nested too deeply for MuPDF", () => {
  // Found by the fuzzer: about 190 nested arrays or dictionaries in one object silently
  // corrupted MuPDF's memory, so a later, good file crashed the engine.
  const nested = (depth: number) =>
    rawPdf(onePage("BT ET", `/Junk ${"[".repeat(depth)}1${"]".repeat(depth)}`));

  it("refuses a file nesting arrays 200 deep, before MuPDF reads it", () => {
    const engine = new PdfEngine();
    expect(() => engine.open(nested(200))).toThrow(TOO_DEEP_MESSAGE);
    expect(() => engine.open(rawPdf(onePage("BT ET", `/Junk ${"<</A ".repeat(200)}1`)))).toThrow(
      TOO_DEEP_MESSAGE,
    );
    stillWorks(engine);
  });

  it("opens ordinary nesting", () => {
    const engine = new PdfEngine();
    expect(engine.open(nested(20)).needsPassword).toBe(false);
    engine.close();
  });

  it("refuses a file being inserted that nests too deeply", () => {
    const engine = new PdfEngine();
    engine.open(createBlankPdf(1));
    expect(() => engine.insertPdfs(1, [{ bytes: nested(200) }])).toThrow(
      /The file being inserted can't be opened safely/,
    );
    expect(engine.pageCount).toBe(1);
    engine.close();
  });

  it("finds nesting hidden in an object stream", () => {
    // Written by MuPDF, so the deep object ends up packed in a compressed object stream.
    const pdf = new mupdf.PDFDocument();
    let deep = pdf.newArray();
    for (let i = 0; i < MAX_OBJECT_NESTING + 10; i++) {
      const outer = pdf.newArray();
      outer.push(deep);
      deep = outer;
    }
    pdf.insertPage(-1, pdf.addPage([0, 0, 100, 100], 0, pdf.newDictionary(), ""));
    pdf.getTrailer().get("Root").put("Junk", pdf.addObject(deep));
    const buffer = pdf.saveToBuffer("compress,objstms=yes");
    const bytes = buffer.asUint8Array().slice();
    buffer.destroy();
    pdf.destroy();
    expect(new TextDecoder("latin1").decode(bytes)).toContain("/ObjStm");
    expect(objectNesting(bytes)).toBeLessThanOrEqual(MAX_OBJECT_NESTING);
    expect(() => new PdfEngine().open(bytes)).toThrow(TOO_DEEP_MESSAGE);
  });

  it("skips strings, comments and stream data when measuring", () => {
    const text =
      "1 0 obj [ [ ([[[[) ] <5b5b> ] % [[[[\nendobj 2 0 obj <</Length 4>>stream\n[[[[\nendstream endobj";
    expect(objectNesting(new TextEncoder().encode(text))).toBe(2);
  });

  // From review: names were read as keywords, so /stream skipped ahead and /endobj reset the
  // count, and nesting after them went unchecked.
  it.each([
    ["/stream null", `${"[".repeat(40)} /stream`],
    ["/endobj in an array", `${"[".repeat(40)} /endobj`],
    ["an escaped bracket in a string", `${"[".repeat(40)} (a\\) /stream b) /stream`],
  ])("isn't fooled by %s", (_what, prefix) => {
    const deep = `${"[".repeat(40)}1${"]".repeat(40)}`;
    const bytes = rawPdf(onePage("BT ET", `/Junk ${prefix} ${deep}`));
    expect(objectNesting(bytes)).toBeGreaterThan(MAX_OBJECT_NESTING);
    expect(() => new PdfEngine().open(bytes)).toThrow(TOO_DEEP_MESSAGE);
  });

  it("keeps checking after a stream with no endstream", () => {
    const deep = `${"<</A ".repeat(100)}1${">>".repeat(100)}`;
    const text = `1 0 obj <</Length 3>>stream\nabc\nendobj 2 0 obj ${deep} endobj`;
    expect(objectNesting(new TextEncoder().encode(text))).toBeGreaterThan(MAX_OBJECT_NESTING);
  });

  // From review: every object stream was decompressed in full on opening, however big.
  it("refuses object streams too large or unusual to decompress safely", () => {
    const objstm = (dict: string, size: number) =>
      rawPdf([
        ...onePage("BT ET"),
        stream(`/Type /ObjStm /N 1 /First 4 ${dict}`, "0 0 ".padEnd(size, " ")),
      ]);
    const engine = new PdfEngine();
    // A chain of filters multiplies how much a small stream can expand.
    expect(() => engine.open(objstm("/Filter [/FlateDecode /FlateDecode]", 10))).toThrow(
      TOO_COMPLEX_MESSAGE,
    );
    expect(() => engine.open(objstm("/Filter 9 0 R", 10))).toThrow(TOO_COMPLEX_MESSAGE);
    expect(() => engine.open(objstm("", MAX_OBJECT_STREAM_BYTES + 1))).toThrow(TOO_COMPLEX_MESSAGE);
    // An ordinary one is fine.
    expect(engine.open(objstm("", 100)).needsPassword).toBe(false);
    engine.close();
  });
});

describe("damaged page trees", () => {
  // Found by the fuzzer: inserting a page into a tree whose page object is unreadable and
  // whose /Parent links loop never returned, so the app would hang for good.
  it("refuses to change the pages of the file the fuzzer found (it would hang)", () => {
    const text = new TextDecoder("latin1").decode(
      rawPdf([
        CATALOG,
        "<</Type /Pages /Kids [3 0 R] /Count 1 /Parent 4 0 R>>",
        "<</Type /Page /Parent 2 0 R>>",
        "<</Type /Pages /Kids [2 0 R] /Count 1 /Parent 2 0 R>>",
      ]),
    );
    // The page's object header is damaged, so it can't be read.
    const bytes = Uint8Array.from(text.replace("3 0 obj", "3  obj"), (c) => c.charCodeAt(0));
    const engine = new PdfEngine();
    engine.open(bytes);
    expect(() => engine.insertBlankPages(1, 1)).toThrow(DAMAGED_PAGE_TREE);
    engine.close();
    stillWorks(engine);
  });

  it("refuses to change the pages when a page object is missing, but shows the file", () => {
    const bytes = rawPdf([
      CATALOG,
      "<</Type /Pages /Kids [3 0 R 4 0 R] /Count 2>>",
      "<</Type /Page /Parent 2 0 R /MediaBox [0 0 100 100]>>",
      null,
    ]);
    const engine = new PdfEngine();
    engine.open(bytes);
    expect(engine.renderPage(0, 1).width).toBe(100);
    expect(() => engine.insertBlankPages(1, 1)).toThrow(DAMAGED_PAGE_TREE);
    expect(() => engine.insertPdfs(1, [{ bytes: createBlankPdf(1) }])).toThrow(DAMAGED_PAGE_TREE);
    expect(() => engine.deletePages([0])).toThrow(DAMAGED_PAGE_TREE);
    expect(engine.history().canUndo).toBe(false);
    engine.close();
    stillWorks(engine);
  });

  it("refuses to change the pages when a /Parent chain loops", () => {
    const bytes = rawPdf([
      CATALOG,
      "<</Type /Pages /Kids [3 0 R] /Count 1 /Parent 4 0 R>>",
      // Everything a page could inherit is on the page itself, so it still loads.
      "<</Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [0 0 100 100] /Rotate 0 /Resources <<>>>>",
      "<</Type /Pages /Kids [2 0 R] /Count 1 /Parent 2 0 R>>",
    ]);
    const engine = new PdfEngine();
    engine.open(bytes);
    expect(() => engine.insertBlankPages(0, 1)).toThrow(DAMAGED_PAGE_TREE);
    engine.close();
  });

  it("still changes the pages of a good file", () => {
    const engine = new PdfEngine();
    engine.open(createBlankPdf(3));
    engine.insertBlankPages(1, 1);
    engine.movePages([0], 2);
    engine.deletePages([1]);
    expect(engine.pageCount).toBe(3);
    engine.close();
  });
});

describe("trouble reported by MuPDF", () => {
  it("is noted, so the app can start a fresh engine before the next file", () => {
    let told = 0;
    onEngineTrouble(() => told++);
    const before = engineTroubles();
    const engine = new PdfEngine();
    const text = new TextDecoder("latin1").decode(rawPdf(onePage()));
    // A broken cross-reference offset: MuPDF repairs the file, and says so.
    engine.open(new TextEncoder().encode(text.replace(/startxref\n\d+/, "startxref\n5")));
    engine.close();
    expect(engineTroubles()).toBeGreaterThan(before);
    expect(told).toBe(1);
  });

  it("has a message for anything thrown", () => {
    expect(errorMessage(new Error("Bad page"))).toBe("Bad page");
    expect(errorMessage("TRYLATER")).toMatch(/unexpected problem/);
    expect(errorMessage(new Error(""))).toMatch(/unexpected problem/);
  });
});
