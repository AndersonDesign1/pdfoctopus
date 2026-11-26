// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The password-based parts of PKCS #12 (RFC 7292) that WebCrypto can't do: the PKCS #12 key
// derivation (appendix B.2), the old password-based encryption schemes (appendix C:
// pbeWithSHAAnd3-KeyTripleDES-CBC, 2-KeyTripleDES-CBC, 128BitRC2-CBC and 40BitRC2-CBC) that
// older Windows and macOS exports use, and the file's integrity check (an HMAC keyed with the
// same derivation). Hashing and HMAC use WebCrypto; the ciphers are in legacyCiphers.ts.
// Derived keys are wiped once used.

import { type BlockCipher, cbcDecrypt, rc2, tripleDes } from "./legacyCiphers";

/** The old PBE schemes we can decrypt, by OID: the cipher and its key length in bytes. */
export const LEGACY_PBE: Record<
  string,
  { name: string; keyLength: number; cipher: (key: Uint8Array) => BlockCipher }
> = {
  "1.2.840.113549.1.12.1.3": {
    name: "3DES",
    keyLength: 24,
    cipher: (key) => tripleDes(key),
  },
  "1.2.840.113549.1.12.1.4": {
    name: "2-key 3DES",
    keyLength: 16,
    cipher: (key) => tripleDes(key),
  },
  "1.2.840.113549.1.12.1.5": {
    name: "128-bit RC2",
    keyLength: 16,
    cipher: (key) => rc2(key, 128),
  },
  "1.2.840.113549.1.12.1.6": {
    name: "40-bit RC2",
    keyLength: 5,
    cipher: (key) => rc2(key, 40),
  },
};

/** The RC4 schemes: too weak and too rare to be worth supporting. */
export const RC4_PBE = new Set(["1.2.840.113549.1.12.1.1", "1.2.840.113549.1.12.1.2"]);

/** Hashes the derivation and the integrity check can use: output and block size in bytes. */
const HASHES: Record<string, { name: string; u: number; v: number }> = {
  "1.3.14.3.2.26": { name: "SHA-1", u: 20, v: 64 },
  "2.16.840.1.101.3.4.2.4": { name: "SHA-224", u: 28, v: 64 },
  "2.16.840.1.101.3.4.2.1": { name: "SHA-256", u: 32, v: 64 },
  "2.16.840.1.101.3.4.2.2": { name: "SHA-384", u: 48, v: 128 },
  "2.16.840.1.101.3.4.2.3": { name: "SHA-512", u: 64, v: 128 },
};

/**
 * More rounds than any real file uses (they use 1 to a few hundred thousand). A crafted file
 * could otherwise keep the browser busy for hours.
 */
export const MAX_ITERATIONS = 1_000_000;

export class UnsupportedPbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPbeError";
  }
}

/** A password as PKCS #12 wants it: UTF-16 big-endian with two zero bytes at the end. */
export function bmpPassword(password: string): Uint8Array {
  const out = new Uint8Array(password.length * 2 + 2);
  for (let i = 0; i < password.length; i++) {
    const c = password.charCodeAt(i);
    out[2 * i] = c >> 8;
    out[2 * i + 1] = c & 255;
  }
  return out;
}

async function digest(name: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest(name, data as BufferSource));
}

/** `data` repeated to fill a whole number of v-byte blocks (none if it's empty). */
function fill(data: Uint8Array, v: number): Uint8Array {
  if (data.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(v * Math.ceil(data.length / v));
  for (let i = 0; i < out.length; i++) out[i] = data[i % data.length] as number;
  return out;
}

/**
 * The PKCS #12 key derivation (RFC 7292, B.2). `id` is 1 for a key, 2 for an IV, 3 for a MAC
 * key; `password` is already in PKCS #12 form (see bmpPassword).
 */
export async function pkcs12Kdf(
  hashName: "SHA-1" | "SHA-224" | "SHA-256" | "SHA-384" | "SHA-512",
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  id: 1 | 2 | 3,
  length: number,
): Promise<Uint8Array> {
  const hash = Object.values(HASHES).find((h) => h.name === hashName);
  if (!hash) throw new UnsupportedPbeError(`Unsupported hash ${hashName}`);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    throw new UnsupportedPbeError("Unsupported number of iterations");
  }
  const { u, v } = hash;
  const s = fill(salt, v);
  const p = fill(password, v);
  const input = new Uint8Array(v + s.length + p.length);
  input.fill(id, 0, v);
  const i = input.subarray(v);
  i.set(s, 0);
  i.set(p, s.length);
  const out = new Uint8Array(length);
  try {
    for (let done = 0; done < length; done += u) {
      let a = await digest(hash.name, input);
      for (let r = 1; r < iterations; r++) a = await digest(hash.name, a);
      out.set(a.subarray(0, Math.min(u, length - done)), done);
      if (done + u >= length) break;
      // I_j = (I_j + B + 1) mod 2^(8v), where B is A repeated to v bytes.
      for (let j = 0; j < i.length; j += v) {
        let carry = 1;
        for (let k = v - 1; k >= 0; k--) {
          const sum = (i[j + k] as number) + (a[k % u] as number) + carry;
          i[j + k] = sum & 255;
          carry = sum >> 8;
        }
      }
    }
  } finally {
    input.fill(0);
    p.fill(0);
  }
  return out;
}

/**
 * The salt and iteration count of a PKCS #12 PBE AlgorithmIdentifier's parameters:
 * SEQUENCE { salt OCTET STRING, iterations INTEGER }, as DER.
 */
export interface PbeParams {
  salt: Uint8Array;
  iterations: number;
}

/**
 * Decrypt data encrypted with one of the old PKCS #12 schemes. Throws BadPaddingError (from
 * legacyCiphers) when the password is wrong, and UnsupportedPbeError for other schemes.
 */
export async function legacyPbeDecrypt(
  oid: string,
  params: PbeParams,
  password: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const scheme = LEGACY_PBE[oid];
  if (!scheme) throw new UnsupportedPbeError(`Unsupported encryption ${oid}`);
  const key = await pkcs12Kdf(
    "SHA-1",
    password,
    params.salt,
    params.iterations,
    1,
    scheme.keyLength,
  );
  const iv = await pkcs12Kdf("SHA-1", password, params.salt, params.iterations, 2, 8);
  const cipher = scheme.cipher(key);
  key.fill(0);
  try {
    return cbcDecrypt(cipher, iv, data);
  } finally {
    cipher.wipe();
  }
}

/** The name of a hash OID the integrity check can use, or null. */
export function macHashName(oid: string): string | null {
  return HASHES[oid]?.name ?? null;
}

/**
 * Check a .p12 file's integrity (MacData): an HMAC over the contents, keyed with the PKCS #12
 * derivation (id 3) of the password. Returns whether it matches.
 */
export async function checkPkcs12Mac(
  hashOid: string,
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  content: Uint8Array,
  expected: Uint8Array,
): Promise<boolean> {
  const hash = HASHES[hashOid];
  if (!hash) throw new UnsupportedPbeError(`Unsupported integrity hash ${hashOid}`);
  const keyBytes = await pkcs12Kdf(hash.name as "SHA-1", password, salt, iterations, 3, hash.u);
  const subtle = globalThis.crypto.subtle;
  let key: CryptoKey;
  try {
    key = await subtle.importKey(
      "raw",
      keyBytes as BufferSource,
      { name: "HMAC", hash: hash.name },
      false,
      ["verify"],
    );
  } finally {
    keyBytes.fill(0);
  }
  return subtle.verify("HMAC", key, expected as BufferSource, content as BufferSource);
}
