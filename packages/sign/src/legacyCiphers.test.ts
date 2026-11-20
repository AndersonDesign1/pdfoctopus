// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Known-answer tests for the old ciphers older .p12 files use, so they're proven against
// independent results rather than just round-tripped:
// - DES: the worked example from J. Orlin Grabbe's "The DES Algorithm Illustrated" and the
//   classic FIPS 81 / NBS validation vector.
// - Triple DES: the example in NIST SP 800-67 Rev. 1 (appendix B).
// - RC2: the test vectors in RFC 2268, section 5.
// - CBC with padding: ciphertexts made once with OpenSSL 3.0.13 (`openssl enc -des-ede3-cbc`,
//   `-rc2-40-cbc`, `-rc2-cbc`, legacy provider) and committed here as hex.

import { describe, expect, test } from "vitest";
import { BadPaddingError, cbcDecrypt, cbcEncrypt, des, rc2, tripleDes } from "./legacyCiphers";

const hex = (s: string) =>
  Uint8Array.from(s.replace(/\s/g, "").match(/../g) ?? [], (h) => Number.parseInt(h, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("DES", () => {
  test.each([
    // Grabbe, "The DES Algorithm Illustrated".
    ["133457799bbcdff1", "0123456789abcdef", "85e813540f0ab405"],
    // FIPS 81 / NBS: "Now is t" under 0123456789abcdef.
    ["0123456789abcdef", "4e6f772069732074", "3fa40e8a984d4815"],
  ])("key %s, plaintext %s", (key, plain, cipher) => {
    const d = des(hex(key));
    expect(toHex(d.encrypt(hex(plain)))).toBe(cipher);
    expect(toHex(d.decrypt(hex(cipher)))).toBe(plain);
  });
});

describe("triple DES", () => {
  test("NIST SP 800-67 example", () => {
    const key = hex("0123456789abcdef 23456789abcdef01 456789abcdef0123");
    const plain = new TextEncoder().encode("The qufck brown fox jump");
    const expected = "a826fd8ce53b855fcce21c8112256fe668d5c05dd9b6b900";
    const t = tripleDes(key);
    const blocks = [0, 8, 16].map((i) => t.encrypt(plain.subarray(i, i + 8)));
    expect(blocks.map(toHex).join("")).toBe(expected);
    const back = [0, 8, 16].map((i) => t.decrypt(hex(expected).subarray(i, i + 8)));
    expect(new TextDecoder().decode(new Uint8Array(back.flatMap((b) => [...b])))).toBe(
      "The qufck brown fox jump",
    );
  });

  test("two-key triple DES uses the first key again as the third", () => {
    const k = hex("0123456789abcdef 23456789abcdef01");
    const block = hex("5468652071756663");
    expect(tripleDes(k).encrypt(block)).toEqual(
      tripleDes(hex("0123456789abcdef 23456789abcdef01 0123456789abcdef")).encrypt(block),
    );
  });

  test("with three equal keys it is single DES", () => {
    const k = hex("133457799bbcdff1");
    const t = tripleDes(new Uint8Array([...k, ...k, ...k]));
    expect(toHex(t.encrypt(hex("0123456789abcdef")))).toBe("85e813540f0ab405");
  });
});

describe("RC2 (RFC 2268 test vectors)", () => {
  test.each([
    ["0000000000000000", 63, "0000000000000000", "ebb773f993278eff"],
    ["ffffffffffffffff", 64, "ffffffffffffffff", "278b27e42e2f0d49"],
    ["3000000000000000", 64, "1000000000000001", "30649edf9be7d2c2"],
    ["88", 64, "0000000000000000", "61a8a244adacccf0"],
    ["88bca90e90875a", 64, "0000000000000000", "6ccf4308974c267f"],
    ["88bca90e90875a7f0f79c384627bafb2", 64, "0000000000000000", "1a807d272bbe5db1"],
    ["88bca90e90875a7f0f79c384627bafb2", 128, "0000000000000000", "2269552ab0f85ca6"],
  ] as const)("key %s, effective bits %i", (key, bits, plain, cipher) => {
    const r = rc2(hex(key), bits);
    expect(toHex(r.encrypt(hex(plain)))).toBe(cipher);
    expect(toHex(r.decrypt(hex(cipher)))).toBe(plain);
  });
});

describe("CBC with PKCS #5 padding, against OpenSSL", () => {
  const plain = new TextEncoder().encode("PDFoctopus legacy cipher test, 47 bytes long!!");
  test.each([
    [
      "3DES",
      () => tripleDes(hex("0123456789abcdeffedcba987654321089abcdef01234567")),
      "1122334455667788",
      "07598e8c2fafe3826aa4f15445c92d895f6fa77e5790ab19aaf0bdedc2b2346bfdfdea81aaff1c1b0012ba8dcdbf63d8",
    ],
    [
      "40-bit RC2",
      () => rc2(hex("0102030405"), 40),
      "8877665544332211",
      "de8f6ed36e5c0e98a6172dbbf64e39f73dd46f3df3f36451aeeea7032c62a651166852bcf282a1d962154d9e7a4e5468",
    ],
    [
      "128-bit RC2",
      () => rc2(hex("000102030405060708090a0b0c0d0e0f"), 128),
      "a1a2a3a4a5a6a7a8",
      "363c4256a79d73740bfc52b48f8be58df424692a52b197c25fc152a32ae6e7c0b506cc2e9ec47b65a53c3e3b5b6f6642",
    ],
  ])("%s", (_name, cipher, iv, expected) => {
    expect(toHex(cbcEncrypt(cipher(), hex(iv), plain))).toBe(expected);
    expect(cbcDecrypt(cipher(), hex(iv), hex(expected))).toEqual(plain);
  });

  test("bad padding (a wrong key) is refused", () => {
    const encrypted = cbcEncrypt(rc2(hex("0102030405"), 40), hex("0000000000000000"), plain);
    const wrong = () => cbcDecrypt(rc2(hex("0102030406"), 40), hex("0000000000000000"), encrypted);
    expect(wrong).toThrow(BadPaddingError);
    expect(() => cbcDecrypt(rc2(hex("01"), 40), hex("0000000000000000"), hex("00"))).toThrow(
      BadPaddingError,
    );
  });
});
