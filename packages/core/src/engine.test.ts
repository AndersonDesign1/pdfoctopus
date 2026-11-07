// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { createBlankPdf, PdfEngine } from "./engine";
import { PasswordRequiredError } from "./errors";

const generated = join(import.meta.dirname, "..", "..", "..", "fixtures", "generated");
/** A 300 x 300 pt page whose MediaBox starts at (1000, 2000), with the word "offset". */
function offsetPagePdf(): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  try {
    const font = pdf.addSimpleFont(new mupdf.Font("Helvetica"));
    const resources = pdf.newDictionary();
    const fonts = pdf.newDictionary();
    fonts.put("F1", font);
    resources.put("Font", fonts);
    const page = pdf.addPage(
      [1000, 2000, 1300, 2300],
      0,
      resources,
      "BT /F1 24 Tf 1050 2150 Td (offset) Tj ET",
    );
    pdf.insertPage(-1, page);
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

const fixture = (name: string) => new Uint8Array(readFileSync(join(generated, name)));

describe("PdfEngine", () => {
  it("opens a PDF and reports page count and sizes", () => {
    const engine = new PdfEngine();
    const result = engine.open(createBlankPdf(3, 300, 400));
    expect(result.needsPassword).toBe(false);
    if (result.needsPassword) return;
    expect(result.pageCount).toBe(3);
    expect(result.pages).toEqual([
      { width: 300, height: 400 },
      { width: 300, height: 400 },
      { width: 300, height: 400 },
    ]);
    expect(result.labels).toEqual([null, null, null]);
    engine.close();
  });

  it("renders a page to white RGBA pixels", () => {
    const engine = new PdfEngine();
    engine.open(createBlankPdf(1, 100, 200));
    const page = engine.renderPage(0, 1);
    expect(page.width).toBe(100);
    expect(page.height).toBe(200);
    expect(page.pixels.length).toBe(100 * 200 * 4);
    expect(Array.from(page.pixels.slice(0, 4))).toEqual([255, 255, 255, 255]);
    engine.close();
  });

  it("renders a page to PNG", () => {
    const engine = new PdfEngine();
    engine.open(createBlankPdf(1, 100, 200));
    expect(Array.from(engine.renderPagePng(0, 1).slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    engine.close();
  });

  it("reads document metadata", () => {
    const engine = new PdfEngine();
    const result = engine.open(fixture("invoice.pdf"));
    if (result.needsPassword) throw new Error("unexpected password");
    expect(result.metadata.title).toBe("Invoice INV-2026-0142");
    expect(result.metadata.format).toMatch(/^PDF /);
    expect(result.metadata.encryption).toBeUndefined();
    engine.close();
  });

  it("finds text and returns quads relative to the page", () => {
    const engine = new PdfEngine();
    engine.open(fixture("invoice.pdf"));
    const { hits, truncated } = engine.search("northwind");
    expect(truncated).toBe(false);
    // "Northwind Paper Co." twice and "billing@northwind.example": case doesn't matter.
    expect(hits).toHaveLength(3);
    const info = engine.info();
    const size = info.pages[0] as { width: number; height: number };
    for (const hit of hits) {
      expect(hit.page).toBe(0);
      for (const quad of hit.quads) {
        expect(quad).toHaveLength(8);
        quad.forEach((v, j) => {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(j % 2 === 0 ? size.width : size.height);
        });
      }
    }
    // Accents are ignored too.
    expect(engine.search("NÖRTHWÍND").hits).toHaveLength(3);
    expect(engine.search("   ").hits).toEqual([]);
    expect(engine.search("no such words anywhere").hits).toEqual([]);
    engine.close();
  });

  it("returns highlight boxes relative to a page whose box doesn't start at 0,0", () => {
    // A page whose MediaBox starts at (1000, 2000): absolute coordinates would be huge.
    const engine = new PdfEngine();
    engine.open(offsetPagePdf());
    const { hits } = engine.search("offset");
    expect(hits).toHaveLength(1);
    for (const v of (hits[0] as { quads: number[][] }).quads[0] as number[]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(300);
    }
    engine.close();
  });

  it("requires the password before reading an encrypted file", () => {
    const engine = new PdfEngine();
    expect(engine.open(fixture("encrypted-aes256.pdf"))).toEqual({ needsPassword: true });
    expect(() => engine.renderPage(0)).toThrow(PasswordRequiredError);
    expect(engine.authenticate("wrong")).toBeNull();
    const info = engine.authenticate("open-sesame");
    expect(info?.pageCount).toBe(1);
    expect(info?.metadata.encryption).toBeDefined();
    expect(engine.renderPage(0, 0.5).width).toBeGreaterThan(0);
    engine.close();
  });

  it("incremental save keeps the original bytes identical", () => {
    const original = createBlankPdf(2);
    const engine = new PdfEngine();
    engine.open(original);
    const saved = engine.save();
    expect(saved.length).toBeGreaterThanOrEqual(original.length);
    expect(saved.slice(0, original.length)).toEqual(original);
    engine.close();
  });
});

describe("PdfEngine.save", () => {
  it("rewrites the whole file only when asked", () => {
    const engine = new PdfEngine();
    engine.open(createBlankPdf(1));
    const rewritten = engine.save({ incremental: false });
    expect(new TextDecoder().decode(rewritten.slice(0, 5))).toBe("%PDF-");
    engine.close();
  });
});

describe("errors", () => {
  it("round-trips IncrementalSaveError across the worker boundary", async () => {
    const { IncrementalSaveError, errorCode, errorFromCode } = await import("./errors");
    const original = new IncrementalSaveError();
    const rebuilt = errorFromCode(errorCode(original), original.message);
    expect(rebuilt).toBeInstanceOf(IncrementalSaveError);
    expect(errorFromCode(errorCode(new Error("x")), "x")).not.toBeInstanceOf(IncrementalSaveError);
  });
});
