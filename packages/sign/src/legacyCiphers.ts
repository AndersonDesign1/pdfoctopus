// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two old ciphers that older .p12 / .pfx files use and WebCrypto doesn't have: DES (as
// triple DES, FIPS 46-3 / NIST SP 800-67) and RC2 (RFC 2268), in CBC mode. They're only used
// to read a digital ID the user opens, never to protect anything new. Written for clarity
// rather than speed: a digital ID is a few kilobytes. Checked against published test vectors
// and OpenSSL in legacyCiphers.test.ts.

// --- DES -----------------------------------------------------------------------------------
// The tables are from FIPS 46-3, counting bits from 1 at the most significant end.

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64,
  56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53,
  45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37,
  5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2,
  42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19,
  20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];

const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13,
  30, 6, 22, 11, 4, 25,
];

const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60,
  52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21,
  13, 5, 28, 20, 12, 4,
];

const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52,
  31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

// Each S-box as 4 rows of 16.
const S = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11,
    9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5,
    11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10,
    6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2,
    11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12,
    11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4,
    15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1,
    10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9,
    4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10,
    3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6,
    15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14,
    0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10,
    11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12,
    2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9,
    5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11,
    0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13,
    15, 12, 9, 0, 3, 5, 6, 11,
  ],
] as const;

/** Bytes to bits (0 or 1), most significant bit first. */
function toBits(bytes: Uint8Array): Uint8Array {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bits.length; i++) bits[i] = ((bytes[i >> 3] as number) >> (7 - (i & 7))) & 1;
  return bits;
}

function fromBits(bits: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) {
    bytes[i >> 3] = (bytes[i >> 3] as number) | ((bits[i] as number) << (7 - (i & 7)));
  }
  return bytes;
}

function permute(bits: Uint8Array, table: readonly number[]): Uint8Array {
  const out = new Uint8Array(table.length);
  for (let i = 0; i < table.length; i++) out[i] = bits[(table[i] as number) - 1] as number;
  return out;
}

/** The 16 round keys (48 bits each) for an 8-byte DES key. Parity bits are ignored. */
function desRoundKeys(key: Uint8Array): Uint8Array[] {
  if (key.length !== 8) throw new Error("A DES key is 8 bytes");
  const cd = permute(toBits(key), PC1);
  let c = cd.slice(0, 28);
  let d = cd.slice(28);
  const keys: Uint8Array[] = [];
  for (const shift of SHIFTS) {
    c = new Uint8Array([...c.subarray(shift), ...c.subarray(0, shift)]);
    d = new Uint8Array([...d.subarray(shift), ...d.subarray(0, shift)]);
    keys.push(permute(new Uint8Array([...c, ...d]), PC2));
  }
  cd.fill(0);
  return keys;
}

/** The DES round function f(R, K). */
function feistel(right: Uint8Array, key: Uint8Array): Uint8Array {
  const x = permute(right, E);
  for (let i = 0; i < 48; i++) x[i] = (x[i] as number) ^ (key[i] as number);
  const out = new Uint8Array(32);
  for (let box = 0; box < 8; box++) {
    const b = x.subarray(box * 6, box * 6 + 6);
    const row = ((b[0] as number) << 1) | (b[5] as number);
    const column =
      ((b[1] as number) << 3) |
      ((b[2] as number) << 2) |
      ((b[3] as number) << 1) |
      (b[4] as number);
    const value = S[box]?.[row * 16 + column] as number;
    for (let j = 0; j < 4; j++) out[box * 4 + j] = (value >> (3 - j)) & 1;
  }
  return permute(out, P);
}

function desBlock(block: Uint8Array, keys: Uint8Array[], decrypt: boolean): Uint8Array {
  const bits = permute(toBits(block), IP);
  let left = bits.slice(0, 32);
  let right = bits.slice(32);
  for (let round = 0; round < 16; round++) {
    const key = keys[decrypt ? 15 - round : round] as Uint8Array;
    const f = feistel(right, key);
    const next = new Uint8Array(32);
    for (let i = 0; i < 32; i++) next[i] = (left[i] as number) ^ (f[i] as number);
    left = right;
    right = next;
  }
  // The halves are swapped after the last round.
  return fromBits(permute(new Uint8Array([...right, ...left]), FP));
}

/** A block cipher with 8-byte blocks. */
export interface BlockCipher {
  encrypt(block: Uint8Array): Uint8Array;
  decrypt(block: Uint8Array): Uint8Array;
  /** Forget the key schedule. */
  wipe(): void;
}

/** Single DES, for the known-answer tests (and as triple DES's building block). */
export function des(key: Uint8Array): BlockCipher {
  const keys = desRoundKeys(key);
  return {
    encrypt: (block) => desBlock(block, keys, false),
    decrypt: (block) => desBlock(block, keys, true),
    wipe: () => {
      for (const k of keys) k.fill(0);
    },
  };
}

/**
 * Triple DES (encrypt-decrypt-encrypt) with a 24-byte key (three keys), or a 16-byte key
 * (two keys, the third being the first).
 */
export function tripleDes(key: Uint8Array): BlockCipher {
  if (key.length !== 24 && key.length !== 16) throw new Error("A triple DES key is 16 or 24 bytes");
  const k1 = des(key.subarray(0, 8));
  const k2 = des(key.subarray(8, 16));
  const k3 = key.length === 24 ? des(key.subarray(16, 24)) : k1;
  return {
    encrypt: (block) => k3.encrypt(k2.decrypt(k1.encrypt(block))),
    decrypt: (block) => k1.decrypt(k2.encrypt(k3.decrypt(block))),
    wipe: () => {
      k1.wipe();
      k2.wipe();
      k3.wipe();
    },
  };
}

// --- RC2 (RFC 2268) ------------------------------------------------------------------------

const PITABLE = Uint8Array.from(
  (
    "d978f9c419ddb5ed28e9fd794aa0d89dc67e37832b76538e624c6488448bfba2179a59f587b34f1361456d8d09" +
    "817d32bd8f40eb86b77b0bf09521225c6b4e8254d66593ce60b21c7356c014a78cf1dc1275ca1f3bbee4d1423d" +
    "d430a33cb6266fbf0eda4669075727f21d9bbc944303f811c7f690ef3ee706c3d52fc8661ed708e8eade8052ee" +
    "f784aa72ac354d6a2a961ad2715a1549744b9fd05e0418a4ecc2e0416e0f51cbcc2491af50a1f47039997c3a85" +
    "23b8b47afc02365b255597312d5dfa98e38a92ae05df2910676cbac9d300e6cfe19ea82c6316013f58e289a90d" +
    "38341bab33ffb0bb480c5fb9b1cd2ec5f3db47e5a59c770aa62068fe7fc1ad"
  )
    .replace(/\s/g, "")
    .match(/../g) ?? [],
  (h) => Number.parseInt(h, 16),
);

/** The 64 16-bit subkeys for an RC2 key with an effective key length in bits. */
function rc2Subkeys(key: Uint8Array, effectiveBits: number): Uint16Array {
  const t = key.length;
  if (t < 1 || t > 128) throw new Error("An RC2 key is 1 to 128 bytes");
  if (effectiveBits < 1 || effectiveBits > 1024) throw new Error("Bad RC2 effective key length");
  const l = new Uint8Array(128);
  l.set(key);
  for (let i = t; i < 128; i++) {
    l[i] = PITABLE[((l[i - 1] as number) + (l[i - t] as number)) & 255] as number;
  }
  const t8 = Math.ceil(effectiveBits / 8);
  const tm = 255 >> (8 * t8 - effectiveBits);
  l[128 - t8] = PITABLE[(l[128 - t8] as number) & tm] as number;
  for (let i = 127 - t8; i >= 0; i--) {
    l[i] = PITABLE[(l[i + 1] as number) ^ (l[i + t8] as number)] as number;
  }
  const k = new Uint16Array(64);
  for (let i = 0; i < 64; i++) k[i] = (l[2 * i] as number) | ((l[2 * i + 1] as number) << 8);
  l.fill(0);
  return k;
}

const ROTATIONS = [1, 2, 3, 5] as const;

/** The four 16-bit words of an RC2 block, little-endian, with wrap-around indexing. */
function words(block: Uint8Array): {
  get(i: number): number;
  set(i: number, v: number): void;
  bytes(): Uint8Array;
} {
  const r = new Uint16Array(4);
  for (let i = 0; i < 4; i++) r[i] = (block[2 * i] as number) | ((block[2 * i + 1] as number) << 8);
  return {
    get: (i) => r[i & 3] as number,
    set: (i, v) => {
      r[i & 3] = v & 0xffff;
    },
    bytes: () => Uint8Array.from(Array.from(r).flatMap((w) => [w & 255, w >> 8])),
  };
}

function rc2Encrypt(block: Uint8Array, k: Uint16Array): Uint8Array {
  const r = words(block);
  let j = 0;
  const mix = () => {
    for (let i = 0; i < 4; i++) {
      const a = r.get(i + 3);
      const x = (r.get(i) + (k[j++] as number) + (a & r.get(i + 2)) + (~a & r.get(i + 1))) & 0xffff;
      const s = ROTATIONS[i] as number;
      r.set(i, (x << s) | (x >> (16 - s)));
    }
  };
  const mash = () => {
    for (let i = 0; i < 4; i++) r.set(i, r.get(i) + (k[r.get(i + 3) & 63] as number));
  };
  for (let n = 0; n < 5; n++) mix();
  mash();
  for (let n = 0; n < 6; n++) mix();
  mash();
  for (let n = 0; n < 5; n++) mix();
  return r.bytes();
}

function rc2Decrypt(block: Uint8Array, k: Uint16Array): Uint8Array {
  const r = words(block);
  let j = 63;
  const unmix = () => {
    for (let i = 3; i >= 0; i--) {
      const s = ROTATIONS[i] as number;
      const x = ((r.get(i) >> s) | (r.get(i) << (16 - s))) & 0xffff;
      const a = r.get(i + 3);
      r.set(i, x - (k[j--] as number) - (a & r.get(i + 2)) - (~a & r.get(i + 1)));
    }
  };
  const unmash = () => {
    for (let i = 3; i >= 0; i--) r.set(i, r.get(i) - (k[r.get(i + 3) & 63] as number));
  };
  for (let n = 0; n < 5; n++) unmix();
  unmash();
  for (let n = 0; n < 6; n++) unmix();
  unmash();
  for (let n = 0; n < 5; n++) unmix();
  return r.bytes();
}

/** RC2 with a key and an effective key length in bits (40 or 128 in .p12 files). */
export function rc2(key: Uint8Array, effectiveBits: number): BlockCipher {
  const k = rc2Subkeys(key, effectiveBits);
  return {
    encrypt: (block) => rc2Encrypt(block, k),
    decrypt: (block) => rc2Decrypt(block, k),
    wipe: () => k.fill(0),
  };
}

// --- CBC -----------------------------------------------------------------------------------

/** The padding was wrong: usually a wrong password. */
export class BadPaddingError extends Error {
  constructor() {
    super("Bad padding");
    this.name = "BadPaddingError";
  }
}

/** Decrypt CBC with an 8-byte block cipher and remove the PKCS #5 padding. */
export function cbcDecrypt(cipher: BlockCipher, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (iv.length !== 8) throw new Error("The IV must be 8 bytes");
  if (data.length === 0 || data.length % 8 !== 0) throw new BadPaddingError();
  const out = new Uint8Array(data.length);
  let previous = iv;
  for (let at = 0; at < data.length; at += 8) {
    const block = data.subarray(at, at + 8);
    const plain = cipher.decrypt(block);
    for (let i = 0; i < 8; i++) out[at + i] = (plain[i] as number) ^ (previous[i] as number);
    plain.fill(0);
    previous = block;
  }
  const pad = out[out.length - 1] as number;
  let ok = pad >= 1 && pad <= 8;
  for (let i = out.length - pad; ok && i < out.length; i++) ok = out[i] === pad;
  if (!ok) {
    out.fill(0);
    throw new BadPaddingError();
  }
  const result = out.slice(0, out.length - pad);
  out.fill(0);
  return result;
}

/** Encrypt CBC with PKCS #5 padding (for tests: the app never encrypts with these). */
export function cbcEncrypt(cipher: BlockCipher, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const pad = 8 - (data.length % 8);
  const padded = new Uint8Array(data.length + pad);
  padded.set(data);
  padded.fill(pad, data.length);
  const out = new Uint8Array(padded.length);
  let previous = iv;
  for (let at = 0; at < padded.length; at += 8) {
    const block = new Uint8Array(8);
    for (let i = 0; i < 8; i++) block[i] = (padded[at + i] as number) ^ (previous[i] as number);
    const encrypted = cipher.encrypt(block);
    out.set(encrypted, at);
    previous = encrypted;
  }
  return out;
}
