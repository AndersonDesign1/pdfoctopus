// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Known-answer tests for the PKCS #12 key derivation and old password-based encryption:
// - The derivation and 3DES PBE vectors from Go's golang.org/x/crypto/pkcs12 tests
//   (pbkdf_test.go and crypto_test.go), which were checked against OpenSSL.
// - More derivations made once with OpenSSL 3.0.13's PKCS12KDF
//   (`openssl kdf -keylen N -kdfopt digest:… -kdfopt hexpass:… -kdfopt hexsalt:0102030405060708
//   -kdfopt iter:2048 -kdfopt id:… PKCS12KDF`) and committed here as hex.

import { describe, expect, test } from "vitest";
import { BadPaddingError, tripleDes } from "./legacyCiphers";
import { bmpPassword, checkPkcs12Mac, legacyPbeDecrypt, pkcs12Kdf } from "./pkcs12Pbe";

const hex = (s: string) =>
  Uint8Array.from(s.replace(/\s/g, "").match(/../g) ?? [], (h) => Number.parseInt(h, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const SHA1_3DES = "1.2.840.113549.1.12.1.3";

describe("PKCS #12 key derivation", () => {
  test("Go: a 24-byte key (more than one hash long)", async () => {
    const key = await pkcs12Kdf(
      "SHA-1",
      bmpPassword("sesame"),
      hex("ffffffffffffffff"),
      2048,
      1,
      24,
    );
    expect(toHex(key)).toBe("7cd9fd3e2b3be7691a44e3bef0f9ea0fb9b897d4e325d9d1");
  });

  test("Go: a block that ends up with a leading zero byte", async () => {
    const key = await pkcs12Kdf("SHA-1", hex("0000"), hex("f37e05b518324b4b"), 2048, 1, 24);
    expect(toHex(key)).toBe("00f759ff47d14dd03665d5943cb3c4a39a2555c02aed66e1");
  });

  const salt = hex("0102030405060708");
  test.each([
    ["SHA-1", "test-only", 1, 24, "4b8b42065e1f5169cfc196d597f711cb67a4ccaebe9c0b02"],
    ["SHA-1", "test-only", 2, 8, "6d3a9b96054a781d"],
    ["SHA-1", "test-only", 3, 20, "74c955114d9360d0a01c8f2e4b4ed06f655fb660"],
    [
      "SHA-1",
      "test-only",
      1,
      64,
      "4b8b42065e1f5169cfc196d597f711cb67a4ccaebe9c0b02db9ae599edb466f2ecb174c6c7d1ec9672387c3e4114f05dde65b8ac20e78182d74db3499defc538",
    ],
    [
      "SHA-256",
      "test-only",
      3,
      32,
      "f390eab65324b48535be8810d2fd3c939083d077b41b29527409f154b88cd382",
    ],
    [
      "SHA-512",
      "pässwörd",
      1,
      100,
      "f0584840bf7a9de6f206127ae7050992d2b5268a0cc223f364ca4b966069ce2e9bdc8259fbbda66628a4c3a79282a9bd5c82054790ffeca269e74ed010f6c60b0ee927c496212632ccb5e634fb81b9839d058d747b0973bd7487af7e79aadde339714de9",
    ],
    ["SHA-1", "", 1, 16, "d9e86745c0eb8303bfc880579a1c7a45"],
  ] as const)("OpenSSL: %s, %j, id %i, %i bytes", async (hash, password, id, length, expected) => {
    const out = await pkcs12Kdf(hash, bmpPassword(password), salt, 2048, id, length);
    expect(toHex(out)).toBe(expected);
  });

  test("too many rounds are refused", async () => {
    await expect(pkcs12Kdf("SHA-1", bmpPassword("x"), salt, 1_000_001, 1, 24)).rejects.toThrow(
      /iterations/,
    );
  });
});

describe("old password-based encryption", () => {
  const params = { salt: hex("f1f2f3f4f5f6f7f8"), iterations: 4096 };
  const password = bmpPassword("sesame");

  test.each([
    ["3373f39fda49aefca09adf5a58a0ea46", "A secret!"],
    ["3373f39fda49aefc96242f717e323fe7", "A secret"],
  ])("Go: 3DES %s decrypts to %j", async (data, expected) => {
    const plain = await legacyPbeDecrypt(SHA1_3DES, params, password, hex(data));
    expect(new TextDecoder().decode(plain)).toBe(expected);
  });

  test.each(["350cc08daba95d307f9aec6ad89b9cd9", "b2f96e0660ae20cf08a07bd96b20ef41"])(
    "Go: bad padding in %s is refused",
    async (data) => {
      await expect(legacyPbeDecrypt(SHA1_3DES, params, password, hex(data))).rejects.toBeInstanceOf(
        BadPaddingError,
      );
    },
  );

  test("Go: the key and IV for “Sesame open” decrypt a block as expected", async () => {
    const salt = hex("0102030405060708");
    const p = bmpPassword("Sesame open");
    const key = await pkcs12Kdf("SHA-1", p, salt, 2048, 1, 24);
    const iv = await pkcs12Kdf("SHA-1", p, salt, 2048, 2, 8);
    // Go's test runs its CBC decrypter over one block: D(block) XOR IV.
    const out = tripleDes(key).decrypt(hex("0102030405060708"));
    const plain = out.map((b, i) => b ^ (iv[i] as number));
    expect([...plain]).toEqual([185, 73, 135, 249, 137, 1, 122, 247]);
  });

  test("RC4 and unknown schemes are refused", async () => {
    await expect(
      legacyPbeDecrypt("1.2.840.113549.1.12.1.1", params, password, hex("00")),
    ).rejects.toThrow(/Unsupported/);
  });
});

describe("integrity check (MAC)", () => {
  test("an HMAC-SHA1 keyed with the derivation is accepted, and a wrong one refused", async () => {
    const salt = hex("0102030405060708");
    const content = new TextEncoder().encode("the authenticated safe");
    // HMAC-SHA1 with the id-3 key for "test-only" (from the OpenSSL vector above).
    const key = await crypto.subtle.importKey(
      "raw",
      hex("74c955114d9360d0a01c8f2e4b4ed06f655fb660"),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, content));
    const sha1 = "1.3.14.3.2.26";
    expect(await checkPkcs12Mac(sha1, bmpPassword("test-only"), salt, 2048, content, mac)).toBe(
      true,
    );
    expect(await checkPkcs12Mac(sha1, bmpPassword("test-onlY"), salt, 2048, content, mac)).toBe(
      false,
    );
  });
});
