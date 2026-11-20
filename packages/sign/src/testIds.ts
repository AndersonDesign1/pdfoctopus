// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The throwaway test IDs in fixtures/test-ids (see fixtures/scripts/make-test-ids.py), for
// tests and for signing the fixtures that check-signatures.py validates. Test keys only.

import { readFileSync } from "node:fs";

export const TEST_ID_PASSWORD = "test-only";

const fixtures = new URL("../../../fixtures/", import.meta.url);

export function readFixture(path: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(path, fixtures)));
}

export function testId(name: "rsa" | "ec" | "3des"): Uint8Array {
  return readFixture(`test-ids/test-signer-${name}.p12`);
}
