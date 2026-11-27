// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phase 6, step 3: text in columns, read right to left (Hebrew, Arabic), and in Chinese,
// Japanese and Korean. The pure pieces (reading order, Arabic forms, line breaks) on their own,
// then edits on the fixtures: the new text is drawn where it should be and reads back in
// reading order, nothing else on the page changes, and undo puts the exact bytes back.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { PdfEngine, type RenderedPage } from "./engine";
import { trueTypeGlyphs } from "./fontEncoding";
import type { ParagraphInfo } from "./paragraphs";
import {
  breakUnits,
  isolatedLetter,
  shapeArabic,
  toLogical,
  toVisual,
  unshapeArabic,
} from "./scripts";
import type { TextLineInfo } from "./textEdit";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const fixture = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));

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

/** The page's decoded content streams, joined. */
function content(engine: PdfEngine, page = 0): string {
  // biome-ignore lint/suspicious/noExplicitAny: the engine's open document, for reading.
  const pdf = (engine as any).requirePdf() as mupdf.PDFDocument;
  const contents = pdf.findPage(page).get("Contents");
  const streams = contents.isArray()
    ? Array.from({ length: contents.length }, (_, i) => contents.get(i))
    : [contents];
  return streams.map((s) => s.readStream().asString()).join("\n");
}

/** Pixels that differ outside a box (points, at scale 1), and in all. */
function changedOutside(a: RenderedPage, b: RenderedPage, box: readonly number[]) {
  let changed = 0;
  let outside = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (a.pixels[i] === b.pixels[i] && a.pixels[i + 1] === b.pixels[i + 1]) {
        if (a.pixels[i + 2] === b.pixels[i + 2]) continue;
      }
      changed++;
      const [x0, y0, x1, y1] = box as [number, number, number, number];
      if (x + 1 < x0 - 2 || x > x1 + 2 || y + 1 < y0 - 2 || y > y1 + 2) outside++;
    }
  }
  return { changed, outside };
}

const same = (a: RenderedPage, b: RenderedPage) =>
  Buffer.from(a.pixels).equals(Buffer.from(b.pixels));
const lineAt = (engine: PdfEngine, text: string, page = 0): TextLineInfo => {
  const line = engine.listTextLines(page).lines.find((l) => l.text === text);
  if (!line) throw new Error(`No line "${text}"`);
  return line;
};
const paragraphStarting = (engine: PdfEngine, start: string, page = 0): ParagraphInfo => {
  const p = engine.listTextLines(page).paragraphs.find((x) => x.text.startsWith(start));
  if (!p) throw new Error(`No paragraph starting "${start}"`);
  return p;
};
const key = (l: TextLineInfo) => `${l.text}|${l.rect.map((v) => v.toFixed(2)).join(",")}`;

// -------------------------------------------------------------------------------------------
// The pure pieces

describe("reading order of right-to-left text", () => {
  it("reverses Hebrew, and keeps numbers and Latin words the right way round", () => {
    expect(toVisual("שלום עולם")).toBe("םלוע םולש");
    expect(toVisual("מספר חשבונית: INV-2026-0142")).toBe("INV-2026-0142 :תינובשח רפסמ");
    expect(toVisual("סכום 1,250 ש״ח")).toBe("ח״ש 1,250 םוכס");
    // Brackets are mirrored, as they're drawn the other way round.
    expect(toVisual("הזמנה (דחוף)")).toBe("(ףוחד) הנמזה");
  });

  it("reads drawn lines back in reading order, and gives up when it's unclear", () => {
    for (const text of [
      "שלום עולם",
      "מספר חשבונית: INV-2026-0142",
      "לעזור. מסמך זה נועד לבדיקות בלבד.",
    ]) {
      expect(toLogical(toVisual(text))).toBe(text);
    }
    // No right-to-left letters, a left-to-right sentence with a Hebrew word in it, or
    // direction controls: not worked out.
    expect(toLogical("Hello world")).toBeNull();
    expect(toLogical("Call םולש now")).toBeNull();
    expect(toLogical("‮םולש")).toBeNull();
  });
});

describe("Arabic letter forms", () => {
  it("joins letters with their neighbours and makes lam-alef one glyph", () => {
    // ب ي ت: initial, medial, final.
    expect(shapeArabic("بيت")).toBe("ﺑﻴﺖ");
    // ر doesn't join the letter after it, so that one starts again.
    expect(shapeArabic("رب")).toBe("\ufead\ufe8f");
    expect(shapeArabic("سلام")).toBe("ﺳﻼﻡ");
    expect(shapeArabic("لا")).toBe("ﻻ");
    expect(unshapeArabic(shapeArabic("مع السلام"))).toBe("مع السلام");
    expect(isolatedLetter("ﺏ")).toBe("ب");
    expect(isolatedLetter("ﺑ")).toBeNull();
  });
});

describe("breaking Chinese, Japanese and Korean text", () => {
  it("breaks between characters, but not before closing or after opening punctuation", () => {
    expect(breakUnits("本合同生效。")).toEqual(["本", "合", "同", "生", "效。"]);
    expect(breakUnits("「東京」へ")).toEqual(["「東", "京」", "へ"]);
    expect(breakUnits("ちょっと")).toEqual(
      ["ちょ", "っ", "と"].length === 3 ? ["ちょっ", "と"] : [],
    );
    expect(breakUnits("INV-2026。お")).toEqual(["INV-2026。", "お"]);
    expect(breakUnits("hello")).toEqual(["hello"]);
  });
});

// -------------------------------------------------------------------------------------------
// Columns

describe("text in columns", () => {
  it("finds paragraphs one column at a time on a three-column page", () => {
    const engine = open(fixture("generated/three-columns.pdf"));
    const { lines, paragraphs } = engine.listTextLines(0);
    expect(paragraphs.length).toBe(8);
    const columns = [48.8, 304.8, 560.9];
    for (const p of paragraphs) {
      const lefts = p.lines.map((id) => (lines[id] as TextLineInfo).rect[0]);
      const column = columns.findIndex((c) => Math.abs(c - (lefts[0] as number)) < 2);
      expect(column, p.text).toBeGreaterThanOrEqual(0);
      expect(
        lefts.every((l) => Math.abs(l - (columns[column] as number)) < 2),
        p.text,
      ).toBe(true);
      expect(p.rect[2] - p.rect[0], p.text).toBeLessThan(240);
    }
  });

  it("reflows a paragraph within its column, down to the column's own next heading", () => {
    const engine = open(fixture("generated/three-columns.pdf"));
    const target = paragraphStarting(engine, "The next clean-up is planned");
    // In the middle column, with "Market news" right under it, while the first column has
    // lines alongside: only the middle column counts.
    const longer = `${target.text} ${target.text}`;
    expect(engine.checkParagraphEdit(0, target.id, target.text, longer)).toMatchObject({
      oldLines: 3,
      fit: 3,
      overflow: true,
    });
    // At the bottom of the third column there's room down to the margin.
    const last = paragraphStarting(engine, "Printed timetables");
    expect(engine.checkParagraphEdit(0, last.id, last.text, longer).fit).toBeGreaterThan(10);

    const before = engine.listTextLines(0).lines.filter((l) => !target.lines.includes(l.id));
    const render = engine.renderPage(0, 1);
    const streams = content(engine);
    const shorter = target.text.split(" ").slice(0, 14).join(" ");
    engine.editParagraph(0, target.id, target.text, shorter);
    const after = engine.listTextLines(0).lines;
    // Every other line is where it was; the new lines are inside the middle column.
    const keys = new Set(after.map(key));
    for (const l of before) expect(keys.has(key(l)), l.text).toBe(true);
    const old = new Set(before.map(key));
    const fresh = after.filter((l) => !old.has(key(l)));
    expect(fresh.length).toBeGreaterThan(0);
    for (const l of fresh) {
      expect(l.rect[0]).toBeGreaterThanOrEqual(target.rect[0] - 0.5);
      expect(l.rect[2]).toBeLessThanOrEqual(target.rect[2] + 0.5);
    }
    // Justified to the column's width, every line but the last.
    const sorted = fresh.sort((a, b) => a.rect[1] - b.rect[1]);
    expect(sorted[0]?.rect[2]).toBeCloseTo(target.rect[2], 0);
    expect(changedOutside(render, engine.renderPage(0, 1), target.rect).outside).toBe(0);
    engine.undo();
    expect(content(engine)).toBe(streams);
    expect(same(engine.renderPage(0, 1), render)).toBe(true);
  });

  it("reflows a TeX two-column paragraph at the column's width", () => {
    const engine = open(fixture("third-party/py-pdf/026-latex-multicolumn_multicolumn.pdf"));
    const target = paragraphStarting(engine, "Quisque ullamcorper");
    const { lines } = engine.listTextLines(0);
    const other = lines.filter((l) => l.rect[2] < 305).map(key);
    const text = target.text.split(" ").slice(0, 40).join(" ");
    engine.editParagraph(0, target.id, target.text, text);
    const after = engine.listTextLines(0).lines;
    // The left column is untouched, and the new text stays in the right column.
    const keys = new Set(after.map(key));
    for (const k of other) expect(keys.has(k), k).toBe(true);
    const inside = after
      .filter((l) => {
        const middle = (l.rect[1] + l.rect[3]) / 2;
        return middle > target.rect[1] && middle < target.rect[3] && l.rect[0] > 305;
      })
      .sort((a, b) => a.rect[1] - b.rect[1]);
    expect(
      inside
        .map((l) => l.text)
        .join(" ")
        .replace(/\s+/g, ""),
    ).toContain(text.replace(/\s+/g, "").slice(0, 60));
    for (const l of inside) expect(l.rect[2]).toBeLessThanOrEqual(target.rect[2] + 0.5);
  });
});

// -------------------------------------------------------------------------------------------
// Hebrew

describe("Hebrew", () => {
  it("lists lines in reading order and edits one, keeping its right edge", () => {
    const engine = open(fixture("generated/hebrew-text.pdf"));
    const { lines } = engine.listTextLines(0);
    expect(lines.every((l) => l.editable && l.direction === "rtl")).toBe(true);
    const target = lineAt(engine, "לכבוד חברת דוגמה בע״מ");
    expect(lineAt(engine, "מספר חשבונית: INV-2026-0142").editable).toBe(true);
    const others = lines.filter((l) => l.id !== target.id).map(key);
    const render = engine.renderPage(0, 1);
    const streams = content(engine);

    const text = "לכבוד חברת הדוגמה בע״מ";
    engine.editTextLine(0, target.id, target.text, text);
    const after = engine.listTextLines(0).lines;
    const edited = after.find((l) => l.text === text) as TextLineInfo;
    expect(edited).toBeDefined();
    expect(edited.rect[2]).toBeCloseTo(target.rect[2], 1);
    expect(edited.rect[0]).toBeLessThan(target.rect[0] - 3);
    const keys = new Set(after.map(key));
    for (const k of others) expect(keys.has(k), k).toBe(true);
    const box = [edited.rect[0], target.rect[1], target.rect[2], target.rect[3]];
    expect(changedOutside(render, engine.renderPage(0, 1), box).outside).toBe(0);

    // Saved incrementally, it reads the same when opened again.
    const saved = engine.save();
    const reopened = open(saved);
    expect(reopened.listTextLines(0).lines.some((l) => l.text === text)).toBe(true);

    engine.undo();
    expect(content(engine)).toBe(streams);
    expect(same(engine.renderPage(0, 1), render)).toBe(true);
  });

  it("writes Latin words, numbers and brackets the right way round", () => {
    const engine = open(fixture("generated/hebrew-text.pdf"));
    const target = lineAt(engine, "מספר חשבונית: INV-2026-0142");
    const text = "מספר הזמנה: PO-77 (בדיקה)";
    const check = engine.checkTextEdit(0, target.id, target.text, text);
    // The subset has no brackets, P, O or 7: those come from Helvetica.
    expect(check.fallback).toBe("Helvetica");
    engine.editTextLine(0, target.id, target.text, text);
    const edited = lineAt(engine, text);
    expect(edited.rect[2]).toBeCloseTo(target.rect[2], 1);
  });

  it("refuses letters the subset lacks, with the reason", () => {
    const engine = open(fixture("generated/hebrew-text.pdf"));
    const target = lineAt(engine, "בברכה, צוות השירות");
    expect(() => engine.checkTextEdit(0, target.id, target.text, "שלום וטוב")).toThrow(
      /no standard font for Hebrew/,
    );
  });

  it("reflows a right-to-left paragraph, lined up on the right", () => {
    const engine = open(fixture("generated/hebrew-text.pdf"));
    const target = paragraphStarting(engine, "אנו מודים לכם");
    expect(target).toMatchObject({ align: "right", direction: "rtl", editable: true });
    const streams = content(engine);
    const text =
      "אנו מודים לכם על ההזמנה. המשלוח יגיע תוך שלושה ימי עבודה. אם יש לכם שאלות, אנא פנו אלינו בכל עת ונשמח לעזור.";
    engine.editParagraph(0, target.id, target.text, text);
    const lines = engine
      .listTextLines(0)
      .lines.filter((l) => l.rect[1] >= target.rect[1] - 1 && l.rect[3] <= target.rect[3] + 1);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(l.rect[2]).toBeCloseTo(target.rect[2], 0);
    expect(lines.map((l) => l.text).join(" ")).toBe(text);
    engine.undo();
    expect(content(engine)).toBe(streams);
  });
});

// -------------------------------------------------------------------------------------------
// Arabic

describe("Arabic", () => {
  it("edits a line when the font maps its joined forms, and reads it back", () => {
    const engine = open(fixture("generated/arabic-text.pdf"));
    const target = lineAt(engine, "شكرا لكم على طلبكم");
    expect(target.editable).toBe(true);
    expect(lineAt(engine, "مع السلام").editable).toBe(true);
    const streams = content(engine);
    engine.editTextLine(0, target.id, target.text, "شكرا لكم");
    const edited = lineAt(engine, "شكرا لكم");
    expect(edited.rect[2]).toBeCloseTo(target.rect[2], 1);
    // Drawn with the joined forms, left to right.
    expect(content(engine)).not.toBe(streams);
    engine.undo();
    expect(content(engine)).toBe(streams);
  });

  it("refuses a form the font doesn't have, and fonts that don't say which form is which", () => {
    const engine = open(fixture("generated/arabic-text.pdf"));
    const target = lineAt(engine, "مع السلام");
    // A final teh marbuta isn't in the subset.
    expect(() => engine.checkTextEdit(0, target.id, target.text, "مع السلامة")).toThrow(
      /joined form needed here/,
    );
    const plain = engine.listTextLines(1).lines;
    expect(plain.length).toBe(4);
    expect(plain.every((l) => !l.editable && /can't be reshaped here/.test(l.reason ?? ""))).toBe(
      true,
    );
  });
});

// -------------------------------------------------------------------------------------------
// Chinese, Japanese and Korean

/** cjk-text.pdf changed by `change(pdf)`. */
function changedCjk(change: (pdf: mupdf.PDFDocument) => void): Uint8Array {
  const doc = mupdf.Document.openDocument(fixture("generated/cjk-text.pdf"), "application/pdf");
  try {
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    change(pdf);
    return pdf.saveToBuffer("").asUint8Array().slice();
  } finally {
    doc.destroy();
  }
}

describe("Chinese, Japanese and Korean", () => {
  it("edits a line in its own font", () => {
    const engine = open(fixture("generated/cjk-text.pdf"));
    const target = lineAt(engine, "天以书面形式通知对方。此文件仅用于测试。");
    const others = engine
      .listTextLines(0)
      .lines.filter((l) => l.id !== target.id)
      .map(key);
    const render = engine.renderPage(0, 1);
    const streams = content(engine);
    const check = engine.checkTextEdit(0, target.id, target.text, "天以书面形式通知对方。");
    expect(check.fallback).toBeNull();
    engine.editTextLine(0, target.id, target.text, "天以书面形式通知对方。");
    const keys = new Set(engine.listTextLines(0).lines.map(key));
    for (const k of others) expect(keys.has(k), k).toBe(true);
    expect(lineAt(engine, "天以书面形式通知对方。").rect[0]).toBeCloseTo(target.rect[0], 1);
    expect(changedOutside(render, engine.renderPage(0, 1), target.rect).outside).toBe(0);
    engine.undo();
    expect(content(engine)).toBe(streams);
    expect(same(engine.renderPage(0, 1), render)).toBe(true);
  });

  it("reflows a paragraph between characters, never starting a line with closing punctuation", () => {
    const engine = open(fixture("generated/cjk-text.pdf"));
    const target = paragraphStarting(engine, "本合同自双方签字之日起生效");
    // Joined without spaces.
    expect(target.text).toBe(
      "本合同自双方签字之日起生效，有效期为十二个月。任何一方如需终止合同，应提前六十天以书面形式通知对方。此文件仅用于测试。",
    );
    const streams = content(engine);
    // Each line holds 39 characters; this text puts "。" at the start of the second line
    // unless it's kept with the character before it.
    const text =
      "合同自双方签字之日起生效，有效期为十二个月任何一方如需终止合同应提前六十天以书。面形式通知对方。";
    expect([...text].indexOf("。")).toBe(39);
    const check = engine.checkParagraphEdit(0, target.id, target.text, text);
    expect(check).toMatchObject({ lines: 2, oldLines: 2, overflow: false });
    engine.editParagraph(0, target.id, target.text, text);
    const lines = engine
      .listTextLines(0)
      .lines.filter((l) => l.rect[1] >= target.rect[1] - 1 && l.rect[3] <= target.rect[3] + 1)
      .sort((a, b) => a.rect[1] - b.rect[1]);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.text.startsWith("。")).toBe(false);
    expect(lines[0]?.text.endsWith("书")).toBe(false);
    expect(lines.map((l) => l.text).join("")).toBe(text);
    engine.undo();
    expect(content(engine)).toBe(streams);
  });

  it("refuses characters the embedded font doesn't have, rather than use another font", () => {
    const engine = open(fixture("generated/cjk-text.pdf"));
    const target = lineAt(engine, "です。");
    expect(() => engine.checkTextEdit(0, target.id, target.text, "鳥です。")).toThrow(
      /no standard font for Chinese, Japanese or Korean/,
    );
  });

  it("checks the glyph is really in the subset, not only in the ToUnicode map", () => {
    let cid = 0;
    const bytes = changedCjk((pdf) => {
      const font = pdf.findPage(0).getInheritable("Resources").get("Font").get("F6").resolve(); // the body text
      const descendant = font.get("DescendantFonts").get(0).resolve();
      const program = descendant.get("FontDescriptor").get("FontFile2").readStream();
      const has = trueTypeGlyphs(program.asUint8Array().slice()) as (gid: number) => boolean;
      program.destroy();
      expect(has).not.toBeNull();
      // A glyph number the subset left empty, mapped to 鳥 as a broken file might.
      cid = 200;
      while (has(cid)) cid++;
      const old = font.get("ToUnicode").readStream().asString();
      const entry = `<${cid.toString(16).padStart(4, "0")}> <9CE5>\nendbfchar`;
      const cmap = old.replace(/(\d+) beginbfchar([\s\S]*?)endbfchar/, (_m, n, body) => {
        return `${Number(n) + 1} beginbfchar${body}${entry}`;
      });
      font.put("ToUnicode", pdf.addStream(cmap, pdf.newDictionary()));
      // With a width, so only the empty outline gives it away.
      const widths = descendant.get("W");
      const one = pdf.newArray();
      one.push(1000);
      widths.push(cid);
      widths.push(one);
    });
    expect(cid).toBeGreaterThan(0);
    const engine = open(bytes);
    const target = lineAt(engine, "です。");
    expect(() => engine.checkTextEdit(0, target.id, target.text, "鳥です。")).toThrow(
      /its font doesn't have it/,
    );
  });

  it("still refuses vertical writing (Identity-V)", () => {
    const bytes = changedCjk((pdf) => {
      const fonts = pdf.findPage(0).getInheritable("Resources").get("Font");
      fonts.forEach((ref) => {
        ref.resolve().put("Encoding", pdf.newName("Identity-V"));
      });
    });
    const { lines } = open(bytes).listTextLines(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => !l.editable && /Vertical|vertical/.test(l.reason ?? ""))).toBe(true);
  });
});
