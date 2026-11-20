// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PAdES certificate signing (Phase 5). MuPDF (packages/core) adds the signature field and
// saves the file incrementally with room for the signature; this package reads the user's
// digital ID and makes the CMS / PKCS #7 signature with PKI.js and WebCrypto. Everything runs
// on the user's device: the file, the password and the key never leave it.

import { padesSignature, sha256 } from "./cms";
import type { SigningIdentity } from "./p12";

export { padesSignature, sha256 } from "./cms";
export {
  DigitalIdError,
  displayName,
  identityProblem,
  type LoadedCertificate,
  loadDigitalId,
  type SigningIdentity,
} from "./p12";

export type SignatureLevel = "B-B" | "B-T";

export const SIGNING_IMPLEMENTED = true;

/** The stretches of a file a signature covers: [start, length, start, length]. */
export type ByteRange = readonly [number, number, number, number];

/** The bytes in a byte range, one stretch after the other. */
export function rangeBytes(bytes: Uint8Array, range: ByteRange): Uint8Array {
  const [a, aLength, b, bLength] = range;
  if (a !== 0 || b < aLength || b + bLength !== bytes.length) {
    throw new Error("The byte range doesn't cover the file");
  }
  const out = new Uint8Array(aLength + bLength);
  out.set(bytes.subarray(0, aLength), 0);
  out.set(bytes.subarray(b, b + bLength), aLength);
  return out;
}

/**
 * Bytes to set aside in the PDF for a signature made with this identity: its certificates,
 * plus room for the signature and signed attributes, rounded up, and at least 16 KB.
 */
export function signatureSizeFor(identity: SigningIdentity): number {
  const certificates = [identity.signer, ...identity.chain].reduce((n, c) => n + c.der.length, 0);
  return Math.max(16_384, Math.ceil((certificates + 8_192) / 1024) * 1024);
}

/** Sign a prepared PDF: hash its byte range and make the PAdES B-B signature (DER). */
export async function signPdfBytes(
  identity: SigningIdentity,
  bytes: Uint8Array,
  range: ByteRange,
): Promise<Uint8Array> {
  return padesSignature(identity, await sha256(rangeBytes(bytes, range)));
}
