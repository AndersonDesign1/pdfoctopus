// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The long fuzz run: `bun run fuzz` from the repository root.
//
//   FUZZ_ITERATIONS  how many variants (default 1000)
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
import { FIXTURES_DIR, loadSeeds, makeVariant } from "./corpus";
import { craftedPdfs } from "./crafted";
import { driveDocument, type Problem } from "./drive";
import { variantSeed } from "./random";
import type { RunnerInput, RunnerMessage } from "./runner";

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

const seeds = loadSeeds(maxSeedBytes);
let found = 0;

/** Save a failing variant (it's rebuilt from its number: the same seed gives the same bytes). */
function save(index: number, problems: Problem[]) {
  found++;
  mkdirSync(outDir, { recursive: true });
  const variant = makeVariant(seeds, variantSeed(runSeed, index));
  const name = `${runSeed}-${index}-${problems[0]?.kind ?? "problem"}`;
  const pdf = join(outDir, `${name}.pdf`);
  writeFileSync(pdf, variant.bytes);
  writeFileSync(
    join(outDir, `${name}.txt`),
    `Seed ${runSeed}, variant ${index}: ${variant.seed.name} with ${variant.steps.join(" + ") || "no mutations"}\n` +
      `${describe(problems)}\n\nRun it again:\n  FUZZ_FILE=${pdf} bun run fuzz\n`,
  );
  console.log(`\nvariant ${index} (${variant.seed.name}, ${variant.steps.join("+")}):`);
  console.log(describe(problems));
  console.log(`  saved ${pdf}`);
}

/** Run variants from..to in one thread; resolves to where to carry on (to when done). */
function runThread(from: number, to: number): Promise<number> {
  return new Promise((done) => {
    const input: RunnerInput = { runSeed, from, to, budgetMs, maxSeedBytes, healthCheck };
    const worker = new Worker(new URL("./runner.ts", import.meta.url), { workerData: input });
    let current = from;
    let started = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (next: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      done(next);
    };
    // A variant that takes three budgets has hung. Starting a thread (loading MuPDF and the
    // files) doesn't count, so the clock starts with the first variant.
    const watch = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        save(current, [
          { kind: "too-slow", op: "variant", message: `no answer in ${ms} ms (hung)` },
        ]);
        finish(current + 1);
      }, ms);
    };
    watch(Math.max(120_000, budgetMs * 3));
    worker.on("message", (msg: RunnerMessage) => {
      // Messages still queued from a thread that was given up on.
      if (finished) return;
      watch(budgetMs * 3);
      if (msg.type === "start") {
        started = true;
        current = msg.index;
      } else if (msg.type === "done") {
        if (msg.problems.length) save(msg.index, msg.problems);
        if (msg.index % 50 === 49) process.stdout.write(`${msg.index + 1} `);
        current = msg.index + 1;
      } else {
        finish(current);
      }
    });
    worker.on("error", (err) => {
      if (finished) return;
      if (!started) {
        // Not a variant's fault: the fuzzer itself is broken.
        console.error(`\nThe fuzzing thread failed to start: ${err.stack ?? err.message}`);
        process.exit(2);
      }
      save(current, [{ kind: "crash", op: "variant", message: `the thread died: ${err.message}` }]);
      finish(current + 1);
    });
    worker.on("exit", () => finish(current + 1));
  });
}

console.log(
  `Fuzzing ${iterations} variants, seed ${runSeed} (FUZZ_SEED=${runSeed} repeats this run)`,
);
const started = performance.now();
let next = 0;
while (next < iterations) next = await runThread(next, iterations);
const seconds = Math.round((performance.now() - started) / 1000);
console.log(
  `\nDone in ${seconds} s: ${found} failing variant${found === 1 ? "" : "s"}${found ? `, saved in ${outDir}` : ""}.`,
);
process.exit(found ? 1 : 0);
