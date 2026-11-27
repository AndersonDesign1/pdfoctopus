// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fuzzer's worker thread: runs variants one after another with one engine, and reports
// each to the main thread (cli.ts, through supervise.ts). Kept in a thread of its own so a
// variant that crashes MuPDF, or hangs it, can be cut off and the run carried on with a fresh
// engine. Each variant's bytes are sent before it runs, so the main thread can save them
// without making the variant again.

import { parentPort, workerData } from "node:worker_threads";
import { PdfEngine } from "../engine";
import { loadSeeds, makeVariant } from "./corpus";
import { driveDocument } from "./drive";
import { variantSeed } from "./random";
import type { RunnerMessage } from "./supervise";

export interface RunnerInput {
  runSeed: number;
  /** Variant numbers from `from` (included) to `to` (excluded). */
  from: number;
  to: number;
  budgetMs: number;
  maxSeedBytes: number;
  healthCheck: Uint8Array[];
}

const input = workerData as RunnerInput;
const port = parentPort;
if (port && input) {
  const seeds = loadSeeds(input.maxSeedBytes);
  const engine = new PdfEngine();
  for (let index = input.from; index < input.to; index++) {
    port.postMessage({ type: "making", index } satisfies RunnerMessage);
    const variant = makeVariant(seeds, variantSeed(input.runSeed, index));
    const label = `${variant.seed.name} with ${variant.steps.join(" + ") || "no mutations"}`;
    port.postMessage({ type: "start", index, bytes: variant.bytes, label } satisfies RunnerMessage);
    const start = performance.now();
    const result = driveDocument(engine, variant.bytes, {
      budgetMs: input.budgetMs,
      password: variant.seed.password,
      deep: true,
      healthCheck: input.healthCheck,
    });
    port.postMessage({
      type: "done",
      index,
      ms: performance.now() - start,
      problems: result.problems,
    } satisfies RunnerMessage);
    // After a crash MuPDF's memory can't be trusted, nor after it reported trouble with a
    // file (the app starts a fresh engine then too): stop, and let the main thread start a
    // fresh thread from the next variant.
    if (result.troubled) break;
    if (result.problems.some((p) => p.kind === "crash" || p.kind === "engine-broken")) break;
  }
  port.postMessage({ type: "finished" } satisfies RunnerMessage);
}
