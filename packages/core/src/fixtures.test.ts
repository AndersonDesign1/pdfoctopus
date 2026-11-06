// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opens every PDF in fixtures/ and renders its first page. A file may fail to open with an
// ordinary error (e.g. an empty file), but the engine must never crash (WebAssembly trap).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PdfEngine } from "./engine";

const fixturesDir = join(import.meta.dirname, "..", "..", "..", "fixtures");

function listPdfs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "scripts" ? [] : listPdfs(path);
    return name.endsWith(".pdf") ? [path] : [];
  });
}

const files = listPdfs(fixturesDir);

describe("fixtures", () => {
  it("has at least 30 files", () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it.each(files.map((f) => [relative(fixturesDir, f), f]))("%s does not crash", (_, path) => {
    const engine = new PdfEngine();
    try {
      const { pageCount } = engine.open(new Uint8Array(readFileSync(path)));
      if (pageCount > 0) engine.renderPage(0, 0.25);
    } catch (err) {
      expect(err).not.toBeInstanceOf(WebAssembly.RuntimeError);
    } finally {
      engine.close();
    }
  });
});
