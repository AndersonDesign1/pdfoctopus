// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { createBlankPdf, PdfEngine } from "./engine";

describe("PdfEngine", () => {
  it("opens a PDF and counts pages", () => {
    const engine = new PdfEngine();
    expect(engine.open(createBlankPdf(3))).toEqual({ pageCount: 3 });
    engine.close();
  });

  it("renders a page to PNG", () => {
    const engine = new PdfEngine();
    engine.open(createBlankPdf(1, 100, 200));
    const page = engine.renderPage(0, 1);
    expect(page.width).toBe(100);
    expect(page.height).toBe(200);
    // PNG signature
    expect(Array.from(page.png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
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
