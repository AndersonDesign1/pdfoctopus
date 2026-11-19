// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Exporting pages as pictures, SVG, text and HTML, and putting them in files (a ZIP when
// there are several).

import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { exportScale, MAX_EXPORT_PIXELS } from "./convert";
import { PdfEngine } from "./engine";
import {
  assembleExport,
  exportFileName,
  exportStem,
  htmlDocument,
  joinText,
  pageFileName,
} from "./exportFiles";
import { ALL_PERMISSIONS } from "./security";
import { crc32, zipFiles } from "./zip";

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

/** A letter-size PDF with a line of text on each page. */
function textPdf(lines: string[]): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  const fonts = pdf.newDictionary();
  fonts.put("F1", pdf.addSimpleFont(new mupdf.Font("Helvetica")));
  for (const line of lines) {
    const resources = pdf.newDictionary();
    resources.put("Font", fonts);
    pdf.insertPage(
      -1,
      pdf.addPage([0, 0, 612, 792], 0, resources, `BT /F1 24 Tf 72 700 Td (${line}) Tj ET`),
    );
  }
  const out = pdf.saveToBuffer("compress").asUint8Array().slice();
  pdf.destroy();
  return out;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Reads a stored ZIP back: each file's name and bytes, checking sizes and CRCs. */
function unzip(zip: Uint8Array): { name: string; bytes: Uint8Array }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const files = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(p, true)).toBe(0x02014b50);
    expect(view.getUint16(p + 8, true) & 0x0800).toBe(0x0800);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const local = view.getUint32(p + 42, true);
    const name = decode(zip.subarray(p + 46, p + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true);
    const bytes = zip.subarray(start, start + size);
    expect(crc32(bytes)).toBe(crc);
    files.push({ name, bytes });
    p += 46 + nameLength;
  }
  return files;
}

describe("exportPage", () => {
  it("makes PNG pictures at the chosen resolution", () => {
    const engine = open(textPdf(["One"]));
    expect(pngSize(engine.exportPage(0, { format: "png", dpi: 72 }))).toEqual({
      width: 612,
      height: 792,
    });
    expect(pngSize(engine.exportPage(0, { format: "png", dpi: 150 }))).toEqual({
      width: 1275,
      height: 1650,
    });
  });

  it("makes JPEG pictures, smaller at lower quality", () => {
    const engine = open(textPdf(["One"]));
    const good = engine.exportPage(0, { format: "jpeg", dpi: 150, quality: 95 });
    const poor = engine.exportPage(0, { format: "jpeg", dpi: 150, quality: 20 });
    expect(Array.from(good.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    expect(poor.length).toBeLessThan(good.length);
  });

  it("includes unsaved changes", () => {
    const engine = open(textPdf(["One"]));
    engine.rotatePages([0], 90);
    expect(pngSize(engine.exportPage(0, { format: "png", dpi: 72 }))).toEqual({
      width: 792,
      height: 612,
    });
  });

  it("exports text, SVG and HTML", () => {
    const engine = open(textPdf(["First page", "Second <page> & more"]));
    expect(decode(engine.exportPage(1, { format: "text" }))).toContain("Second <page> & more");
    const svg = decode(engine.exportPage(0, { format: "svg" }));
    expect(svg).toMatch(/^<svg [^>]*width="612" height="792"/);
    const html = decode(engine.exportPage(1, { format: "html" }));
    expect(html).toContain('id="page1"');
    // Text is escaped, so it can't become markup.
    expect(html).toContain("Second &lt;page&gt; &amp; more");
    expect(html).not.toContain("<page>");
  });

  it("refuses bad pages and options", () => {
    const engine = open(textPdf(["One"]));
    expect(() => engine.exportPage(1, { format: "png" })).toThrow(/no such page/);
    expect(() => engine.exportPage(-1, { format: "png" })).toThrow(/no such page/);
    expect(() => engine.exportPage(0, { format: "png", dpi: 2000 })).toThrow(/resolution/);
    expect(() => engine.exportPage(0, { format: "png", dpi: Number.NaN })).toThrow(/resolution/);
    expect(() => engine.exportPage(0, { format: "jpeg", quality: 0 })).toThrow(/quality/);
    expect(() => engine.exportPage(0, { format: "gif" as "png" })).toThrow(/format/);
  });

  it("keeps huge pages within the pixel limit", () => {
    const scale = exportScale([0, 0, 14_400, 14_400], 600);
    expect((14_400 * scale) ** 2).toBeLessThanOrEqual(MAX_EXPORT_PIXELS * 1.0001);
    expect(exportScale([0, 0, 612, 792], 300)).toBeCloseTo(300 / 72);
  });

  it("respects a file that doesn't allow copying, until it's unlocked", () => {
    const first = open(textPdf(["Secret"]));
    first.setPassword({
      permissionsPassword: "owner",
      permissions: { ...ALL_PERMISSIONS, copy: false },
    });
    const engine = open(first.save());
    expect(() => engine.exportPage(0, { format: "text" })).toThrow(/doesn't allow copying/);
    expect(() => engine.exportPage(0, { format: "png" })).toThrow(/doesn't allow copying/);
    expect(engine.unlockPermissions("owner")).not.toBeNull();
    expect(decode(engine.exportPage(0, { format: "text" }))).toContain("Secret");
  });
});

describe("export files", () => {
  it("names files after the document and pages", () => {
    expect(exportStem("Q3 report.PDF")).toBe("Q3 report");
    expect(exportStem('a/b:c*?"<>|\u0001.pdf')).toBe("a_b_c_______");
    expect(exportStem(".pdf")).toBe("document");
    expect(pageFileName("r", 2, 120, "png")).toBe("r-page-003.png");
    expect(exportFileName("r.pdf", "png", [0], 5)).toBe("r-page-1.png");
    expect(exportFileName("r.pdf", "jpeg", [0, 1], 5)).toBe("r-jpg.zip");
    expect(exportFileName("r.pdf", "text", [0, 1], 5)).toBe("r.txt");
    expect(exportFileName("r.pdf", "html", [3], 5)).toBe("r.html");
  });

  it("saves one page's picture as it is", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const file = assembleExport("r.pdf", "png", [{ page: 4, bytes }], 12);
    expect(file).toMatchObject({ name: "r-page-05.png", mime: "image/png", bytes });
  });

  it("puts several pages' pictures in a ZIP, in order", () => {
    const pages = [7, 0, 9].map((page) => ({ page, bytes: new Uint8Array([page, 42]) }));
    const file = assembleExport("Bericht ü.pdf", "svg", pages, 10);
    expect(file).toMatchObject({ name: "Bericht ü-svg.zip", mime: "application/zip" });
    expect(unzip(file.bytes)).toEqual([
      { name: "Bericht ü-page-08.svg", bytes: new Uint8Array([7, 42]) },
      { name: "Bericht ü-page-01.svg", bytes: new Uint8Array([0, 42]) },
      { name: "Bericht ü-page-10.svg", bytes: new Uint8Array([9, 42]) },
    ]);
  });

  it("joins text with a form feed after each page", () => {
    const enc = new TextEncoder();
    expect(decode(joinText([enc.encode("a\n"), enc.encode("b\n")]))).toBe("a\n\fb\n\f");
  });

  it("wraps HTML pages in a page that can't run scripts or fetch anything", () => {
    const html = decode(
      htmlDocument("<script>x</script>", [new TextEncoder().encode('<div id="page0"></div>')]),
    );
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("<title>&lt;script&gt;x&lt;/script&gt;</title>");
    expect(html).toContain('<div id="page0"></div>');
  });

  it("refuses an export with no pages", () => {
    expect(() => assembleExport("r.pdf", "text", [], 1)).toThrow(/at least one page/);
  });
});

describe("zipFiles", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("writes an archive that reads back, empty or not", () => {
    expect(unzip(zipFiles([]))).toEqual([]);
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    expect(unzip(zipFiles([{ name: "big.bin", bytes: big }]))[0]?.bytes).toEqual(big);
  });
});
