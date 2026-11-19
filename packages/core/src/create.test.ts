// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Making new PDFs: blank pages in each paper size, pictures one per page (at their own size or
// on paper), and text, Markdown and HTML laid out on pages, without fetching anything.

import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { createPdf, PAPER_SIZES, type PictureSpec } from "./create";

/** Open a made PDF (checking it's sound), and read its pages' sizes and text. */
function read(bytes: Uint8Array) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    expect((doc.asPDF() as mupdf.PDFDocument).wasRepaired()).toBe(false);
    const pages: { w: number; h: number; text: string }[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      pages.push({
        w: Math.round(x1 - x0),
        h: Math.round(y1 - y0),
        text: page.toStructuredText("preserve-whitespace").asText(),
      });
      page.destroy();
    }
    return pages;
  } finally {
    doc.destroy();
  }
}

function picture(width: number, height: number): PictureSpec {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  pix.clear(200);
  const bytes = pix.asPNG().slice();
  pix.destroy();
  return { bytes, width, height };
}

describe("blank PDFs", () => {
  it("makes the pages asked for, in any paper size and either way round", () => {
    const pages = read(createPdf({ kind: "blank", format: { paper: "letter" }, pages: 3 }));
    expect(pages).toHaveLength(3);
    expect(pages[0]).toMatchObject({ w: 612, h: 792 });
    const landscape = read(
      createPdf({ kind: "blank", format: { paper: "a4", landscape: true }, pages: 1 }),
    );
    expect(landscape[0]).toMatchObject({ w: 842, h: 595 });
    for (const [paper, [w, h]] of Object.entries(PAPER_SIZES)) {
      const [page] = read(createPdf({ kind: "blank", format: { paper: paper as "a4" }, pages: 1 }));
      expect(page).toMatchObject({ w, h });
    }
  });

  it("refuses no pages, too many, and unknown paper", () => {
    expect(() => createPdf({ kind: "blank", format: { paper: "a4" }, pages: 0 })).toThrow(/1 to/);
    expect(() => createPdf({ kind: "blank", format: { paper: "a4" }, pages: 1001 })).toThrow();
    expect(() => createPdf({ kind: "blank", format: { paper: "b5" as "a4" }, pages: 1 })).toThrow(
      /paper/,
    );
  });
});

describe("pictures to PDF", () => {
  it("puts each picture on a page of its own size, in order", () => {
    const pages = read(
      createPdf({
        kind: "pictures",
        pictures: [picture(960, 480), picture(480, 960)],
        layout: { fit: "picture" },
      }),
    );
    // 96 dpi: 960 pixels is 10 inches, 720 points.
    expect(pages.map((p) => [p.w, p.h])).toEqual([
      [720, 360],
      [360, 720],
    ]);
  });

  it("puts pictures on paper, turned to suit each one", () => {
    const pages = read(
      createPdf({
        kind: "pictures",
        pictures: [picture(1600, 900), picture(900, 1600)],
        layout: { fit: "paper", paper: "a4" },
      }),
    );
    expect(pages.map((p) => [p.w, p.h])).toEqual([
      [842, 595],
      [595, 842],
    ]);
  });

  it("refuses no pictures, and pictures that can't be read", () => {
    expect(() => createPdf({ kind: "pictures", pictures: [], layout: { fit: "picture" } })).toThrow(
      /at least one/,
    );
    expect(() =>
      createPdf({
        kind: "pictures",
        pictures: [{ bytes: new Uint8Array([1, 2, 3]), width: 10, height: 10 }],
        layout: { fit: "picture" },
      }),
    ).toThrow();
  });
});

describe("text, Markdown and HTML to PDF", () => {
  const format = { paper: "a4" as const };

  it("lays plain text out on pages, keeping its lines", () => {
    const text = `Plain text\n\nIndented:\n    four spaces\nÜnïcødé 中文\n${"word ".repeat(3000)}`;
    const pages = read(createPdf({ kind: "text", source: text, textKind: "text", format }));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]).toMatchObject({ w: 595, h: 842 });
    expect(pages[0]?.text).toContain("Plain text");
    expect(pages[0]?.text).toContain("Ünïcødé 中文");
  });

  it("formats Markdown", () => {
    const md = "# Report\n\nSome **bold** text.\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    const [page] = read(createPdf({ kind: "text", source: md, textKind: "markdown", format }));
    expect(page?.text).toContain("Report");
    expect(page?.text).toContain("Some bold text.");
    expect(page?.text).toContain("two");
  });

  it("lays out HTML without fetching anything, and keeps the file small", () => {
    const html =
      '<h1>Title</h1><p>Body 中文</p><img src="https://example.com/x.png">' +
      '<link rel="stylesheet" href="https://example.com/s.css"><script>document.write("x")</script>';
    const bytes = createPdf({ kind: "text", source: html, textKind: "html", format });
    const [page] = read(bytes);
    expect(page?.text).toContain("Title");
    expect(page?.text).toContain("Body 中文");
    // Fonts are subset: a CJK font embedded whole is megabytes.
    expect(bytes.length).toBeLessThan(200_000);
  });

  it("refuses empty text", () => {
    expect(() => createPdf({ kind: "text", source: "  \n ", textKind: "text", format })).toThrow(
      /no text/,
    );
  });
});
