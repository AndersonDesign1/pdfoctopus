// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The byte-level part of certificate signing. MuPDF writes the signature dictionary with
// placeholders: a /ByteRange that's wider than it needs to be, and /Contents as a hex string
// of zeros. Once the file is saved, the placeholders are found in the bytes, /ByteRange is
// filled in without changing the file's length, and the signature (a CMS / PKCS#7 blob made by
// packages/sign) is written over the zeros. Nothing here uses MuPDF, so the app can use it too.

/** Room for the signature in bytes (written as twice as many hex digits) when none is given. */
export const DEFAULT_SIGNATURE_SIZE = 16_384;
/** The most room a signature can ask for. */
export const MAX_SIGNATURE_SIZE = 262_144;

/**
 * The /ByteRange written before the real offsets are known. Ten digits each, so the real
 * values (which can be no larger than the file) always fit; the gap is filled with spaces.
 * 1000000000 is exactly representable as a 32-bit float, which is how MuPDF stores numbers
 * written from JavaScript.
 */
export const BYTE_RANGE_PLACEHOLDER = [0, 1_000_000_000, 1_000_000_000, 1_000_000_000] as const;

/** Where the placeholders are in a saved file. Offsets are into the whole file. */
export interface SignaturePlaceholders {
  /** The "[" that starts the /ByteRange array. */
  byteRangeStart: number;
  /** Just after the "]" that ends it. */
  byteRangeEnd: number;
  /** The "<" that starts the /Contents hex string. */
  contentsStart: number;
  /** Just after the ">" that ends it. */
  contentsEnd: number;
}

/** The two signed stretches of the file: [start, length, start, length]. */
export type ByteRange = [number, number, number, number];

const latin1 = new TextDecoder("latin1");
const ZERO = 0x30; // "0"
const LT = 0x3c; // "<"
const GT = 0x3e; // ">"

/**
 * Find the placeholders written by the signing code in the part of the file from `from` on
 * (the update just appended), given the number of bytes reserved for the signature. The last
 * signature dictionary in that part is used. Throws if they aren't there exactly once.
 */
export function findPlaceholders(
  bytes: Uint8Array,
  from: number,
  signatureSize: number,
): SignaturePlaceholders {
  const text = latin1.decode(bytes.subarray(from));
  const marker = "/ByteRange";
  const at = text.lastIndexOf(marker);
  if (at < 0 || text.indexOf(marker) !== at) {
    throw new Error("The signature's byte range wasn't found in the saved file");
  }
  const open = text.indexOf("[", at + marker.length);
  const close = text.indexOf("]", open);
  if (open < 0 || close < 0 || text.slice(at + marker.length, open).trim() !== "") {
    throw new Error("The signature's byte range wasn't found in the saved file");
  }
  const values = text
    .slice(open + 1, close)
    .trim()
    .split(/\s+/)
    .map(Number);
  if (values.length !== 4 || values.some((v, i) => v !== BYTE_RANGE_PLACEHOLDER[i])) {
    throw new Error("The signature's byte range wasn't found in the saved file");
  }

  // The hex string of zeros: "<", exactly 2 × signatureSize zeros, ">".
  const digits = signatureSize * 2;
  let contents = -1;
  for (let i = from; i + digits + 1 < bytes.length; i++) {
    if (bytes[i] !== LT || bytes[i + 1] !== ZERO) continue;
    let j = i + 1;
    while (j < bytes.length && bytes[j] === ZERO) j++;
    if (j - i - 1 === digits && bytes[j] === GT) {
      if (contents >= 0) throw new Error("The saved file has two signature placeholders");
      contents = i;
    }
    i = j - 1;
  }
  if (contents < 0) throw new Error("The space for the signature wasn't found in the saved file");
  return {
    byteRangeStart: from + open,
    byteRangeEnd: from + close + 1,
    contentsStart: contents,
    contentsEnd: contents + digits + 2,
  };
}

/** The byte range for placeholders: everything except the /Contents hex string. */
export function byteRangeFor(length: number, at: SignaturePlaceholders): ByteRange {
  return [0, at.contentsStart, at.contentsEnd, length - at.contentsEnd];
}

/**
 * Write the real /ByteRange over the placeholder, in place. The array keeps its length: the
 * values are padded with spaces before the "]".
 */
export function writeByteRange(bytes: Uint8Array, at: SignaturePlaceholders): ByteRange {
  const range = byteRangeFor(bytes.length, at);
  const width = at.byteRangeEnd - at.byteRangeStart;
  const body = `[${range.join(" ")}`;
  if (body.length + 1 > width) throw new Error("The signature's byte range doesn't fit");
  const text = `${body}${" ".repeat(width - body.length - 1)}]`;
  for (let i = 0; i < width; i++) bytes[at.byteRangeStart + i] = text.charCodeAt(i);
  return range;
}

/** The bytes a signature covers: both stretches of the byte range, one after the other. */
export function signedBytes(bytes: Uint8Array, range: ByteRange): Uint8Array {
  const [a, aLength, b, bLength] = range;
  if (a !== 0 || b < aLength || b + bLength !== bytes.length) {
    throw new Error("The byte range doesn't cover the file");
  }
  const out = new Uint8Array(aLength + bLength);
  out.set(bytes.subarray(a, a + aLength), 0);
  out.set(bytes.subarray(b, b + bLength), aLength);
  return out;
}

/**
 * Write the signature (DER) into the /Contents hex string, in place. The rest of the string
 * stays zeros, which is how padding is written.
 */
export function writeSignature(
  bytes: Uint8Array,
  at: SignaturePlaceholders,
  signature: Uint8Array,
): void {
  const room = (at.contentsEnd - at.contentsStart - 2) / 2;
  if (signature.length === 0) throw new Error("The signature is empty");
  if (signature.length > room) {
    throw new Error(
      `The signature is ${signature.length} bytes, but only ${room} were set aside for it`,
    );
  }
  const hex = "0123456789abcdef";
  let p = at.contentsStart + 1;
  for (const byte of signature) {
    bytes[p++] = hex.charCodeAt(byte >> 4);
    bytes[p++] = hex.charCodeAt(byte & 15);
  }
}

/** A date as a PDF date string in UTC, e.g. "D:20261119143000Z". */
export function pdfDate(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `D:${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}
