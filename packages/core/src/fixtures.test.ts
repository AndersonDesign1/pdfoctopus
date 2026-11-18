// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opens every PDF in fixtures/ and renders its first page. Every file must open and render,
// except the ones listed in EXPECTED_TO_FAIL. Those must fail with an ordinary error: the
// engine must never crash (WebAssembly trap) on any file.
//
// Every page tool is then run on each file that opens, and the result is saved and reopened.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { type AnnotationInfo, createBlankPdf, PdfEngine } from "./engine";
import { IncrementalSaveError } from "./errors";

const fixturesDir = join(import.meta.dirname, "..", "..", "..", "fixtures");

/** Fixtures that can't be shown, with the reason. Paths are relative to fixtures/. */
const EXPECTED_TO_FAIL: Record<string, string> = {
  "generated/malformed-empty.pdf": "zero bytes, nothing to open",
  "third-party/py-pdf/017-unreadable-meta-data_unreadablemetadata.pdf":
    "MuPDF finds no pages in this file (pypdf reads 4); revisit when improving repair",
};

/** Files that open but aren't really PDFs, so page tools must refuse them cleanly. */
const NOT_EDITABLE: Record<string, string> = {
  "generated/malformed-html-named-pdf.pdf":
    "an HTML file; MuPDF shows it but it has no PDF structure",
};

/** Open passwords for encrypted fixtures (see fixtures/README.md). */
const PASSWORDS: Record<string, string> = {
  "generated/encrypted-aes256.pdf": "open-sesame",
  "generated/encrypted-rc4-40.pdf": "open-sesame",
  "third-party/py-pdf/005-libreoffice-writer-password_libreoffice-writer-password.pdf":
    "openpassword",
};

function listPdfs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "scripts" ? [] : listPdfs(path);
    return name.endsWith(".pdf") ? [path] : [];
  });
}

// Names always use "/" (relative() gives "\\" on Windows), matching the keys above.
const files = listPdfs(fixturesDir).map((path) => ({
  name: relative(fixturesDir, path).replaceAll("\\", "/"),
  path,
}));

/** Open a file and render page 1. Returns the page count. */
function openAndRender(name: string, path: string): number {
  const engine = new PdfEngine();
  try {
    const opened = engine.open(new Uint8Array(readFileSync(path)));
    const info = opened.needsPassword ? engine.authenticate(PASSWORDS[name] ?? "") : opened;
    if (!info) throw new Error(`No working password for ${name}`);
    expect(info.pages).toHaveLength(info.pageCount);
    const page = engine.renderPage(0, 0.25);
    expect(page.pixels.length).toBe(page.width * page.height * 4);
    return info.pageCount;
  } finally {
    engine.close();
  }
}

describe("fixtures", () => {
  it("has at least 30 files", () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it("lists only existing files as expected failures", () => {
    const names = new Set(files.map((f) => f.name));
    for (const name of Object.keys(EXPECTED_TO_FAIL)) expect(names).toContain(name);
  });

  const opening = files.filter((f) => !(f.name in EXPECTED_TO_FAIL));
  const failing = files.filter((f) => f.name in EXPECTED_TO_FAIL);

  it.each(opening.map((f) => [f.name, f.path]))("%s opens and renders", (name, path) => {
    expect(openAndRender(name, path)).toBeGreaterThan(0);
  });

  it.each(failing.map((f) => [f.name, f.path]))("%s fails cleanly", (name, path) => {
    let error: unknown;
    try {
      openAndRender(name, path);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WebAssembly.RuntimeError);
  });
});

/**
 * Run every page tool on a file, add a stamp and annotations, save it and reopen the result. Saves incrementally when
 * the file allows it (checking the original bytes are untouched), and rewrites it otherwise.
 */
function runPageTools(name: string, path: string): void {
  const original = new Uint8Array(readFileSync(path));
  const password = PASSWORDS[name];
  const engine = new PdfEngine();
  try {
    const opened = engine.open(original.slice());
    if (opened.needsPassword && !engine.authenticate(password ?? "")) {
      throw new Error(`No working password for ${name}`);
    }
    const count = engine.pageCount;
    const last = count - 1;

    engine.rotatePages([0, last], 90);
    engine.insertBlankPages(1, 1);
    engine.insertPdfs(engine.pageCount, [{ bytes: createBlankPdf(2) }]);
    engine.movePages([engine.pageCount - 1], 0);
    engine.deletePages([0]);
    if (engine.pageCount > 1) engine.deletePages([1]);
    expect(engine.pageCount).toBe(count + 1);
    // A signature in the middle of the first page, whatever its size (some fixtures have
    // pages only a few points across) and rotation.
    const { width, height } = engine.info().pages[0] as { width: number; height: number };
    const w = Math.max(1, Math.min(40, width / 2));
    const h = Math.max(1, Math.min(20, height / 2));
    const stampRect: [number, number, number, number] = [
      (width - w) / 2,
      (height - h) / 2,
      (width + w) / 2,
      (height + h) / 2,
    ];
    // A text stamp first (its own fonts and drawing, no image), then a signature over it.
    engine.addTextStamp({
      page: 0,
      rect: stampRect,
      text: "APPROVED",
      detail: "1 Jan 2026",
      color: [0.8, 0.1, 0.1],
    });
    engine.addImageStamp({ page: 0, rect: stampRect, image: tinyPng(), kind: "signature" });
    // And a rectangle and a sticky note in the same place.
    engine.addAnnotation({
      kind: "rectangle",
      page: 0,
      rect: stampRect,
      color: [1, 0, 0],
      width: 1,
    });
    engine.addAnnotation({
      kind: "note",
      page: 0,
      at: [stampRect[0], stampRect[1]],
      text: "Draft",
      color: [1, 0.8, 0],
    });
    // Edit them: move the signature to the left edge, recolour the rectangle, change the
    // note's text, and add an ellipse and delete it again.
    engine.addAnnotation({ kind: "ellipse", page: 0, rect: stampRect, color: [0, 0, 1], width: 1 });
    const added = engine.listAnnotations(0).slice(-4);
    expect(added.map((a) => a.label)).toEqual(["signature", "rectangle", "note", "ellipse"]);
    const [signature, rectangle, note, ellipse] = added as [
      AnnotationInfo,
      AnnotationInfo,
      AnnotationInfo,
      AnnotationInfo,
    ];
    const [sx0, sy0, sx1, sy1] = signature.rect;
    engine.editAnnotation(0, signature.id, { rect: [0, sy0, sx1 - sx0, sy1] });
    engine.editAnnotation(0, rectangle.id, { color: [0, 0, 1] });
    engine.editAnnotation(0, note.id, { text: "Checked" });
    engine.deleteAnnotation(0, ellipse.id);
    const extracted = engine.extractPages([0, engine.pageCount - 1]);
    expect(reopenedPageCount(extracted, password)).toBe(2);
    const split = engine.splitPages([[0], [engine.pageCount - 1, 0]]);
    expect(split.map((bytes) => reopenedPageCount(bytes, password))).toEqual([1, 2]);

    // Undo everything, then redo it, and the page count must follow.
    while (engine.history().canUndo) engine.undo();
    expect(engine.pageCount).toBe(count);
    while (engine.history().canRedo) engine.redo();
    expect(engine.pageCount).toBe(count + 1);

    let saved: Uint8Array;
    try {
      saved = engine.save();
      expect(saved.slice(0, original.length)).toEqual(original);
      // Saving again (Save twice, or Save then Save as) must give a valid file too.
      const again = engine.save();
      expect(again.slice(0, original.length)).toEqual(original);
      expect(needsRepair(again, password)).toBe(false);
    } catch (err) {
      if (!(err instanceof IncrementalSaveError)) throw err;
      saved = engine.save({ incremental: false });
    }

    const check = new PdfEngine();
    try {
      const reopened = check.open(saved);
      const info = reopened.needsPassword ? check.authenticate(password ?? "") : reopened;
      expect(info?.pageCount).toBe(count + 1);
      expect(check.renderPage(0, 0.1).width).toBeGreaterThan(0);
      expect(hasSignatureStamp(saved, password)).toBe(true);
      // The text stamp too, by its standard name.
      expect(hasSignatureStamp(saved, password, "Approved")).toBe(true);
      expect(annotationsOnFirstPage(saved, password)).toEqual(
        expect.arrayContaining(["Square", "Text:Checked"]),
      );
      expect(annotationsOnFirstPage(saved, password)).not.toContain("Circle");
      // The edits survived saving: the signature at the left edge, the rectangle blue.
      const listed = check.listAnnotations(0);
      const movedSignature = listed.find(
        (a) => a.label === "signature" && Math.abs(a.rect[0]) < 0.5,
      );
      expect(movedSignature?.rect[1]).toBeCloseTo(signature.rect[1], 1);
      // (Matched by colour: a full rewrite, for files that can't be appended to, renumbers.)
      expect(listed.some((a) => a.label === "rectangle" && a.color?.join() === "0,0,1")).toBe(true);
    } finally {
      check.close();
    }
  } finally {
    engine.close();
  }
}

/** The first page's annotations, as their subtype (and the text of notes). */
function annotationsOnFirstPage(bytes: Uint8Array, password?: string): string[] {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    if (doc.needsPassword()) doc.authenticatePassword(password ?? "");
    const annots = doc.asPDF()?.findPage(0).get("Annots");
    const out: string[] = [];
    if (annots?.isArray()) {
      for (let i = 0; i < annots.length; i++) {
        const a = annots.get(i).resolve();
        const type = a.get("Subtype").asName();
        out.push(type === "Text" ? `Text:${a.get("Contents").asString()}` : type);
      }
    }
    return out;
  } finally {
    doc.destroy();
  }
}

/** True when MuPDF has to repair a saved file to open it. */
function needsRepair(bytes: Uint8Array, password?: string): boolean {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    if (doc.needsPassword()) doc.authenticatePassword(password ?? "");
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    pdf.countPages();
    return pdf.wasRepaired();
  } finally {
    doc.destroy();
  }
}

/** A small opaque PNG to stamp with. */
function tinyPng(): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 4], false);
  try {
    pix.clear(40);
    return pix.asPNG();
  } finally {
    pix.destroy();
  }
}

/** True when the first page of a saved file carries the signature stamp. */
function hasSignatureStamp(
  bytes: Uint8Array,
  password?: string,
  stampName = "PDFoctopusSignature",
): boolean {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    if (doc.needsPassword()) doc.authenticatePassword(password ?? "");
    const annots = doc.asPDF()?.findPage(0).get("Annots");
    if (!annots?.isArray()) return false;
    for (let i = 0; i < annots.length; i++) {
      const name = annots.get(i).resolve().get("Name");
      if (name.isName() && name.asName() === stampName) return true;
    }
    return false;
  } finally {
    doc.destroy();
  }
}

/** Page count of a PDF produced by extract or split (they come out unencrypted). */
function reopenedPageCount(bytes: Uint8Array, password?: string): number {
  const check = new PdfEngine();
  try {
    const opened = check.open(bytes);
    const info = opened.needsPassword ? check.authenticate(password ?? "") : opened;
    return info?.pageCount ?? -1;
  } finally {
    check.close();
  }
}

describe("page tools on every fixture", () => {
  const editable = files.filter((f) => !(f.name in EXPECTED_TO_FAIL) && !(f.name in NOT_EDITABLE));
  it.each(editable.map((f) => [f.name, f.path]))(
    "%s survives every page tool, undo, redo and save",
    (name, path) => runPageTools(name, path),
    60_000,
  );

  it.each(Object.keys(NOT_EDITABLE).map((name) => [name, join(fixturesDir, name)]))(
    "%s refuses page tools with an ordinary error",
    (name, path) => expect(() => runPageTools(name, path)).toThrow(/Not a PDF/),
  );
});
