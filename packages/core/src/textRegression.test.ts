// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Text editing against every fixture (Phase 6 quality): on each of the first two pages of every
// file that have text that can be edited, a line and a paragraph are each edited and undone. Before undo,
// pixels change only around what was edited; after undo, the page renders exactly as before.
//
// Text after an edit in the same operator is moved back by a computed amount, so its position
// can differ by a few millionths of a point. That's invisible, but a glyph sitting exactly on a
// sub-pixel step can then be drawn a step over, so a few pixels outside may differ (the engine
// itself checks every glyph outside the edit is where it was). SUBPIXEL allows for that.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { PdfEngine, type RenderedPage } from "./engine";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");

function allFixtures(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return n === "scripts" ? [] : allFixtures(p);
      return n.endsWith(".pdf") ? [p] : [];
    })
    .sort();
}

const passwords: Record<string, string> = {
  "encrypted-aes256.pdf": "open-sesame",
  "encrypted-rc4-40.pdf": "open-sesame",
  "005-libreoffice-writer-password_libreoffice-writer-password.pdf": "openpassword",
};

/**
 * The page's own content drawn at scale 1, without its annotations. Annotations aren't touched
 * by a text edit, but one blended over the page (a highlight) can come out a little different
 * wherever the content under it changes, so the area an edit changes is measured without them.
 * (After undo, the whole page, annotations and all, is compared.)
 */
function renderContent(engine: PdfEngine, index: number): RenderedPage {
  // biome-ignore lint/suspicious/noExplicitAny: the engine's open document, for drawing.
  const pdf = (engine as any).requirePdf() as mupdf.PDFDocument;
  const page = pdf.loadPage(index);
  try {
    const bounds = page.getBounds();
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bounds, false);
    try {
      pixmap.clear(255);
      const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
      try {
        page.runPageContents(device, mupdf.Matrix.identity);
        device.close();
      } finally {
        device.destroy();
      }
      return {
        width: pixmap.getWidth(),
        height: pixmap.getHeight(),
        pixels: new Uint8ClampedArray(pixmap.getPixels()),
      };
    } finally {
      pixmap.destroy();
    }
  } finally {
    page.destroy();
  }
}

/** The page's content streams, decoded and joined. */
function contentOf(engine: PdfEngine, index: number): string {
  // biome-ignore lint/suspicious/noExplicitAny: the engine's open document, for reading.
  const pdf = (engine as any).requirePdf() as mupdf.PDFDocument;
  const contents = pdf.findPage(index).get("Contents");
  const streams = contents.isArray()
    ? Array.from({ length: contents.length }, (_, i) => contents.get(i))
    : [contents];
  return streams.map((st) => (st.isStream() ? st.readStream().asString() : "")).join("\n");
}

/**
 * Whether the page has annotations without appearance streams in the file. MuPDF makes their
 * appearance itself, and after the page's content has changed (even if changed back) it can
 * make it again a little differently, so the whole page isn't compared pixel for pixel then.
 */
function hasMadeUpAppearances(engine: PdfEngine, index: number): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: the engine's open document, for reading.
  const pdf = (engine as any).requirePdf() as mupdf.PDFDocument;
  const annots = pdf.findPage(index).get("Annots");
  if (!annots.isArray()) return false;
  for (let i = 0; i < annots.length; i++) {
    if (annots.get(i).get("AP").isNull()) return true;
  }
  return false;
}

/** Pixels that differ, and how many of them are outside a box (points, at scale 1). */
function changedOutside(a: RenderedPage, b: RenderedPage, box: readonly number[]) {
  let changed = 0;
  let outside = 0;
  const n = a.pixels.length / (a.width * a.height);
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * n;
      if (
        a.pixels[i] === b.pixels[i] &&
        a.pixels[i + 1] === b.pixels[i + 1] &&
        a.pixels[i + 2] === b.pixels[i + 2]
      ) {
        continue;
      }
      changed++;
      if (
        x + 1 < (box[0] as number) - 2 ||
        x > (box[2] as number) + 2 ||
        y + 1 < (box[1] as number) - 2 ||
        y > (box[3] as number) + 2
      ) {
        outside++;
      }
    }
  }
  return { changed, outside };
}

const union = (boxes: (readonly number[])[]) => [
  Math.min(...boxes.map((b) => b[0] as number)),
  Math.min(...boxes.map((b) => b[1] as number)),
  Math.max(...boxes.map((b) => b[2] as number)),
  Math.max(...boxes.map((b) => b[3] as number)),
];

const same = (a: RenderedPage, b: RenderedPage) =>
  a.width === b.width && Buffer.from(a.pixels).equals(Buffer.from(b.pixels));

/** Refusals that are expected for some text (and leave the page as it was). */
const SUBPIXEL = 64;

const EXPECTED =
  /can't be written|would be hidden|its end would be hidden|bottom of the page|shaped area/;

describe("text editing on every fixture", () => {
  it("edits and undoes a line and a paragraph on each, changing only what was edited", () => {
    const start = performance.now();
    const summary = {
      files: 0,
      pages: 0,
      lines: 0,
      paragraphs: 0,
      refused: [] as string[],
      subpixel: [] as string[],
    };
    for (const path of allFixtures(fixtures)) {
      const name = path.slice(fixtures.length + 1);
      const engine = new PdfEngine();
      try {
        try {
          const opened = engine.open(new Uint8Array(readFileSync(path)));
          if (
            opened.needsPassword &&
            !engine.authenticate(passwords[path.split("/").pop() as string] ?? "")
          ) {
            continue;
          }
          if (engine.pageCount === 0) continue;
        } catch {
          continue; // Files that can't be opened are covered by fixtures.test.ts.
        }
        // Checked before anything is read or drawn, as loading a page makes the appearances.
        const madeUpPages = new Set<number>();
        try {
          for (let p = 0; p < Math.min(engine.pageCount, 2); p++) {
            if (hasMadeUpAppearances(engine, p)) madeUpPages.add(p);
          }
        } catch {
          continue; // Not a PDF (an HTML file named .pdf).
        }
        // The first two pages, where they have text that can be edited.
        const pages: number[] = [];
        for (let p = 0; p < Math.min(engine.pageCount, 2); p++) {
          try {
            if (engine.listTextLines(p).lines.some((l) => l.editable)) pages.push(p);
          } catch (err) {
            expect((err as Error).message).toMatch(/Not a PDF/);
          }
        }
        if (pages.length > 0) summary.files++;
        for (const page of pages) {
          summary.pages++;
          const madeUp = madeUpPages.has(page);
          const base = engine.renderPage(page, 1);
          const content = renderContent(engine, page);
          const streams = contentOf(engine, page);
          // After undo: the same content, byte for byte, and the same pixels.
          const undone = (what: string) => {
            expect(contentOf(engine, page) === streams, `${name}: ${what} undone (content)`).toBe(
              true,
            );
            expect(same(renderContent(engine, page), content), `${name}: ${what} undone`).toBe(
              true,
            );
            if (!madeUp) {
              expect(same(engine.renderPage(page, 1), base), `${name}: ${what} undone`).toBe(true);
            }
          };
          const text = engine.listTextLines(page);

          // A line: the editable one in the middle of the list, a letter shorter.
          const editable = text.lines.filter((l) => l.editable && l.text.trim().length > 1);
          const line = editable[Math.floor(editable.length / 2)];
          if (line) {
            const replacement = line.text.trim().slice(0, -1);
            try {
              engine.editTextLine(page, line.id, line.text, replacement);
              const after = engine.listTextLines(page).lines;
              const found = after.filter((l) => l.text.includes(replacement));
              expect(found.length, `${name}: "${replacement}"`).toBeGreaterThan(0);
              const box = union([line.rect, ...found.map((l) => l.rect)]);
              const diff = changedOutside(content, renderContent(engine, page), box);
              expect(diff.outside, `${name}: line "${line.text}"`).toBeLessThanOrEqual(SUBPIXEL);
              if (diff.outside > 0) summary.subpixel.push(`${name} line: ${diff.outside}`);
              engine.undo();
              undone("line");
              summary.lines++;
            } catch (err) {
              if (!EXPECTED.test((err as Error).message)) throw err;
              summary.refused.push(`${name} line: ${(err as Error).message}`);
            }
          }

          // A paragraph: the first that can be edited, with about half its words.
          const paragraph = text.paragraphs.find((p) => p.editable);
          if (paragraph) {
            const words = paragraph.text.split(" ");
            const replacement = words.slice(0, Math.max(1, Math.ceil(words.length / 2))).join(" ");
            try {
              engine.editParagraph(page, paragraph.id, paragraph.text, replacement);
              const diff = changedOutside(content, renderContent(engine, page), paragraph.rect);
              expect(
                diff.outside,
                `${name}: paragraph "${paragraph.text.slice(0, 40)}"`,
              ).toBeLessThanOrEqual(SUBPIXEL);
              if (diff.outside > 0) summary.subpixel.push(`${name} paragraph: ${diff.outside}`);
              expect(diff.changed, `${name}: paragraph changed`).toBeGreaterThan(0);
              const after = engine.listTextLines(page);
              const joined = after.lines
                .filter(
                  (l) =>
                    // Its middle inside the paragraph, and across it (a stand-in font may be
                    // taller or wider).
                    (l.rect[1] + l.rect[3]) / 2 > paragraph.rect[1] &&
                    (l.rect[1] + l.rect[3]) / 2 < paragraph.rect[3] &&
                    l.rect[0] < paragraph.rect[2] &&
                    l.rect[2] > paragraph.rect[0],
                )
                .sort((a, b) => a.rect[3] - b.rect[3] || a.rect[0] - b.rect[0])
                .map((l) => l.text)
                .join(" ")
                .replace(/\s+/g, "");
              expect(joined, `${name}: new paragraph text`).toContain(
                replacement.replace(/\s+/g, ""),
              );
              engine.undo();
              undone("paragraph");
              summary.paragraphs++;
            } catch (err) {
              if (!EXPECTED.test((err as Error).message)) throw err;
              summary.refused.push(`${name} paragraph: ${(err as Error).message}`);
            }
          }
          expect(engine.history().canUndo, name).toBe(false);
        }
      } finally {
        engine.close();
      }
    }
    console.log(
      `Edited ${summary.lines} lines and ${summary.paragraphs} paragraphs on ${summary.pages} pages of ${summary.files} fixtures in ${Math.round(
        performance.now() - start,
      )} ms. Refused: ${summary.refused.length ? summary.refused.join("; ") : "none"}. Sub-pixel: ${
        summary.subpixel.join("; ") || "none"
      }`,
    );
    expect(summary.subpixel.length).toBeLessThanOrEqual(3);
    expect(summary.files).toBeGreaterThan(40);
    expect(summary.lines).toBeGreaterThan(summary.pages * 0.8);
    expect(summary.paragraphs).toBeGreaterThan(30);
  }, 240_000);
});
