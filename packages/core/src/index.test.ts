// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The app imports this package's index on the page, outside the worker. Nothing it reaches at
// run time may import MuPDF, or the page would load the engine itself (megabytes of
// WebAssembly, outside the worker's loading and failure handling). Type-only imports are fine.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = import.meta.dirname;

/** Modules a file imports or re-exports at run time (not `import type` / `export type`). */
function runtimeImports(file: string): string[] {
  const text = readFileSync(join(src, file), "utf8");
  const out: string[] = [];
  const re = /^(import|export)\s+(?!type\b)([^;]*?)\s+from\s+"([^"]+)";/gms;
  for (const m of text.matchAll(re)) {
    const what = m[2] ?? "";
    // `export { type A, type B } from` re-exports types only.
    const names = /^\{([^}]*)\}$/s.exec(what.trim());
    if (names?.[1]?.split(",").every((n) => !n.trim() || n.trim().startsWith("type "))) continue;
    out.push(m[3] as string);
  }
  return out;
}

describe("the package index", () => {
  it("doesn't reach MuPDF at run time", () => {
    const seen = new Set<string>();
    const reached: string[] = [];
    const visit = (file: string, path: string[]) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of runtimeImports(file)) {
        if (spec === "mupdf") reached.push([...path, file].join(" → "));
        else if (spec.startsWith("./")) visit(`${spec.slice(2)}.ts`, [...path, file]);
      }
    };
    visit("index.ts", []);
    expect(reached).toEqual([]);
    // It does look at the modules the app uses.
    expect(seen).toContain("textLimits.ts");
    expect(seen).toContain("stampRules.ts");
  });
});
