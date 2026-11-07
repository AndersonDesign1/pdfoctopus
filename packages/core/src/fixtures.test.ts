// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opens every PDF in fixtures/ and renders its first page. Every file must open and render,
// except the ones listed in EXPECTED_TO_FAIL. Those must fail with an ordinary error: the
// engine must never crash (WebAssembly trap) on any file.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PdfEngine } from "./engine";

const fixturesDir = join(import.meta.dirname, "..", "..", "..", "fixtures");

/** Fixtures that can't be shown, with the reason. Paths are relative to fixtures/. */
const EXPECTED_TO_FAIL: Record<string, string> = {
  "generated/malformed-empty.pdf": "zero bytes, nothing to open",
  "third-party/py-pdf/017-unreadable-meta-data_unreadablemetadata.pdf":
    "MuPDF finds no pages in this file (pypdf reads 4); revisit when improving repair",
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
