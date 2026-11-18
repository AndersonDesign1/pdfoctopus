// SPDX-License-Identifier: AGPL-3.0-or-later

import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { createBlankPdf, type ImageStamp, PdfEngine } from "./engine";

type Rgb = [number, number, number];
const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const WHITE: Rgb = [255, 255, 255];

/**
 * A 120×60 PNG, transparent except for a red bar along its top edge and a blue bar down
 * its left edge, so a render shows which way up it is.
 */
function markerPng(): Uint8Array {
  const w = 120;
  const h = 60;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], true);
  try {
    const px = pix.getPixels();
    const stride = pix.getStride();
    px.fill(0);
    const paint = (x: number, y: number, [r, g, b]: Rgb) => {
      const i = y * stride + x * 4;
      px.set([r, g, b, 255], i);
    };
    for (let x = 0; x < w; x++) for (let y = 0; y < 10; y++) paint(x, y, RED);
    for (let y = 10; y < h; y++) for (let x = 0; x < 10; x++) paint(x, y, BLUE);
    return pix.asPNG();
  } finally {
    pix.destroy();
  }
}

function open(bytes: Uint8Array): PdfEngine {
  const engine = new PdfEngine();
  engine.open(bytes);
  return engine;
}

/** Colour of the pixel at (x, y) points on a page rendered at 72 dpi. */
function pixel(engine: PdfEngine, page: number, x: number, y: number): Rgb {
  const { width, pixels } = engine.renderPage(page, 1);
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2]] as Rgb;
}

function stamp(overrides: Partial<ImageStamp> = {}): ImageStamp {
  return { page: 0, rect: [40, 40, 160, 100], image: markerPng(), kind: "signature", ...overrides };
}

/** The stamp annotations on a page of a saved file. */
function stampsIn(bytes: Uint8Array, page = 0): mupdf.PDFObject[] {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const annots = doc.asPDF()?.findPage(page).get("Annots");
  const out: mupdf.PDFObject[] = [];
  if (annots?.isArray()) {
    for (let i = 0; i < annots.length; i++) {
      const a = annots.get(i).resolve();
      if (a.get("Subtype").asName() === "Stamp") out.push(a);
    }
  }
  return out;
}

describe("addImageStamp", () => {
  it("puts the image where asked, keeping its transparent parts see-through", () => {
    const engine = open(createBlankPdf(1, 300, 400));
    const result = engine.addImageStamp(stamp());
    expect(result.history).toMatchObject({ canUndo: true, undoLabel: "Add signature" });
    expect(pixel(engine, 0, 100, 44)).toEqual(RED); // top bar
    expect(pixel(engine, 0, 44, 90)).toEqual(BLUE); // left bar
    expect(pixel(engine, 0, 120, 80)).toEqual(WHITE); // transparent middle
    expect(pixel(engine, 0, 20, 20)).toEqual(WHITE); // outside the stamp
  });

  it.each([90, 180, 270])("shows the image upright on a page rotated %i°", (rotation) => {
    const engine = open(createBlankPdf(1, 300, 400));
    // Rotate the page first, then stamp it as it's shown.
    engine.rotatePages([0], rotation as 90 | 180 | 270);
    engine.addImageStamp(stamp());
    expect(pixel(engine, 0, 100, 44)).toEqual(RED);
    expect(pixel(engine, 0, 44, 90)).toEqual(BLUE);
    expect(pixel(engine, 0, 120, 80)).toEqual(WHITE);
    // Still upright after saving and opening the file again.
    const reopened = open(engine.save());
    expect(pixel(reopened, 0, 100, 44)).toEqual(RED);
    expect(pixel(reopened, 0, 44, 90)).toEqual(BLUE);
  });

  it("measures from the visible top-left corner when the page box doesn't start at 0", () => {
    const pdf = new mupdf.PDFDocument();
    pdf.insertPage(-1, pdf.addPage([50, 80, 350, 480], 0, pdf.newDictionary(), ""));
    const bytes = pdf.saveToBuffer("").asUint8Array().slice();
    pdf.destroy();
    const engine = open(bytes);
    engine.addImageStamp(stamp());
    expect(pixel(engine, 0, 100, 44)).toEqual(RED);
    expect(pixel(engine, 0, 44, 90)).toEqual(BLUE);
  });

  it("undoes and redoes, without adding copies of the image to the file", () => {
    const engine = open(createBlankPdf(1, 300, 400));
    engine.addImageStamp(stamp());
    const once = engine.save().byteLength;
    expect(engine.undo()?.history).toMatchObject({ canUndo: false, redoLabel: "Add signature" });
    expect(pixel(engine, 0, 100, 44)).toEqual(WHITE);
    expect(stampsIn(engine.save())).toHaveLength(0);
    for (let i = 0; i < 5; i++) {
      engine.redo();
      engine.undo();
    }
    engine.redo();
    expect(pixel(engine, 0, 100, 44)).toEqual(RED);
    const saved = engine.save();
    expect(stampsIn(saved)).toHaveLength(1);
    // Allow for the Annots array being rewritten, but not for more images.
    expect(saved.byteLength).toBeLessThan(once + 200);
  });

  it("only appends to the file, and saves a printable, locked stamp with a description", () => {
    const original = createBlankPdf(2, 300, 400);
    const engine = open(original.slice());
    engine.addImageStamp(stamp({ page: 1, kind: "date", text: "18 Nov 2026" }));
    const saved = engine.save();
    expect(saved.subarray(0, original.byteLength)).toEqual(original);
    expect(stampsIn(saved, 0)).toHaveLength(0);
    const [annot] = stampsIn(saved, 1);
    expect(annot?.get("F").asNumber()).toBe(4 | 128);
    expect(annot?.get("Contents").asString()).toBe("18 Nov 2026");
    expect(annot?.get("Name").asName()).toBe("PDFoctopusDate");
  });

  it("stores the image compressed, so a signature doesn't bloat the file", () => {
    const original = createBlankPdf(1, 300, 400);
    // A large, detailed image (noise doesn't compress, so this is a worst case for size).
    const w = 900;
    const h = 300;
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], true);
    const px = pix.getPixels();
    for (let i = 0; i < px.length; i += 4) px.set([0, 0, (i * 7) % 256, (i * 13) % 256], i);
    const png = pix.asPNG();
    pix.destroy();
    const engine = open(original.slice());
    engine.addImageStamp(stamp({ image: png }));
    const added = engine.save().byteLength - original.byteLength;
    // Raw, the pixels alone would be w*h*4 bytes.
    expect(added).toBeLessThan(png.byteLength + 4096); // the image, plus the annotation itself
    expect(added).toBeLessThan(w * h * 4 * 0.5);
  });

  it("keeps the stamp with its page when pages are moved afterwards", () => {
    const engine = open(createBlankPdf(3, 300, 400));
    engine.addImageStamp(stamp({ page: 0 }));
    engine.movePages([0], 2);
    expect(pixel(engine, 2, 100, 44)).toEqual(RED);
    expect(pixel(engine, 0, 100, 44)).toEqual(WHITE);
    // Undo the move, then the stamp.
    engine.undo();
    engine.undo();
    for (let p = 0; p < 3; p++) expect(pixel(engine, p, 100, 44)).toEqual(WHITE);
  });

  it("refuses bad input without changing the document", () => {
    const engine = open(createBlankPdf(1, 300, 400));
    expect(() => engine.addImageStamp(stamp({ rect: [200, 300, 400, 420] }))).toThrow(
      "inside the page",
    );
    expect(() => engine.addImageStamp(stamp({ rect: [10, 10, 10.5, 50] }))).toThrow("too small");
    expect(() => engine.addImageStamp(stamp({ rect: [0, 0, Number.NaN, 5] }))).toThrow(
      "isn't valid",
    );
    expect(() => engine.addImageStamp(stamp({ page: 3 }))).toThrow("doesn't exist");
    expect(() => engine.addImageStamp(stamp({ image: new Uint8Array() }))).toThrow("empty");
    expect(() =>
      engine.addImageStamp(stamp({ image: new TextEncoder().encode("not an image") })),
    ).toThrow("couldn't be read");
    expect(engine.history().canUndo).toBe(false);
    expect(stampsIn(engine.save())).toHaveLength(0);
  });
});
