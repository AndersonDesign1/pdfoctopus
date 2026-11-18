// SPDX-License-Identifier: AGPL-3.0-or-later

import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { createBlankPdf, PdfEngine, type TextStamp } from "./engine";
import { cleanStampText, layoutStamp, stampName } from "./stampRules";

type Rgb = [number, number, number];
const RED: Rgb = [0.8, 0.1, 0.1];

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

function stamp(overrides: Partial<TextStamp> = {}): TextStamp {
  return { page: 0, rect: [20, 20, 180, 80], text: "APPROVED", color: RED, ...overrides };
}

/** The pixels of part of a page rendered at 72 dpi, as RGB triples. */
function crop(engine: PdfEngine, [x0, y0, x1, y1]: number[]): number[] {
  const { width, pixels } = engine.renderPage(0, 1);
  const out: number[] = [];
  for (let y = y0 as number; y < (y1 as number); y++) {
    for (let x = x0 as number; x < (x1 as number); x++) {
      const i = (y * width + x) * 4;
      out.push(pixels[i] as number, pixels[i + 1] as number, pixels[i + 2] as number);
    }
  }
  return out;
}

/** How many pixels in an area are clearly the stamp's red. */
function redPixels(engine: PdfEngine, area: number[]): number {
  const px = crop(engine, area);
  let n = 0;
  for (let i = 0; i < px.length; i += 3) {
    if ((px[i] as number) > 150 && (px[i + 1] as number) < 110 && (px[i + 2] as number) < 110) n++;
  }
  return n;
}

function savedStamp(bytes: Uint8Array): { name: string; contents: string; repaired: boolean } {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    const annot = pdf.findPage(0).get("Annots").get(0);
    return {
      name: annot.get("Name").asName(),
      contents: annot.get("Contents").asString(),
      repaired: pdf.wasRepaired(),
    };
  } finally {
    doc.destroy();
  }
}

describe("addTextStamp", () => {
  it("draws the stamp inside its box, as one undoable step", () => {
    const engine = open(createBlankPdf(1, 300, 400));
    const result = engine.addTextStamp(stamp());
    expect(result.history.undoLabel).toBe("Add stamp");
    expect(redPixels(engine, [20, 20, 180, 80])).toBeGreaterThan(300);
    expect(redPixels(engine, [0, 90, 300, 400])).toBe(0);
    const [listed] = engine.listAnnotations(0);
    expect(listed?.label).toBe("stamp");
    expect(listed?.rect).toEqual([20, 20, 180, 80]);

    engine.undo();
    expect(redPixels(engine, [20, 20, 180, 80])).toBe(0);
    engine.redo();
    expect(redPixels(engine, [20, 20, 180, 80])).toBeGreaterThan(300);
  });

  it("uses the standard name for standard stamps, and saves the text for readers", () => {
    const engine = open(createBlankPdf(1, 300, 400));
    engine.addTextStamp(stamp({ text: "Approved", detail: "18 November 2026" }));
    const saved = savedStamp(engine.save());
    expect(saved).toEqual({
      name: "Approved",
      contents: "Approved\n18 November 2026",
      repaired: false,
    });
    expect(stampName("not  approved")).toBe("NotApproved");
    expect(stampName("Paid")).toBe("PDFoctopusStamp");
    // Spaces are tidied the same way for the drawing, the name and the preview.
    expect(cleanStampText("  A     B \n C ")).toBe("A B C");
  });

  it.each([90, 180, 270] as const)("reads the right way up on a page rotated %i°", (rotation) => {
    // A page shown 300 × 400 either way: one rotated, one not.
    const shown = open(createBlankPdf(1, 300, 400));
    shown.addTextStamp(stamp({ detail: "18 Nov 2026" }));
    const rotated = open(
      createBlankPdf(1, rotation === 180 ? 300 : 400, rotation === 180 ? 400 : 300),
    );
    rotated.rotatePages([0], rotation);
    rotated.addTextStamp(stamp({ detail: "18 Nov 2026" }));
    const a = crop(shown, [20, 20, 180, 80]);
    const b = crop(rotated, [20, 20, 180, 80]);
    let differing = 0;
    for (let i = 0; i < a.length; i++)
      if (Math.abs((a[i] as number) - (b[i] as number)) > 40) differing++;
    expect(differing / a.length).toBeLessThan(0.01);
  });

  it("fits the stamp in a box of another shape without stretching it", () => {
    const engine = open(createBlankPdf(1, 300, 400));
    // Much taller than the stamp: it's drawn at the box's width, in the middle.
    engine.addTextStamp(stamp({ rect: [20, 20, 180, 300] }));
    expect(redPixels(engine, [20, 20, 180, 120])).toBe(0);
    expect(redPixels(engine, [20, 120, 180, 200])).toBeGreaterThan(300);
  });

  it("refuses text the standard fonts can't show, or none, leaving the page untouched", () => {
    const engine = open(createBlankPdf(1, 300, 400));
    expect(() => engine.addTextStamp(stamp({ text: "  " }))).toThrow(/needs some text/);
    expect(() => engine.addTextStamp(stamp({ text: "OK ✓" }))).toThrow(/can't include "✓"/);
    expect(() => engine.addTextStamp(stamp({ text: "承認" }))).toThrow(/can't include/);
    expect(() => engine.addTextStamp(stamp({ text: "X".repeat(41) }))).toThrow(/too long/);
    // The second line has its own limits.
    expect(() => engine.addTextStamp(stamp({ detail: "Y".repeat(61) }))).toThrow(
      /second line is too long/,
    );
    expect(() => engine.addTextStamp(stamp({ detail: "18 ✓ 2026" }))).toThrow(
      /second line can't include "✓"/,
    );
    expect(() => engine.addTextStamp(stamp({ rect: [200, 20, 400, 80] }))).toThrow(
      /inside the page/,
    );
    expect(() => engine.addTextStamp(stamp({ color: [2, 0, 0] }))).toThrow();
    expect(engine.listAnnotations(0)).toEqual([]);
    expect(engine.history().canUndo).toBe(false);
    // Accented Latin letters are fine.
    engine.addTextStamp(stamp({ text: "Payé", detail: "Reçu — non".replace("—", "-") }));
    expect(engine.listAnnotations(0)).toHaveLength(1);
  });

  it("can be moved and resized afterwards, keeping its look", () => {
    const engine = open(createBlankPdf(1, 300, 400));
    engine.addTextStamp(stamp());
    const [a] = engine.listAnnotations(0);
    engine.editAnnotation(0, a?.id as number, { rect: [20, 200, 340 / 2, 260] });
    expect(redPixels(engine, [20, 20, 180, 80])).toBe(0);
    expect(redPixels(engine, [20, 200, 170, 260])).toBeGreaterThan(200);
  });
});

describe("layoutStamp", () => {
  it("makes room for the second line and centres both lines", () => {
    const one = layoutStamp(5, null);
    const two = layoutStamp(5, 8);
    expect(two.height).toBeGreaterThan(one.height);
    expect(one.detail).toBeNull();
    expect(two.main.x).toBeCloseTo((two.width - 5 * two.main.size) / 2);
    expect(two.detail?.x).toBeCloseTo((two.width - 8 * (two.detail?.size ?? 0)) / 2);
  });
});
