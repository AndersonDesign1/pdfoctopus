// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The long fuzz run: `bun run fuzz` from the repository root.
//
//   FUZZ_ITERATIONS  how many variants (default 1000)
//   FUZZ_FROM        the first variant (default 0): FUZZ_FROM=231 FUZZ_ITERATIONS=1 runs one
//   FUZZ_SEED        the run's seed (default: a new one, printed so the run can be repeated)
//   FUZZ_BUDGET_MS   longest one engine call may take (default 10000)
//   FUZZ_OUT         where inputs that fail are saved (default fuzz-crashes/, gitignored)
//   FUZZ_FILE        instead of fuzzing, run one saved file and print what goes wrong
//   FUZZ_EXPORT      instead of fuzzing, write the hand-made hostile files into this folder
//                    (to try them in the app by hand, see TESTING.md)
//
// Variants run in a worker thread. One that crashes MuPDF, or hangs (no answer for three
// budgets), is saved, the thread is replaced and the run carries on with the next variant.
// Saved inputs are named <seed>-<variant>-<problem>.pdf, with a .txt beside each that says
// what went wrong and how to run it again. Exits with 1 if anything was found.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { PdfEngine } from "../engine";
import { FIXTURES_DIR } from "./corpus";
import { craftedPdfs } from "./crafted";
import { driveDocument, type Problem } from "./drive";
import type { RunnerInput } from "./runner";
import { type Failure, supervise } from "./supervise";

const env = process.env;

/** A whole number from the environment, or the default when it's not set. */
function setting(name: string, fallback: number): number {
  const text = env[name]?.trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    console.error(`${name} must be a whole number, not "${text}"`);
    process.exit(2);
  }
  return value;
}

const iterations = setting("FUZZ_ITERATIONS", 1000);
const runSeed = setting("FUZZ_SEED", Math.floor(Math.random() * 2 ** 31));
const budgetMs = setting("FUZZ_BUDGET_MS", 10_000);
const outDir = resolve(env.FUZZ_OUT ?? join(FIXTURES_DIR, "..", "fuzz-crashes"));
const maxSeedBytes = 2 * 1024 * 1024;

/** Good files the engine must still handle after each variant. */
const healthCheck = ["generated/invoice.pdf", "public-domain/irs-form-w9.pdf"].map(
  (name) => new Uint8Array(readFileSync(join(FIXTURES_DIR, name))),
);

function describe(problems: Problem[]): string {
  return problems.map((p) => `  ${p.kind} in ${p.op}: ${p.message}`).join("\n");
}

if (env.FUZZ_EXPORT) {
  const dir = resolve(env.FUZZ_EXPORT);
  mkdirSync(dir, { recursive: true });
  const files = craftedPdfs();
  for (const { name, bytes } of files) writeFileSync(join(dir, `${name}.pdf`), bytes);
  console.log(`Wrote ${files.length} hand-made hostile PDFs to ${dir}`);
  process.exit(0);
}

if (env.FUZZ_FILE) {
  const bytes = new Uint8Array(readFileSync(env.FUZZ_FILE));
  const result = driveDocument(new PdfEngine(), bytes, { budgetMs, deep: true, healthCheck });
  console.log(`${env.FUZZ_FILE}: ${result.calls} engine calls, opened: ${result.opened}`);
  console.log(result.problems.length ? describe(result.problems) : "  no problems");
  process.exit(result.problems.length ? 1 : 0);
}

let found = 0;

/** Save a failing variant: its bytes as the thread sent them (nothing is made again here). */
function save({ index, bytes, label, problems }: Failure) {
  found++;
  mkdirSync(outDir, { recursive: true });
  const name = `${runSeed}-${index}-${problems[0]?.kind ?? "problem"}`;
  const pdf = join(outDir, `${name}.pdf`);
  if (bytes) writeFileSync(pdf, bytes);
  const again = `FUZZ_SEED=${runSeed} FUZZ_FROM=${index} FUZZ_ITERATIONS=1 bun run fuzz`;
  writeFileSync(
    join(outDir, `${name}.txt`),
    `Seed ${runSeed}, variant ${index}: ${label}\n${describe(problems)}\n\nRun it again:\n` +
      (bytes
        ? `  FUZZ_FILE=${pdf} bun run fuzz\nor as part of the run (in a fresh engine):\n`
        : "") +
      `  ${again}\n`,
  );
  console.log(`\nvariant ${index} (${label}):`);
  console.log(describe(problems));
  console.log(`  saved ${bytes ? pdf : join(outDir, `${name}.txt`)}`);
}

/** Run variants from..to in one thread; resolves to where to carry on (to when done). */
function runThread(from: number, to: number): Promise<number> {
  return supervise({
    from,
    start: (first) => {
      const input: RunnerInput = { runSeed, from: first, to, budgetMs, maxSeedBytes, healthCheck };
      return new Worker(new URL("./runner.ts", import.meta.url), { workerData: input });
    },
    // A variant that takes three budgets has hung. Starting a thread (loading MuPDF and the
    // files) doesn't count, so a new thread gets longer.
    hangMs: budgetMs * 3,
    startupMs: Math.max(120_000, budgetMs * 3),
    onDone: (msg, label, bytes) => {
      if (msg.problems.length) save({ index: msg.index, bytes, label, problems: msg.problems });
      if (msg.index % 50 === 49) process.stdout.write(`${msg.index + 1} `);
    },
    onFailure: save,
    onBroken: (err) => {
      console.error(`\nThe fuzzing thread failed to start: ${err.stack ?? err.message}`);
      process.exit(2);
    },
  });
}

const first = setting("FUZZ_FROM", 0);
const end = first + iterations;
console.log(
  `Fuzzing ${iterations} variants from ${first}, seed ${runSeed} (FUZZ_SEED=${runSeed} repeats this run)`,
);
const started = performance.now();
let next = first;
while (next < end) next = await runThread(next, end);
const seconds = Math.round((performance.now() - started) / 1000);
console.log(
  `\nDone in ${seconds} s: ${found} failing variant${found === 1 ? "" : "s"}${found ? `, saved in ${outDir}` : ""}.`,
);
process.exit(found ? 1 : 0);
