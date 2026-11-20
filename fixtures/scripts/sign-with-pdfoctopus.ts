// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Signs the invoice with PDFoctopus's own signing code (packages/core and packages/sign) and
// the throwaway test IDs in fixtures/test-ids, so check-signatures.py can validate the result
// with pyhanko, an independent validator:
//
//   bun fixtures/scripts/sign-with-pdfoctopus.ts            (writes fixtures/generated/)
//   bun fixtures/scripts/sign-with-pdfoctopus.ts <folder>   (writes there; CI does this)
//
// Output:
//   signed-by-pdfoctopus.pdf        one visible signature (RSA test ID)
//   signed-by-pdfoctopus-twice.pdf  a second one added later (elliptic-curve test ID)
//   signed-by-pdfoctopus-timestamped.pdf  PAdES B-T: the RSA test ID, with a timestamp from
//                                   the in-process test timestamp server (packages/sign/src/testTsa.ts)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PdfEngine } from "../../packages/core/src/engine";
import {
  loadDigitalId,
  type SigningIdentity,
  signWithRoom,
  type TimestampOptions,
} from "../../packages/sign/src/index";
import { testTsa } from "../../packages/sign/src/testTsa";

const fixtures = join(import.meta.dir, "..");
const out = process.argv[2] ?? join(fixtures, "generated");
const password = "test-only";

async function sign(
  engine: PdfEngine,
  identity: SigningIdentity,
  rect: [number, number, number, number],
  reason: string,
  when: Date,
  timestamp?: TimestampOptions,
): Promise<Uint8Array> {
  const signature = await signWithRoom(
    identity,
    async (signatureSize) =>
      engine.prepareSignature({
        page: 0,
        rect,
        signer: identity.name,
        dateText: `${when.toISOString().slice(0, 16).replace("T", " ")} UTC`,
        signingTime: when.getTime(),
        reason,
        location: "Test lab",
        signatureSize,
      }),
    timestamp,
  );
  return engine.finishSignature(signature).bytes;
}

const rsa = await loadDigitalId(
  readFileSync(join(fixtures, "test-ids/test-signer-rsa.p12")),
  password,
);
const ec = await loadDigitalId(
  readFileSync(join(fixtures, "test-ids/test-signer-ec.p12")),
  password,
);

const engine = new PdfEngine();
engine.open(new Uint8Array(readFileSync(join(fixtures, "generated/invoice.pdf"))));
const once = await sign(
  engine,
  rsa,
  [40, 720, 250, 790],
  "Approved",
  new Date("2026-11-19T12:00:00Z"),
);
writeFileSync(join(out, "signed-by-pdfoctopus.pdf"), once);
console.log(`  signed-by-pdfoctopus.pdf (${Math.round(once.length / 1024)} KB)`);
const twice = await sign(
  engine,
  ec,
  [300, 720, 510, 790],
  "Counter-signed",
  new Date("2026-11-19T12:05:00Z"),
);
writeFileSync(join(out, "signed-by-pdfoctopus-twice.pdf"), twice);
console.log(`  signed-by-pdfoctopus-twice.pdf (${Math.round(twice.length / 1024)} KB)`);
engine.close();

// PAdES B-T: the same invoice signed again from scratch, with a trusted timestamp a few
// seconds after the claimed signing time.
const signedAt = new Date("2026-11-19T12:10:00Z");
const tsa = await testTsa({ now: () => new Date(signedAt.getTime() + 5_000) });
const timestamped = new PdfEngine();
timestamped.open(new Uint8Array(readFileSync(join(fixtures, "generated/invoice.pdf"))));
const bt = await sign(timestamped, rsa, [40, 720, 250, 790], "Approved", signedAt, {
  send: tsa.send,
  serverName: "The test timestamp server",
});
writeFileSync(join(out, "signed-by-pdfoctopus-timestamped.pdf"), bt);
console.log(`  signed-by-pdfoctopus-timestamped.pdf (${Math.round(bt.length / 1024)} KB)`);
timestamped.close();
