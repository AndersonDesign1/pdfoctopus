// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Listing, moving, resizing, recolouring, editing and deleting annotations that are already
// on a page: each is one undoable step, and the saved file is still valid.

import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { type AnnotationInfo, createBlankPdf, PdfEngine } from "./engine";

type Rgb = [number, number, number];
type Rect = [number, number, number, number];
const RED: Rgb = [1, 0, 0];
const BLUE: Rgb = [0, 0, 1];

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

const isWhite = ([r, g, b]: Rgb) => r > 240 && g > 240 && b > 240;

/** A page with one line of text, for highlights. */
function textPdf(rotate: 0 | 90 | 180 | 270 = 0): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  try {
    const font = pdf.addSimpleFont(new mupdf.Font("Helvetica"));
    const resources = pdf.newDictionary();
    const fonts = pdf.newDictionary();
    fonts.put("F1", font);
    resources.put("Font", fonts);
    const content = "BT /F1 18 Tf 40 220 Td (The quick brown fox jumps) Tj ET";
    pdf.insertPage(-1, pdf.addPage([0, 0, 400, 300], rotate, resources, content));
    return pdf.saveToBuffer("").asUint8Array().slice();
  } finally {
    pdf.destroy();
  }
}

/** A 20×20 PNG, solid red. */
function redPng(): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 20], false);
  try {
    pix.clear(0);
    const px = pix.getPixels();
    for (let i = 0; i < px.length; i += 3) px[i] = 255;
    return pix.asPNG();
  } finally {
    pix.destroy();
  }
}

function only(engine: PdfEngine, page = 0): AnnotationInfo {
  const list = engine.listAnnotations(page);
  expect(list).toHaveLength(1);
  return list[0] as AnnotationInfo;
}

function shifted([x0, y0, x1, y1]: Rect, dx: number, dy: number): Rect {
  return [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
}

function expectRect(actual: Rect, expected: Rect, within = 0.01) {
  actual.forEach((v, i) => {
    expect(Math.abs(v - (expected[i] as number))).toBeLessThanOrEqual(within);
  });
}

/** Opens saved bytes, checks MuPDF didn't need to repair them, and lists page 0. */
function reopen(bytes: Uint8Array): AnnotationInfo[] {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    expect((doc.asPDF() as mupdf.PDFDocument).wasRepaired()).toBe(false);
  } finally {
    doc.destroy();
  }
  return open(bytes).listAnnotations(0);
}

function rectangle(engine: PdfEngine, rect: Rect = [40, 40, 120, 100], color: Rgb = RED) {
  engine.addAnnotation({ kind: "rectangle", page: 0, rect, color, width: 4 });
}

describe("listAnnotations", () => {
  it("lists what was added, with names people use, and leaves out pop-ups", () => {
    const engine = open(textPdf());
    engine.addAnnotation({ kind: "highlight", page: 0, from: [41, 75], to: [200, 75], color: RED });
    rectangle(engine);
    engine.addAnnotation({ kind: "note", page: 0, at: [300, 20], text: "Check", color: RED });
    engine.addAnnotation({
      kind: "text",
      page: 0,
      rect: [200, 150, 380, 180],
      text: "Hello",
      color: BLUE,
      size: 12,
    });
    engine.addAnnotation({ kind: "whiteout", page: 0, rect: [10, 250, 60, 290] });
    engine.addAnnotation({
      kind: "arrow",
      page: 0,
      from: [10, 10],
      to: [60, 30],
      color: RED,
      width: 2,
    });
    engine.addImageStamp({
      page: 0,
      rect: [300, 200, 360, 240],
      image: redPng(),
      kind: "signature",
    });

    const list = engine.listAnnotations(0);
    expect(list.map((a) => a.label)).toEqual([
      "highlight",
      "rectangle",
      "note",
      "text box",
      "white-out box",
      "arrow",
      "signature",
    ]);
    const byLabel = Object.fromEntries(list.map((a) => [a.label, a]));
    expect(byLabel.note?.text).toBe("Check");
    expect(byLabel["text box"]?.text).toBe("Hello");
    expect(byLabel.rectangle?.text).toBeNull();
    expect(byLabel.rectangle?.color).toEqual(RED);
    // The box is where it was drawn, give or take the border.
    expectRect(byLabel.rectangle?.rect as Rect, [40, 40, 120, 100], 3);
    expectRect(byLabel.signature?.rect as Rect, [300, 200, 360, 240]);
    expect(byLabel.signature).toMatchObject({ canResize: true, canRecolor: false });
    expect(byLabel.highlight).toMatchObject({ canResize: false, canRecolor: true });
    expect(byLabel["white-out box"]).toMatchObject({ canResize: true, canRecolor: false });
    expect(byLabel.note).toMatchObject({ canEditText: true, canResize: false });
  });

  it("reports boxes as the page is shown on a rotated page", () => {
    const engine = open(createBlankPdf(1, 400, 300));
    engine.rotatePages([0], 90); // Now shown 300 wide and 400 tall.
    engine.addImageStamp({ page: 0, rect: [20, 300, 80, 380], image: redPng(), kind: "image" });
    expectRect(only(engine).rect, [20, 300, 80, 380]);
  });
});

describe("moving", () => {
  it("moves a rectangle and its drawing, as one undoable step", () => {
    const engine = open(createBlankPdf(1, 400, 300));
    rectangle(engine);
    const before = only(engine);
    expect(isWhite(pixel(engine, 0, 40, 70))).toBe(false); // the left edge

    const result = engine.editAnnotation(0, before.id, { rect: shifted(before.rect, 200, 100) });
    expect(result.history.undoLabel).toBe("Move rectangle");
    expectRect(only(engine).rect, shifted(before.rect, 200, 100));
    expect(isWhite(pixel(engine, 0, 40, 70))).toBe(true);
    expect(isWhite(pixel(engine, 0, 240, 170))).toBe(false);

    engine.undo();
    expectRect(only(engine).rect, before.rect);
    expect(isWhite(pixel(engine, 0, 40, 70))).toBe(false);
    engine.redo();
    expectRect(only(engine).rect, shifted(before.rect, 200, 100));
  });

  it.each([90, 180, 270] as const)("moves the right way on a page rotated %i°", (rotation) => {
    const engine = open(createBlankPdf(1, 400, 300));
    engine.rotatePages([0], rotation);
    engine.addImageStamp({ page: 0, rect: [20, 20, 60, 50], image: redPng(), kind: "image" });
    const before = only(engine);
    engine.editAnnotation(0, before.id, { rect: shifted(before.rect, 30, 40) });
    expectRect(only(engine).rect, shifted(before.rect, 30, 40));
    expect(pixel(engine, 0, 70, 80)).toEqual([255, 0, 0]);
    expect(isWhite(pixel(engine, 0, 25, 25))).toBe(true);
  });

  it("moves a highlight's marked area, a drawing's strokes and a note's pop-up", () => {
    const engine = open(textPdf());
    engine.addAnnotation({ kind: "highlight", page: 0, from: [41, 75], to: [200, 75], color: RED });
    engine.addAnnotation({
      kind: "ink",
      page: 0,
      strokes: [
        [
          [20, 150],
          [80, 180],
        ],
      ],
      color: BLUE,
      width: 3,
    });
    engine.addAnnotation({ kind: "note", page: 0, at: [300, 20], text: "Hi", color: RED });
    for (const a of engine.listAnnotations(0)) {
      engine.editAnnotation(0, a.id, { rect: shifted(a.rect, 0, 50) });
    }
    const doc = mupdf.Document.openDocument(engine.save(), "application/pdf");
    try {
      const annots = (doc.asPDF() as mupdf.PDFDocument).findPage(0).get("Annots");
      const byType = new Map<string, mupdf.PDFObject>();
      for (let i = 0; i < annots.length; i++) {
        byType.set(annots.get(i).get("Subtype").asName(), annots.get(i));
      }
      // PDF space has y going up, so moving down the page lowers every y by 50.
      const ys = (list: mupdf.PDFObject) =>
        Array.from({ length: list.length / 2 }, (_, i) => list.get(i * 2 + 1).asNumber());
      const rectTop = (o: mupdf.PDFObject) => o.get("Rect").get(3).asNumber();
      const quadYs = ys(byType.get("Highlight")?.get("QuadPoints") as mupdf.PDFObject);
      expect(Math.max(...quadYs)).toBeLessThan(300 - 50 - 60 + 5);
      const inkYs = ys(byType.get("Ink")?.get("InkList").get(0) as mupdf.PDFObject);
      expect(inkYs.map((y) => Math.round(y))).toEqual([100, 70]);
      const note = byType.get("Text") as mupdf.PDFObject;
      const popup = byType.get("Popup") as mupdf.PDFObject;
      expect(Math.round(rectTop(note))).toBe(300 - 70);
      expect(Math.round(rectTop(popup))).toBeLessThan(300 - 50);
    } finally {
      doc.destroy();
    }
  });

  it("keeps a signature's own appearance when it's moved or resized", () => {
    const engine = open(createBlankPdf(1, 400, 300));
    engine.addImageStamp({ page: 0, rect: [20, 20, 60, 60], image: redPng(), kind: "signature" });
    const before = only(engine);
    engine.editAnnotation(0, before.id, { rect: [100, 100, 200, 200] });
    expect(engine.history().undoLabel).toBe("Resize signature");
    expectRect(only(engine).rect, [100, 100, 200, 200]);
    // The image fills the new box: no stock "DRAFT" stamp was drawn in its place.
    expect(pixel(engine, 0, 105, 105)).toEqual([255, 0, 0]);
    expect(pixel(engine, 0, 195, 195)).toEqual([255, 0, 0]);
    expect(isWhite(pixel(engine, 0, 30, 30))).toBe(true);
  });
});

describe("resizing, recolouring and editing text", () => {
  it("redraws a resized rectangle at its new size, and undo brings the old one back", () => {
    const engine = open(createBlankPdf(1, 400, 300));
    rectangle(engine);
    const before = only(engine);
    engine.editAnnotation(0, before.id, { rect: [40, 40, 300, 250] });
    expectRect(only(engine).rect, [40, 40, 300, 250]);
    expect(isWhite(pixel(engine, 0, 299, 150))).toBe(false); // new right edge
    expect(isWhite(pixel(engine, 0, 120, 70))).toBe(true); // old right edge
    engine.undo();
    expectRect(only(engine).rect, before.rect);
    expect(isWhite(pixel(engine, 0, 299, 150))).toBe(true);
    expect(isWhite(pixel(engine, 0, 119, 70))).toBe(false);
  });

  it("recolours a rectangle, and undo restores the old drawing exactly", () => {
    const engine = open(createBlankPdf(1, 400, 300));
    rectangle(engine);
    const { id } = only(engine);
    const red = pixel(engine, 0, 41, 70);
    engine.editAnnotation(0, id, { color: BLUE });
    expect(engine.history().undoLabel).toBe("Recolour rectangle");
    expect(only(engine).color).toEqual(BLUE);
    const blue = pixel(engine, 0, 41, 70);
    expect(blue[2]).toBeGreaterThan(200);
    expect(blue[0]).toBeLessThan(50);
    engine.undo();
    expect(only(engine).color).toEqual(RED);
    expect(pixel(engine, 0, 41, 70)).toEqual(red);
    engine.redo();
    expect(pixel(engine, 0, 41, 70)).toEqual(blue);
  });

  it("recolours a text box's text", () => {
    const engine = open(createBlankPdf(1, 400, 300));
    engine.addAnnotation({
      kind: "text",
      page: 0,
      rect: [20, 20, 380, 80],
      text: "MMMMMMMM",
      color: [0, 0, 0],
      size: 36,
    });
    const { id } = only(engine);
    engine.editAnnotation(0, id, { color: RED });
    const { pixels } = engine.renderPage(0, 1);
    let reddish = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if ((pixels[i] as number) > 200 && (pixels[i + 1] as number) < 80) reddish++;
    }
    expect(reddish).toBeGreaterThan(50);
  });

  it("changes a note's and a text box's text", () => {
    const engine = open(createBlankPdf(1, 400, 300));
    engine.addAnnotation({ kind: "note", page: 0, at: [20, 20], text: "Old", color: RED });
    engine.addAnnotation({
      kind: "text",
      page: 0,
      rect: [100, 100, 300, 140],
      text: "Old",
      color: [0, 0, 0],
      size: 12,
    });
    for (const a of engine.listAnnotations(0)) engine.editAnnotation(0, a.id, { text: "New" });
    expect(engine.listAnnotations(0).map((a) => a.text)).toEqual(["New", "New"]);
    expect(engine.history().undoLabel).toBe("Edit text box");
    engine.undo();
    expect(engine.listAnnotations(0).map((a) => a.text)).toEqual(["New", "Old"]);
  });

  it("refuses changes an annotation can't take, leaving it untouched", () => {
    const engine = open(textPdf());
    engine.addAnnotation({ kind: "highlight", page: 0, from: [41, 75], to: [200, 75], color: RED });
    engine.addImageStamp({ page: 0, rect: [20, 20, 60, 60], image: redPng(), kind: "signature" });
    const [highlight, signature] = engine.listAnnotations(0) as [AnnotationInfo, AnnotationInfo];
    const history = engine.history();

    expect(() => engine.editAnnotation(0, highlight.id, { rect: [0, 0, 300, 200] })).toThrow(
      /can't be resized/,
    );
    expect(() => engine.editAnnotation(0, signature.id, { color: BLUE })).toThrow(/colour/);
    expect(() => engine.editAnnotation(0, signature.id, { text: "x" })).toThrow(/no text/);
    expect(() =>
      engine.editAnnotation(0, signature.id, { rect: shifted(signature.rect, 500, 0) }),
    ).toThrow(/stay on the page/);
    expect(() => engine.editAnnotation(0, 99999, { color: BLUE })).toThrow(/not on the page/);
    expect(() => engine.deleteAnnotation(0, 99999)).toThrow(/not on the page/);
    expect(() => engine.editAnnotation(0, highlight.id, { color: [2, 0, 0] })).toThrow();

    expect(engine.history()).toEqual(history);
    expect(engine.listAnnotations(0)).toEqual([highlight, signature]);
  });

  it("records nothing when a change changes nothing", () => {
    const engine = open(createBlankPdf(1, 400, 300));
    rectangle(engine);
    const a = only(engine);
    engine.editAnnotation(0, a.id, { rect: a.rect, color: RED });
    expect(engine.history().undoLabel).toBe("Add rectangle");
  });
});

describe("deleteAnnotation", () => {
  it("deletes an annotation, and undo puts it back in the same place in the stack", () => {
    const engine = open(createBlankPdf(1, 400, 300));
    rectangle(engine, [10, 10, 50, 50]);
    engine.addAnnotation({ kind: "note", page: 0, at: [100, 20], text: "Hi", color: RED });
    rectangle(engine, [200, 10, 250, 50], BLUE);
    const [first, note, last] = engine.listAnnotations(0) as AnnotationInfo[];

    const result = engine.deleteAnnotation(0, (note as AnnotationInfo).id);
    expect(result.history.undoLabel).toBe("Delete note");
    expect(engine.listAnnotations(0)).toEqual([first, last]);
    // Its pop-up went with it.
    const saved = engine.save();
    const doc = mupdf.Document.openDocument(saved, "application/pdf");
    expect((doc.asPDF() as mupdf.PDFDocument).findPage(0).get("Annots").length).toBe(2);
    doc.destroy();

    engine.undo();
    expect(engine.listAnnotations(0)).toEqual([first, note, last]);
    engine.redo();
    expect(engine.listAnnotations(0)).toEqual([first, last]);
  });

  it("deletes a signature that was saved in an earlier session", () => {
    const first = open(createBlankPdf(1, 400, 300));
    first.addImageStamp({ page: 0, rect: [20, 20, 60, 60], image: redPng(), kind: "signature" });
    const signed = first.save();

    const engine = open(signed);
    const { id, label } = only(engine);
    expect(label).toBe("signature");
    engine.deleteAnnotation(0, id);
    expect(isWhite(pixel(engine, 0, 40, 40))).toBe(true);
    expect(reopen(engine.save())).toEqual([]);
  });
});

describe("saving edited annotations", () => {
  it("keeps every edit through repeated saves, and an undone edit stays undone", () => {
    const engine = open(createBlankPdf(1, 400, 300));
    rectangle(engine);
    const { id, rect } = only(engine);
    engine.save();
    engine.editAnnotation(0, id, { rect: shifted(rect, 100, 0) });
    engine.editAnnotation(0, id, { color: BLUE });
    const saved = reopen(engine.save());
    expect(saved).toHaveLength(1);
    expectRect((saved[0] as AnnotationInfo).rect, shifted(rect, 100, 0));
    expect((saved[0] as AnnotationInfo).color).toEqual(BLUE);

    engine.undo(); // the colour
    const again = reopen(engine.save());
    expect((again[0] as AnnotationInfo).color).toEqual(RED);
    expectRect((again[0] as AnnotationInfo).rect, shifted(rect, 100, 0));
  });

  it("moves annotations that were in the file before it was opened", () => {
    const first = open(textPdf(90));
    first.addAnnotation({ kind: "ellipse", page: 0, rect: [20, 20, 80, 60], color: RED, width: 2 });
    const bytes = first.save();
    const engine = open(bytes);
    const a = only(engine);
    expect(a.label).toBe("ellipse");
    engine.editAnnotation(0, a.id, { rect: shifted(a.rect, 50, 50) });
    const saved = engine.save();
    expect(saved.subarray(0, bytes.length)).toEqual(bytes); // still an incremental save
    expectRect((reopen(saved)[0] as AnnotationInfo).rect, shifted(a.rect, 50, 50));
  });
});
