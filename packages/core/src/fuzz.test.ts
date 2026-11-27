// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fuzzer's fixed corpus, run on every `bun run test`: every hand-made hostile file
// (fuzz/crafted.ts), then a fixed list of damaged copies of the smaller fixtures, each driven
// through every engine path the app uses (fuzz/drive.ts). Each call must work or throw an
// ordinary Error with a message for the user, within its time budget, and the engine must
// still handle good files afterwards. The seeds are fixed, so a failure always comes back the
// same way; `bun run fuzz` runs many more variants (see TESTING.md).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PdfEngine } from "./engine";
import { FIXTURES_DIR, loadSeeds, makeVariant } from "./fuzz/corpus";
import { craftedPdfs } from "./fuzz/crafted";
import { driveDocument, type Problem } from "./fuzz/drive";
import { variantSeed } from "./fuzz/random";

/** Generous, for slow CI machines: a call that hangs takes far longer. */
const BUDGET_MS = 15_000;

/** The run seed and size of the fixed corpus. */
const RUN_SEED = 20261127;
const VARIANTS = 160;
const BATCH = 20;

const healthCheck = ["generated/invoice.pdf", "public-domain/irs-form-w9.pdf"].map(
  (name) => new Uint8Array(readFileSync(join(FIXTURES_DIR, name))),
);

function describeProblems(problems: Problem[]): string[] {
  return problems.map((p) => `${p.kind} in ${p.op}: ${p.message}`);
}

describe("fuzz: hand-made hostile files", () => {
  const engine = new PdfEngine();
  it.each(craftedPdfs().map((c) => [c.name, c.bytes] as const))("%s", (_name, bytes) => {
    const result = driveDocument(engine, bytes, { budgetMs: BUDGET_MS, deep: true });
    expect(describeProblems(result.problems)).toEqual([]);
  });
});

describe("fuzz: damaged fixtures", () => {
  // Small fixtures only, to keep the run short (the long run uses them all).
  const seeds = loadSeeds(400 * 1024);
  const engine = new PdfEngine();
  for (let from = 0; from < VARIANTS; from += BATCH) {
    it(`variants ${from} to ${from + BATCH - 1} (seed ${RUN_SEED})`, () => {
      const failures: string[] = [];
      for (let i = from; i < from + BATCH; i++) {
        const variant = makeVariant(seeds, variantSeed(RUN_SEED, i));
        const result = driveDocument(engine, variant.bytes, {
          budgetMs: BUDGET_MS,
          password: variant.seed.password,
          healthCheck,
        });
        for (const line of describeProblems(result.problems)) {
          failures.push(`#${i} ${variant.seed.name} (${variant.steps.join("+")}): ${line}`);
        }
      }
      expect(failures).toEqual([]);
    }, 120_000);
  }
});
