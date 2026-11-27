// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fuzzer's building blocks, for tests in other packages (packages/sign fuzzes its
// signature check with them). Not part of the app.

export { FIXTURES_DIR, loadSeeds, makeVariant, PASSWORDS, type Seed, type Variant } from "./corpus";
export { type CraftedPdf, craftedPdfs } from "./crafted";
export { type DriveOptions, driveDocument, errorProblem, type Problem } from "./drive";
export { MUTATOR_NAMES, MUTATORS, mutate } from "./mutate";
export { Rng, variantSeed } from "./random";
