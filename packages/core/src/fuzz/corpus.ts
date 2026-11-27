// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fuzzer's starting files: the PDFs in fixtures/ (each also in a decompressed form, so
// mutations reach the objects and streams that are otherwise packed in object streams) and
// the hand-made hostile files. A variant is one starting file plus a few mutations, chosen
// by a seed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as mupdf from "mupdf";
import { craftedPdfs } from "./crafted";
import { mutate } from "./mutate";
import { Rng } from "./random";

export const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "..", "..", "fixtures");

/** Open passwords of the encrypted fixtures (see fixtures/README.md). */
export const PASSWORDS: Record<string, string> = {
  "generated/encrypted-aes256.pdf": "open-sesame",
  "generated/encrypted-rc4-40.pdf": "open-sesame",
  "third-party/py-pdf/005-libreoffice-writer-password_libreoffice-writer-password.pdf":
    "openpassword",
};

export interface Seed {
  /** e.g. "fixture:generated/invoice.pdf" or "crafted:page-tree-contains-itself". */
  name: string;
  bytes: Uint8Array;
  password?: string;
}

export interface Variant {
  seed: Seed;
  /** The mutations applied, in order ("expand" is the decompressed form). */
  steps: string[];
  bytes: Uint8Array;
}

function listPdfs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "scripts" ? [] : listPdfs(path);
    return name.endsWith(".pdf") ? [path] : [];
  });
}

/**
 * The fixtures up to `maxBytes` each, sorted by name (so a seed always means the same file),
 * and the hand-made files.
 */
export function loadSeeds(maxBytes = 2 * 1024 * 1024): Seed[] {
  const fixtures = listPdfs(FIXTURES_DIR)
    .map((path) => ({ path, name: relative(FIXTURES_DIR, path).replaceAll("\\", "/") }))
    .filter(({ path }) => statSync(path).size <= maxBytes)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ path, name }) => ({
      name: `fixture:${name}`,
      bytes: new Uint8Array(readFileSync(path)),
      password: PASSWORDS[name],
    }));
  const crafted = craftedPdfs().map(({ name, bytes }) => ({ name: `crafted:${name}`, bytes }));
  return [...fixtures, ...crafted];
}

const expanded = new Map<string, Uint8Array | null>();

/**
 * The file rewritten with every stream decompressed and no object streams, so that text-level
 * mutations can reach fonts, images, content and the objects themselves. Null if MuPDF can't
 * rewrite it (it's encrypted, or too broken).
 */
export function expand(seed: Seed): Uint8Array | null {
  if (expanded.has(seed.name)) return expanded.get(seed.name) ?? null;
  let out: Uint8Array | null = null;
  try {
    const doc = mupdf.Document.openDocument(seed.bytes, "application/pdf");
    try {
      const pdf = doc.asPDF();
      if (pdf && (!doc.needsPassword() || doc.authenticatePassword(seed.password ?? "") !== 0)) {
        const buffer = pdf.saveToBuffer("decompress,encrypt=keep");
        out = buffer.asUint8Array().slice();
        buffer.destroy();
      }
    } finally {
      doc.destroy();
    }
  } catch {
    out = null;
  }
  expanded.set(seed.name, out);
  return out;
}

/** The variant for one seed number: always the same starting file and mutations. */
export function makeVariant(seeds: readonly Seed[], seedNumber: number): Variant {
  const rng = new Rng(seedNumber);
  const seed = rng.pick(seeds);
  const steps: string[] = [];
  let bytes = seed.bytes;
  if (rng.chance(0.5)) {
    const big = expand(seed);
    if (big && big.length <= 8 * 1024 * 1024) {
      bytes = big;
      steps.push("expand");
    }
  }
  // Now and then, the starting file as it is (the hand-made files are hostile already).
  if (seed.name.startsWith("crafted:") && rng.chance(0.25)) return { seed, steps, bytes };
  const mutated = mutate(bytes, rng);
  return { seed, steps: [...steps, ...mutated.steps], bytes: mutated.bytes };
}
