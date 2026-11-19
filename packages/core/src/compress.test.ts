// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Compress: a smaller copy with pictures scaled down (and left alone where re-encoding would
// be unsafe), the open document left as it was, and passwords carried over or refused.

import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { PdfEngine } from "./engine";
import { ALL_PERMISSIONS } from "./security";

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

/** A pixmap of noise-like colour, which compresses poorly losslessly (as photos do). */
function photo(width: number, height: number, gray = false): mupdf.Pixmap {
  const cs = gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
  const pix = new mupdf.Pixmap(cs, [0, 0, width, height], false);
  const px = pix.getPixels();
  let seed = 1;
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // Smooth gradients plus a little noise.
    px[i] = ((i / 3) % width) / 4 + ((seed >> 16) & 31);
  }
  return pix;
}

/**
 * A one-page letter PDF showing pictures: a big photo stored losslessly, optionally a photo
 * with a soft mask, and a 1-bit picture (like a scan).
 */
function pdfWithPictures(options: { mask?: boolean; bilevel?: boolean } = {}): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  const resources = pdf.newDictionary();
  const xobjects = pdf.newDictionary();
  resources.put("XObject", xobjects);
  let content = "";

  const big = pdf.addImage(new mupdf.Image(photo(2400, 3000)));
  xobjects.put("Big", big);
  content += "q 612 0 0 792 0 0 cm /Big Do Q\n";

  if (options.mask) {
    const mask = new mupdf.Image(photo(1600, 1600, true));
    const masked = pdf.addImage(new mupdf.Image(photo(1600, 1600), mask));
    xobjects.put("Masked", masked);
    content += "q 200 0 0 200 50 50 cm /Masked Do Q\n";
  }
  if (options.bilevel) {
    // An uncompressed 1-bit picture, 2000x2000.
    const dict = pdf.newDictionary();
    dict.put("Type", pdf.newName("XObject"));
    dict.put("Subtype", pdf.newName("Image"));
    dict.put("Width", 2000);
    dict.put("Height", 2000);
    dict.put("BitsPerComponent", 1);
    dict.put("ColorSpace", pdf.newName("DeviceGray"));
    const data = new Uint8Array((2000 / 8) * 2000).map((_, i) => (i % 7 === 0 ? 0xaa : 0xff));
    xobjects.put("Scan", pdf.addStream(data, dict));
    content += "q 100 0 0 100 400 600 cm /Scan Do Q\n";
  }
  content += "BT /F1 24 Tf 72 72 Td (Quarterly report) Tj ET";
  const fonts = pdf.newDictionary();
  fonts.put("F1", pdf.addSimpleFont(new mupdf.Font("Helvetica")));
  resources.put("Font", fonts);
  pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, resources, content));
  const out = pdf.saveToBuffer("compress").asUint8Array().slice();
  pdf.destroy();
  return out;
}

/** Every picture in a saved file: its size and filter. */
function pictures(bytes: Uint8Array) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const pdf = doc.asPDF() as mupdf.PDFDocument;
  expect(pdf.wasRepaired()).toBe(false);
  const found: { w: number; h: number; filter: string; bpc: number }[] = [];
  for (let i = 1; i < pdf.countObjects(); i++) {
    const o = pdf.newIndirect(i);
    if (!o.isStream() || o.get("Subtype").toString() !== "/Image") continue;
    found.push({
      w: o.get("Width").asNumber(),
      h: o.get("Height").asNumber(),
      filter: o.get("Filter").toString(),
      bpc: o.get("BitsPerComponent").asNumber(),
    });
  }
  const text = doc.loadPage(0).toStructuredText("preserve-whitespace").asText();
  doc.destroy();
  return { found: found.sort((a, b) => b.w * b.h - a.w * a.h), text };
}

describe("compressedCopy", () => {
  it("scales big pictures down for 'smallest', keeping the text, and changes nothing open", () => {
    const original = pdfWithPictures();
    const engine = open(original.slice());
    const result = engine.compressedCopy("smallest");
    expect(result.images).toBe(1);
    expect(result.bytes.length).toBeLessThan(original.length / 4);
    const { found, text } = pictures(result.bytes);
    // 120 dpi over an 11-inch page: at most 1320 pixels on the long side.
    expect(Math.max(found[0]?.w ?? 0, found[0]?.h ?? 0)).toBeLessThanOrEqual(1320);
    expect(found[0]?.filter).toBe("/DCTDecode");
    expect(text).toContain("Quarterly report");

    // The open document still has the full-size picture.
    expect(engine.history().canUndo).toBe(false);
    expect(pictures(engine.save({ incremental: false })).found[0]).toMatchObject({ w: 2400 });
  });

  it("'balanced' keeps more detail than 'smallest'", () => {
    const engine = open(pdfWithPictures());
    const balanced = pictures(engine.compressedCopy("balanced").bytes).found[0];
    const smallest = pictures(engine.compressedCopy("smallest").bytes).found[0];
    expect(balanced?.h).toBeGreaterThan(smallest?.h ?? Infinity);
    expect(balanced?.h).toBeLessThanOrEqual(2200); // 200 dpi over 11 inches
  });

  it("leaves pictures exactly as they are for 'high'", () => {
    const engine = open(pdfWithPictures());
    const result = engine.compressedCopy("high");
    expect(result.images).toBe(0);
    expect(pictures(result.bytes).found[0]).toMatchObject({ w: 2400, h: 3000 });
  });

  it("leaves masks and 1-bit pictures alone", () => {
    const engine = open(pdfWithPictures({ mask: true, bilevel: true }));
    const { found } = pictures(engine.compressedCopy("smallest").bytes);
    // The soft mask keeps its exact size; the 1-bit picture stays 1-bit.
    expect(found.some((p) => p.w === 1600 && p.h === 1600)).toBe(true);
    expect(found.some((p) => p.bpc === 1 && p.w === 2000)).toBe(true);
  });

  it("includes unsaved changes", () => {
    const engine = open(pdfWithPictures());
    engine.rotatePages([0], 90);
    const doc = mupdf.Document.openDocument(engine.compressedCopy("high").bytes, "application/pdf");
    expect((doc.asPDF() as mupdf.PDFDocument).findPage(0).get("Rotate").asNumber()).toBe(90);
    doc.destroy();
  });

  it("protects the copy with a password set in the Password dialog", () => {
    const engine = open(pdfWithPictures());
    engine.setPassword({ openPassword: "reader", permissions: ALL_PERMISSIONS });
    const doc = mupdf.Document.openDocument(
      engine.compressedCopy("smallest").bytes,
      "application/pdf",
    );
    expect(doc.needsPassword()).toBe(true);
    expect(doc.authenticatePassword("reader")).not.toBe(0);
    doc.destroy();
  });

  it("refuses a file with a password that isn't being changed, and allows removing it", () => {
    const first = open(pdfWithPictures());
    first.setPassword({ openPassword: "reader", permissions: ALL_PERMISSIONS });
    const engine = open(first.save());
    engine.authenticate("reader");
    expect(() => engine.compressedCopy("high")).toThrow(/has a password/);
    engine.removePassword();
    const doc = mupdf.Document.openDocument(engine.compressedCopy("high").bytes, "application/pdf");
    expect(doc.needsPassword()).toBe(false);
    doc.destroy();
  });
});
