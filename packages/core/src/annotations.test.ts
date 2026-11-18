// SPDX-License-Identifier: AGPL-3.0-or-later

import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { type AnnotationSpec, createBlankPdf, type PagePoint, PdfEngine } from "./engine";

type Rgb = [number, number, number];

/** A 400×300 page per entry, each with two lines of text; `rotate` per page. */
function textPdf(rotations: (0 | 90 | 180 | 270)[] = [0]): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  try {
    const font = pdf.addSimpleFont(new mupdf.Font("Helvetica"));
    rotations.forEach((rotate, i) => {
      const resources = pdf.newDictionary();
      const fonts = pdf.newDictionary();
      fonts.put("F1", font);
      resources.put("Font", fonts);
      const content = `BT /F1 18 Tf 40 220 Td (The quick brown fox jumps) Tj 0 -30 Td (over the lazy dog p${i}.) Tj ET`;
      pdf.insertPage(-1, pdf.addPage([0, 0, 400, 300], rotate, resources, content));
    });
    return pdf.saveToBuffer("").asUint8Array().slice();
  } finally {
    pdf.destroy();
  }
}

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

/** Colour of the pixel at (x, y) points on a page rendered at 72 dpi. */
function pixel(engine: PdfEngine, page: number, x: number, y: number): Rgb {
  const { width, pixels } = engine.renderPage(page, 1);
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2]] as Rgb;
}

/** The left/right middle points of where `words` appear on a page, from search. */
function span(engine: PdfEngine, page: number, words: string): { from: PagePoint; to: PagePoint } {
  const hit = engine.search(words).hits.find((h) => h.page === page);
  const q = hit?.quads[0] as [number, number, number, number, number, number, number, number];
  if (!q) throw new Error(`"${words}" not found`);
  const midY = (q[1] + q[5]) / 2;
  return { from: [q[0] + 1, midY], to: [q[2] - 1, midY] };
}

/** Subtypes of the annotations on a page of a saved file. */
function subtypes(bytes: Uint8Array, page = 0): string[] {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const annots = doc.asPDF()?.findPage(page).get("Annots");
    const out: string[] = [];
    if (annots?.isArray()) {
      for (let i = 0; i < annots.length; i++)
        out.push(annots.get(i).resolve().get("Subtype").asName());
    }
    return out;
  } finally {
    doc.destroy();
  }
}

const RED: Rgb = [1, 0, 0];

describe("selectText", () => {
  it("returns the text between two points, in page points from the top-left", () => {
    const engine = open(textPdf());
    const { from, to } = span(engine, 0, "quick brown");
    const quads = engine.selectText(0, from, to);
    expect(quads).toHaveLength(1);
    const [q] = quads as [number[]];
    expect(q[0]).toBeCloseTo(from[0] - 1, 0);
    expect(q[2]).toBeCloseTo(to[0] + 1, 0);
    // A drag across both lines selects both.
    const second = span(engine, 0, "lazy dog");
    expect(engine.selectText(0, from, second.to)).toHaveLength(2);
  });

  it("finds nothing on a page without text", () => {
    const engine = open(createBlankPdf(1));
    expect(engine.selectText(0, [10, 10], [200, 200])).toEqual([]);
  });

  it("follows the pages after they move", () => {
    const engine = open(textPdf([0, 0]));
    engine.movePages([1], 0);
    const { from, to } = span(engine, 0, "p1");
    expect(engine.selectText(0, from, to)).toHaveLength(1);
    engine.addAnnotation({ kind: "highlight", page: 0, from, to, color: [1, 1, 0] });
    expect(subtypes(engine.save(), 0)).toEqual(["Highlight"]);
  });
});

describe("addAnnotation", () => {
  it.each([
    ["highlight", "Highlight"],
    ["underline", "Underline"],
    ["strikeout", "StrikeOut"],
  ] as const)("marks text with a %s", (kind, subtype) => {
    const engine = open(textPdf());
    const { from, to } = span(engine, 0, "quick brown");
    const result = engine.addAnnotation({ kind, page: 0, from, to, color: [1, 0.8, 0] });
    expect(result.history.undoLabel).toMatch(/^Add /);
    expect(subtypes(engine.save())).toEqual([subtype]);
  });

  it("puts a highlight behind the words, coloured", () => {
    const engine = open(textPdf());
    const { from, to } = span(engine, 0, "quick brown");
    const [q] = engine.selectText(0, from, to) as [number[]];
    /** Average blue over the highlighted area: yellow has none, so it drops. */
    const blue = () => {
      const { width, pixels } = engine.renderPage(0, 1);
      let sum = 0;
      let n = 0;
      for (let y = Math.ceil(q[1] as number); y < (q[5] as number); y++) {
        for (let x = Math.ceil(q[0] as number); x < (q[2] as number); x++) {
          sum += pixels[(y * width + x) * 4 + 2] as number;
          n++;
        }
      }
      return sum / n;
    };
    const before = blue();
    engine.addAnnotation({ kind: "highlight", page: 0, from, to, color: [1, 1, 0] });
    expect(blue()).toBeLessThan(before * 0.5);
  });

  it("refuses text markup where there's no text", () => {
    const engine = open(createBlankPdf(1));
    expect(() =>
      engine.addAnnotation({
        kind: "highlight",
        page: 0,
        from: [10, 10],
        to: [99, 99],
        color: RED,
      }),
    ).toThrow("no text");
    expect(engine.history().canUndo).toBe(false);
  });

  it("draws freehand, shapes, lines and arrows where asked", () => {
    const engine = open(createBlankPdf(1, 400, 300));
    const specs: AnnotationSpec[] = [
      {
        kind: "ink",
        page: 0,
        strokes: [
          [
            [20, 20],
            [60, 40],
            [100, 20],
          ],
        ],
        color: RED,
        width: 3,
      },
      { kind: "rectangle", page: 0, rect: [120, 20, 200, 80], color: [0, 0, 1], width: 4 },
      { kind: "ellipse", page: 0, rect: [220, 20, 300, 80], color: RED, width: 2 },
      { kind: "line", page: 0, from: [20, 150], to: [150, 150], color: RED, width: 2 },
      { kind: "arrow", page: 0, from: [200, 150], to: [350, 200], color: RED, width: 2 },
    ];
    for (const spec of specs) engine.addAnnotation(spec);
    expect(subtypes(engine.save())).toEqual(["Ink", "Square", "Circle", "Line", "Line"]);
    // The rectangle's left edge is blue, its middle still white.
    expect(pixel(engine, 0, 120, 50)).toEqual([0, 0, 255]);
    expect(pixel(engine, 0, 160, 50)).toEqual([255, 255, 255]);
    expect(pixel(engine, 0, 85, 150)).toEqual([255, 0, 0]);
  });

  it("adds sticky notes and text boxes with their text", () => {
    const engine = open(createBlankPdf(1, 400, 300));
    engine.addAnnotation({
      kind: "note",
      page: 0,
      at: [300, 20],
      text: " Check this ",
      color: [1, 0.8, 0],
    });
    engine.addAnnotation({
      kind: "text",
      page: 0,
      rect: [20, 20, 220, 60],
      text: "Approved by J.",
      color: [0, 0, 0],
      size: 14,
    });
    const saved = engine.save();
    // A note comes with its pop-up window.
    expect(subtypes(saved)).toEqual(["Text", "Popup", "FreeText"]);
    const reopened = open(saved);
    expect(reopened.search("Approved by J.").hits).toHaveLength(0); // annotation, not page text
    const doc = mupdf.Document.openDocument(saved, "application/pdf");
    const annots = doc.asPDF()?.findPage(0).get("Annots");
    expect(annots?.get(0).get("Contents").asString()).toBe("Check this");
    expect(annots?.get(2).get("Contents").asString()).toBe("Approved by J.");
    doc.destroy();
    // Undoing both leaves nothing behind, pop-up included.
    engine.undo();
    engine.undo();
    expect(subtypes(engine.save())).toEqual([]);
    engine.redo();
    expect(subtypes(engine.save())).toEqual(["Text", "Popup"]);
  });

  it("covers what's under a white-out box", () => {
    const engine = open(textPdf());
    const { from, to } = span(engine, 0, "quick");
    const dark = (c: Rgb) => c[0] + c[1] + c[2] < 600;
    // Some pixel of the word is dark before.
    const row = Math.round(from[1]);
    const xs = Array.from({ length: Math.round(to[0] - from[0]) }, (_, i) => from[0] + i);
    expect(xs.some((x) => dark(pixel(engine, 0, x, row)))).toBe(true);
    engine.addAnnotation({
      kind: "whiteout",
      page: 0,
      rect: [from[0] - 2, from[1] - 12, to[0] + 2, from[1] + 8],
    });
    expect(xs.some((x) => dark(pixel(engine, 0, x, row)))).toBe(false);
  });

  it("places shapes as the page is shown, on a rotated page", () => {
    const engine = open(textPdf([90]));
    // Shown, the page is 300 wide and 400 tall.
    expect(engine.info().pages[0]).toEqual({ width: 300, height: 400 });
    engine.addAnnotation({
      kind: "rectangle",
      page: 0,
      rect: [20, 300, 120, 380],
      color: [0, 0, 1],
      width: 4,
    });
    expect(pixel(engine, 0, 20, 340)).toEqual([0, 0, 255]);
    expect(pixel(engine, 0, 70, 340)).toEqual([255, 255, 255]);
    // Highlighting rotated text works too. On a page turned 90°, the words run down the
    // page, so the drag goes from their top to their bottom.
    const hit = engine.search("quick brown").hits[0]?.quads[0] as number[];
    const [ulx, uly, urx, ury, llx, lly, lrx, lry] = hit as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const x = (ulx + urx + llx + lrx) / 4;
    const top = Math.min(uly, ury, lly, lry);
    const bottom = Math.max(uly, ury, lly, lry);
    engine.addAnnotation({
      kind: "highlight",
      page: 0,
      from: [x, top + 1],
      to: [x, bottom - 1],
      color: [1, 1, 0],
    });
    expect(subtypes(engine.save())).toEqual(["Square", "Highlight"]);
  });

  it("undoes and redoes each annotation, and only appends to the file", () => {
    const original = textPdf();
    const engine = open(original.slice());
    const { from, to } = span(engine, 0, "quick brown");
    engine.addAnnotation({ kind: "highlight", page: 0, from, to, color: [1, 1, 0] });
    engine.addAnnotation({
      kind: "rectangle",
      page: 0,
      rect: [10, 10, 60, 60],
      color: RED,
      width: 2,
    });
    expect(engine.history().undoLabel).toBe("Add rectangle");
    engine.undo();
    expect(subtypes(engine.save())).toEqual(["Highlight"]);
    engine.undo();
    expect(subtypes(engine.save())).toEqual([]);
    engine.redo();
    engine.redo();
    const saved = engine.save();
    expect(subtypes(saved)).toEqual(["Highlight", "Square"]);
    expect(saved.subarray(0, original.length)).toEqual(original);
  });

  it("survives saving while an annotation is undone, then redoing and saving again", () => {
    // MuPDF 1.28.6 drops new objects nothing points to when saving, from the open document
    // too, so an undone annotation was gone on redo and the next save was broken. Keep this
    // test when updating MuPDF (see .github/dependabot.yml).
    const engine = open(textPdf());
    engine.addAnnotation({
      kind: "rectangle",
      page: 0,
      rect: [10, 10, 60, 60],
      color: RED,
      width: 2,
    });
    engine.addAnnotation({ kind: "note", page: 0, at: [100, 10], text: "Hi", color: RED });
    engine.undo();
    engine.undo();
    engine.save();
    engine.redo();
    engine.redo();
    expect(subtypes(engine.save())).toEqual(["Square", "Text", "Popup"]);
    // And again, to be sure the second save is still a good file.
    const reopened = open(engine.save());
    expect(reopened.pageCount).toBe(1);
  });

  it("refuses bad input without changing the document", () => {
    const engine = open(createBlankPdf(1));
    const bad: [AnnotationSpec, string][] = [
      [{ kind: "rectangle", page: 0, rect: [0, 0, 50, 50], color: [2, 0, 0], width: 1 }, "colour"],
      [{ kind: "rectangle", page: 0, rect: [0, 0, 50, 50], color: RED, width: 0 }, "width"],
      [{ kind: "ink", page: 0, strokes: [[]], color: RED, width: 1 }, "nothing drawn"],
      [{ kind: "note", page: 0, at: [5, 5], text: "   ", color: RED }, "Type some text"],
      [{ kind: "line", page: 0, from: [5, 5], to: [5.2, 5], color: RED, width: 1 }, "too short"],
      [{ kind: "text", page: 0, rect: [0, 0, 50, 50], text: "x", color: RED, size: 1 }, "size"],
      [{ kind: "whiteout", page: 3, rect: [0, 0, 50, 50] }, "doesn't exist"],
      [
        { kind: "line", page: 0, from: [Number.NaN, 0], to: [9, 9], color: RED, width: 1 },
        "isn't valid",
      ],
    ];
    for (const [spec, message] of bad) expect(() => engine.addAnnotation(spec)).toThrow(message);
    expect(engine.history().canUndo).toBe(false);
    expect(subtypes(engine.save())).toEqual([]);
  });
});
