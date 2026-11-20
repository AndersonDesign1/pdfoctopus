// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { describe, expect, test } from "vitest";
import { PdfEngine } from "./engine";
import {
  byteRangeFor,
  findPlaceholders,
  pdfDate,
  signedBytes,
  writeByteRange,
  writeSignature,
} from "./signature";
import { winAnsi } from "./signatureField";

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`../../../fixtures/generated/${name}`, import.meta.url)),
  );
}

const SPEC = {
  signer: "Ada Lovelace",
  dateText: "2026-11-19 14:30",
  signingTime: Date.UTC(2026, 10, 19, 14, 30),
};

describe("placeholders", () => {
  const sample = (zeros: number, extra = "") =>
    encode(
      `%PDF-1.7\n1 0 obj<</Contents 2 0 R>>endobj\n` +
        `9 0 obj<</Type/Sig/ByteRange[0 1000000000 1000000000 1000000000]/Contents<${"0".repeat(zeros)}>${extra}>>endobj\ntrailer<<>>\n%%EOF\n`,
    );

  test("found, filled in without changing the length, and signed", () => {
    const bytes = sample(2048);
    const at = findPlaceholders(bytes, 0, 1024);
    expect(decode(bytes.subarray(at.contentsStart, at.contentsStart + 2))).toBe("<0");
    expect(bytes[at.contentsEnd - 1]).toBe(0x3e);
    const length = bytes.length;
    const range = writeByteRange(bytes, at);
    expect(bytes.length).toBe(length);
    expect(range).toEqual(byteRangeFor(length, at));
    expect(range[0]).toBe(0);
    expect(range[2] + range[3]).toBe(length);
    const text = decode(bytes);
    expect(text).toMatch(new RegExp(`/ByteRange\\[0 ${range[1]} ${range[2]} ${range[3]} +\\]`));
    // Everything but the hex string is signed.
    expect(signedBytes(bytes, range).length).toBe(length - 2050);

    writeSignature(bytes, at, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(decode(bytes.subarray(at.contentsStart, at.contentsStart + 10))).toBe("<deadbeef0");
    expect(bytes.length).toBe(length);
  });

  test("a hex string of the wrong size isn't taken for the placeholder", () => {
    expect(() => findPlaceholders(sample(2046), 0, 1024)).toThrow(/space for the signature/);
  });

  test("two placeholders are refused", () => {
    const two = sample(2048, `/X<${"0".repeat(2048)}>`);
    expect(() => findPlaceholders(two, 0, 1024)).toThrow(/two signature placeholders/);
  });

  test("only the update is searched", () => {
    const bytes = sample(2048);
    expect(() => findPlaceholders(bytes, bytes.length - 10, 1024)).toThrow(/byte range/);
  });

  test("a signature bigger than the space is refused", () => {
    const bytes = sample(2048);
    const at = findPlaceholders(bytes, 0, 1024);
    expect(() => writeSignature(bytes, at, new Uint8Array(1025))).toThrow(/only 1024/);
    expect(() => writeSignature(bytes, at, new Uint8Array(0))).toThrow(/empty/);
  });

  test("dates are written in UTC", () => {
    expect(pdfDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("D:20260102030405Z");
  });

  test("text for the box is kept to what the standard fonts can show", () => {
    expect(winAnsi("Zoë “Ann” — €5")).toBe("Zoë \x93Ann\x94 \x97 \x805");
    expect(winAnsi("Ωμέγα 李")).toBe("????? ?");
  });
});

describe("prepareSignature", () => {
  test("leaves the open document as it was", () => {
    const engine = new PdfEngine();
    const original = fixture("invoice.pdf");
    engine.open(original);
    const prepared = engine.prepareSignature({ ...SPEC, page: 0, rect: [40, 700, 240, 760] });
    expect(prepared.field).toBe("Signature1");
    expect(prepared.bytes.subarray(0, original.length)).toEqual(original);
    expect(engine.signatureFields()).toEqual([]);
    expect(engine.history().canUndo).toBe(false);
    // The prepared file has the field, in the box asked for.
    const copy = new PdfEngine();
    copy.open(prepared.bytes);
    const [field] = copy.signatureFields();
    expect(field?.name).toBe("Signature1");
    expect(field?.signed).toBe(true);
    field?.rect.forEach((v, i) => {
      expect(v).toBeCloseTo([40, 700, 240, 760][i] as number, 1);
    });
  });

  test("puts the box where it's shown on a rotated page", () => {
    const engine = new PdfEngine();
    engine.open(fixture("invoice.pdf"));
    engine.rotatePages([0], 90);
    const rect: [number, number, number, number] = [100, 50, 300, 110];
    const prepared = engine.prepareSignature({ ...SPEC, page: 0, rect });
    const copy = new PdfEngine();
    copy.open(prepared.bytes);
    const [field] = copy.signatureFields();
    field?.rect.forEach((v, i) => {
      expect(v).toBeCloseTo(rect[i] as number, 1);
    });
    // The appearance is turned back, so it reads the right way up.
    expect(decode(prepared.bytes)).toMatch(/\/Matrix\[0 1 -1 0 0 0\]/);
  });

  /** A file with an empty signature field "Approver", its field and box changed by `edit`. */
  function withField(edit: (widget: mupdf.PDFObject) => void): Uint8Array {
    const engine = new PdfEngine();
    engine.open(fixture("invoice.pdf"));
    engine.addField({ page: 0, kind: "signature", rect: [50, 600, 250, 650], name: "Approver" });
    const doc = mupdf.Document.openDocument(engine.save(), "application/pdf");
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    const fields = pdf.getTrailer().get("Root").get("AcroForm").get("Fields");
    edit(fields.get(fields.length - 1));
    const buffer = pdf.saveToBuffer("incremental");
    const bytes = buffer.asUint8Array().slice();
    buffer.destroy();
    doc.destroy();
    return bytes;
  }

  test("refuses a read-only field, and says it's read-only", () => {
    const engine = new PdfEngine();
    engine.open(withField((w) => w.put("Ff", 1)));
    expect(engine.signatureFields()).toEqual([
      expect.objectContaining({ name: "Approver", signed: false, readOnly: true }),
    ]);
    expect(() => engine.prepareSignature({ ...SPEC, page: 0, field: "Approver" })).toThrow(
      /read-only/,
    );
  });

  test("keeps a box's own flags, such as hidden, when signing it", () => {
    const engine = new PdfEngine();
    engine.open(withField((w) => w.put("F", 2 | 32))); // hidden, no view
    expect(engine.signatureFields()[0]?.readOnly).toBe(false);
    const prepared = engine.prepareSignature({ ...SPEC, page: 0, field: "Approver" });
    const doc = mupdf.Document.openDocument(prepared.bytes, "application/pdf");
    try {
      const pdf = doc.asPDF() as mupdf.PDFDocument;
      const fields = pdf.getTrailer().get("Root").get("AcroForm").get("Fields");
      // Hidden and no view kept; print and locked added.
      expect(
        fields
          .get(fields.length - 1)
          .get("F")
          .asNumber(),
      ).toBe(2 | 32 | 4 | 128);
    } finally {
      doc.destroy();
    }
  });

  test("refuses a box outside the page, a missing field, and nonsense sizes", () => {
    const engine = new PdfEngine();
    engine.open(fixture("invoice.pdf"));
    expect(() => engine.prepareSignature({ ...SPEC, page: 0, rect: [500, 800, 800, 900] })).toThrow(
      /inside the page/,
    );
    expect(() => engine.prepareSignature({ ...SPEC, page: 0, field: "Nope" })).toThrow(
      /no signature field called "Nope"/,
    );
    expect(() => engine.prepareSignature({ ...SPEC, page: 0 })).toThrow(/where the signature goes/);
    expect(() =>
      engine.prepareSignature({ ...SPEC, page: 0, rect: [40, 700, 240, 760], signatureSize: 10 }),
    ).toThrow(/isn't valid/);
    expect(() => engine.finishSignature(new Uint8Array(10))).toThrow(/Nothing is waiting/);
  });
});
