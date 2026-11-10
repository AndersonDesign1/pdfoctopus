// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opens every PDF in fixtures/ and renders its first page. Every file must open and render,
// except the ones listed in EXPECTED_TO_FAIL. Those must fail with an ordinary error: the
// engine must never crash (WebAssembly trap) on any file.
//
// Every page tool is then run on each file that opens, and the result is saved and reopened.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createBlankPdf, PdfEngine } from "./engine";
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
 * Run every page tool on a file, save it and reopen the result. Saves incrementally when
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
    expect(engine.extractPages([0, engine.pageCount - 1]).length).toBeGreaterThan(0);
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
    } finally {
      check.close();
    }
  } finally {
    engine.close();
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
