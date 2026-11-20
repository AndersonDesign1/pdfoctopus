// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { PdfEngine } from "./engine";
import {
  checkByteRange,
  decodeHex,
  derLength,
  eofPositions,
  MAX_CONTENTS,
  parsePdfDate,
} from "./signatureCheck";

const encode = (s: string) => new TextEncoder().encode(s);

function fixture(path: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url)));
}

describe("reading the bytes", () => {
  test("hex strings, with spaces and an odd last digit", () => {
    expect(Array.from(decodeHex(encode("<30 0a\nff>"), 1, 9) ?? [])).toEqual([0x30, 0x0a, 0xff]);
    expect(Array.from(decodeHex(encode("<3>"), 1, 2) ?? [])).toEqual([0x30]);
    expect(decodeHex(encode("<3x>"), 1, 3)).toBeNull();
  });

  test("DER lengths", () => {
    expect(derLength(Uint8Array.from([0x30, 0x02, 1, 2, 0, 0]))).toBe(4);
    expect(derLength(Uint8Array.from([0x30, 0x81, 0x01, 9, 0]))).toBe(4);
    expect(derLength(Uint8Array.from([0x30, 0x82, 0x01, 0x00, 1]))).toBeNull();
    expect(derLength(Uint8Array.from([0x30, 0x85, 1, 1, 1, 1, 1]))).toBeNull();
  });

  test("PDF dates, with and without a time zone", () => {
    expect(parsePdfDate("D:20261119143000Z")).toBe(Date.UTC(2026, 10, 19, 14, 30));
    expect(parsePdfDate("D:20230104120000-05'00'")).toBe(Date.UTC(2023, 0, 4, 17));
    expect(parsePdfDate("D:2023")).toBe(Date.UTC(2023, 0, 1));
    expect(parsePdfDate("yesterday")).toBeUndefined();
  });

  test("%%EOF markers", () => {
    expect(eofPositions(encode("a%%EOF\nb%%EOF"))).toEqual([6, 13]);
    expect(eofPositions(encode("%%EO"))).toEqual([]);
  });
});

describe("checking a byte range", () => {
  // "head <3003020100> tail%%EOF": the signature is the hex string.
  const file = encode("head <3003020100> tail%%EOF\n");
  const gapStart = 5;
  const gapEnd = 17;
  const eofs = eofPositions(file);

  test("a good one gives the signature", () => {
    const result = checkByteRange(file, [0, gapStart, gapEnd, file.length - gapEnd], eofs);
    expect(result.problems).toEqual([]);
    expect(Array.from(result.contents)).toEqual([0x30, 0x03, 0x02, 0x01, 0x00]);
  });

  test("bad ones are refused with a reason", () => {
    const check = (range: [number, number, number, number]) =>
      checkByteRange(file, range, eofs).problems;
    expect(check([1, gapStart, gapEnd, file.length - gapEnd])).toContain(
      "Its byte range doesn't start at the beginning of the file.",
    );
    expect(check([0, gapStart, gapEnd, file.length])).toEqual([
      "Its byte range doesn't fit the file.",
    ]);
    expect(check([0, gapStart - 1, gapEnd, file.length - gapEnd])).toEqual([
      "Its byte range leaves out more than the signature.",
    ]);
    expect(check([0, gapStart, gapEnd, file.length - gapEnd - 3])).toEqual([
      "Its byte range doesn't end where a saved version ends.",
    ]);
    expect(check([0, -1, gapEnd, 2.5])).toEqual(["Its byte range isn't valid."]);
  });

  test("a huge signature isn't read", () => {
    const big = new Uint8Array(MAX_CONTENTS * 2 + 20).fill(0x30);
    big[0] = 0x3c;
    big[big.length - 1] = 0x3e;
    const padded = new Uint8Array(big.length + 1);
    padded.set(big, 1);
    expect(checkByteRange(padded, [0, 1, padded.length, 0], []).problems).toEqual([
      "The signature is too large to check.",
    ]);
  });
});

describe("the engine", () => {
  test("a file without signatures keeps no copy and lists none", () => {
    const engine = new PdfEngine();
    engine.open(fixture("generated/invoice.pdf"));
    expect(engine.inspectSignatures()).toEqual({ file: null, signatures: [], truncated: false });
  });

  test("unsaved changes don't count as changes after signing", () => {
    const engine = new PdfEngine();
    engine.open(fixture("generated/signed.pdf"));
    engine.rotatePages([0], 90);
    const [signature] = engine.inspectSignatures().signatures;
    expect(signature?.coversWholeFile).toBe(true);
    expect(signature?.changes).toBe("none");
    expect(signature?.reason).toBe("Approved");
    expect(signature?.subFilter).toBe("ETSI.CAdES.detached");
  });

  test("a byte range that points somewhere else is flagged", () => {
    const bytes = fixture("generated/signed.pdf");
    const text = new TextDecoder("latin1").decode(bytes);
    const at = text.indexOf("/ByteRange");
    const close = text.indexOf("]", at);
    const fake = "/ByteRange[0 10 20 30";
    const padded = fake + " ".repeat(close - at - fake.length);
    for (let i = 0; i < padded.length; i++) bytes[at + i] = padded.charCodeAt(i);
    const engine = new PdfEngine();
    engine.open(bytes);
    const [signature] = engine.inspectSignatures().signatures;
    expect(signature?.problems.length).toBeGreaterThan(0);
    expect(signature?.contents.length).toBe(0);
  });
});
