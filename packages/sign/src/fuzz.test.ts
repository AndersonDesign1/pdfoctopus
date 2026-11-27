// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fuzzing the signature panel: damaged copies of the signed fixtures, and damaged signatures
// (the CMS blob itself), go through what the panel does (packages/core's inspectSignatures,
// then checkSignatures here). Every check must finish with a status, and every problem it
// reports must be plain words: never a JavaScript error leaking out of the ASN.1 parsing.
// Seeded, so a failure always comes back the same way (see TESTING.md for longer runs).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PdfEngine } from "@pdfoctopus/core/engine";
import { errorProblem, FIXTURES_DIR, mutate, Rng } from "@pdfoctopus/core/fuzz";
import { describe, expect, test } from "vitest";
import { checkSignatures, type SignatureInput } from "./index";

const SIGNED = [
  "generated/signed.pdf",
  "generated/signed-twice.pdf",
  "generated/signed-by-pdfoctopus.pdf",
  "generated/signed-by-pdfoctopus-timestamped.pdf",
];

/** FUZZ_SCALE=10 runs ten times as many variants (with other seeds when FUZZ_SEED is set). */
const SCALE = Math.max(1, Number(process.env.FUZZ_SCALE ?? 1));
const SEED = Number(process.env.FUZZ_SEED ?? 0);

const STATUSES = ["intact", "changed", "broken", "unknown"];
const INTERNAL = /\bundefined\b|\[object |is not a function|Cannot read prop|TypeError|RangeError/;

/** What the panel does with a file; returns what went wrong, if anything. */
async function panel(bytes: Uint8Array, damageSignature?: Rng): Promise<string | null> {
  const engine = new PdfEngine();
  let inspection: ReturnType<PdfEngine["inspectSignatures"]>;
  try {
    engine.open(bytes);
    inspection = engine.inspectSignatures();
  } catch (err) {
    // Not opening at all is fine, as long as it's an ordinary error.
    const problem = errorProblem(err);
    return problem ? `${problem.kind}: ${problem.message}` : null;
  } finally {
    engine.close();
  }
  if (!inspection.file) return null;
  let signatures: SignatureInput[] = inspection.signatures;
  const rng = damageSignature;
  if (rng) {
    signatures = signatures.map((s) => ({ ...s, contents: mutate(s.contents, rng).bytes }));
  }
  let checked: Awaited<ReturnType<typeof checkSignatures>>;
  try {
    checked = await checkSignatures(inspection.file, signatures);
  } catch (err) {
    return `checkSignatures threw: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  }
  for (const s of checked) {
    if (!STATUSES.includes(s.status)) return `status ${s.status}`;
    for (const text of [...s.problems, ...s.check.problems, ...s.check.warnings]) {
      if (typeof text !== "string" || !text.trim() || INTERNAL.test(text)) {
        return `problem text: ${String(text)}`;
      }
    }
  }
  return null;
}

describe("signature panel fuzz", () => {
  for (const name of SIGNED) {
    const original = new Uint8Array(readFileSync(join(FIXTURES_DIR, name)));

    test(
      `${name}: damaged files`,
      async () => {
        const rng = new Rng(0x5160 + name.length + SEED);
        const failures: string[] = [];
        for (let i = 0; i < 12 * SCALE; i++) {
          const { bytes, steps } = mutate(original, rng);
          const problem = await panel(bytes);
          if (problem) failures.push(`#${i} (${steps.join("+")}): ${problem}`);
        }
        expect(failures).toEqual([]);
      },
      60_000 * SCALE,
    );

    test(
      `${name}: damaged signatures`,
      async () => {
        const rng = new Rng(0xc35 + name.length + SEED);
        const failures: string[] = [];
        for (let i = 0; i < 25 * SCALE; i++) {
          const problem = await panel(original, rng);
          if (problem) failures.push(`#${i}: ${problem}`);
        }
        expect(failures).toEqual([]);
      },
      60_000 * SCALE,
    );
  }
});
