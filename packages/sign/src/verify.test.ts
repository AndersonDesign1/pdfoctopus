// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Our signature validator (packages/core's inspectSignatures plus checkSignatures here) over
// the signed fixtures, held to the same expectations as the independent check with pyhanko
// (fixtures/scripts/check-signatures.py), trust aside: the browser has no trust list.

import { PdfEngine } from "@pdfoctopus/core/engine";
import * as asn1js from "asn1js";
import * as mupdf from "mupdf";
import * as pkijs from "pkijs";
import { describe, expect, test } from "vitest";
import {
  checkSignatures,
  loadDigitalId,
  signatureSizeFor,
  signPdfBytes,
  verifySignature,
} from "./index";
import { readFixture, TEST_ID_PASSWORD, testId } from "./testIds";

async function validate(bytes: Uint8Array) {
  const engine = new PdfEngine();
  engine.open(bytes);
  const inspection = engine.inspectSignatures();
  engine.close();
  if (!inspection.file) return [];
  return checkSignatures(inspection.file, inspection.signatures);
}

// From check-signatures.py: per signature, (intact, modified after signing), where modified
// is false or the kind of change pyhanko reports.
type Pyhanko = [boolean, false | "FORM_FILLING" | "ANNOTATIONS" | "OTHER" | null];
const PYHANKO: Record<string, Pyhanko[]> = {
  "generated/signed.pdf": [[true, false]],
  "generated/signed-twice.pdf": [
    [true, "FORM_FILLING"],
    [true, false],
  ],
  "generated/signed-then-annotated.pdf": [[true, "OTHER"]],
  "generated/signed-tampered.pdf": [[false, null]],
  "generated/signed-by-pdfoctopus.pdf": [[true, false]],
  "generated/signed-by-pdfoctopus-twice.pdf": [
    [true, "FORM_FILLING"],
    [true, false],
  ],
  "public-domain/gpo-public-law-118-1-signed.pdf": [[true, false]],
};

/** pyhanko's kind of change, in our terms. */
function ourChange(file: string, modified: Pyhanko[1]): string[] {
  if (modified === false) return ["none"];
  if (modified === "FORM_FILLING") return ["signatures", "form"];
  if (modified === "ANNOTATIONS") return ["annotations"];
  // A note added after signing: pyhanko's strict policy calls it "OTHER" because the changed
  // page is also referenced by the signature field. The PDF standard allows annotations
  // after signing, and we say exactly that: "Comments or mark-up were added".
  if (file === "generated/signed-then-annotated.pdf") return ["annotations"];
  return ["other"];
}

describe("the signed fixtures, as pyhanko sees them", () => {
  for (const [file, expected] of Object.entries(PYHANKO)) {
    test(file, async () => {
      const results = await validate(readFixture(file));
      expect(results).toHaveLength(expected.length);
      results.forEach((result, i) => {
        const [intact, modified] = expected[i] as Pyhanko;
        expect(result.status === "intact" || result.status === "changed").toBe(intact);
        if (!intact) {
          expect(result.status).toBe("broken");
          return;
        }
        expect(result.check.intact).toBe(true);
        expect(result.problems).toEqual([]);
        expect(ourChange(file, modified)).toContain(result.changes);
        expect(result.coversWholeFile).toBe(modified === false);
        expect(result.status).toBe(modified === false ? "intact" : "changed");
      });
    });
  }

  test("the signers, their certificates and when they signed", async () => {
    const [first, second] = await validate(readFixture("generated/signed-by-pdfoctopus-twice.pdf"));
    expect(first?.check.signer?.name).toBe("Test Signer RSA");
    expect(second?.check.signer?.name).toBe("Test Signer EC");
    expect(second?.check.digestAlgorithm).toBe("SHA-256");
    expect(first?.check.validAtSigning).toBe(true);
    expect(first?.revision).toBe(2);
    expect(first?.revisions).toBe(3);
    expect(first?.changeNotes).toEqual(["Another signature was added."]);
    // The chain ends at the test CA, which isn't in the signature but is named as its issuer.
    expect(first?.check.chain[0]?.issuerName).toContain("PDFoctopus");
    const [gpo] = await validate(readFixture("public-domain/gpo-public-law-118-1-signed.pdf"));
    expect(gpo?.check.signer?.name).toContain("Government Publishing Office");
    expect(gpo?.check.chain.length).toBeGreaterThan(1);
    expect(gpo?.check.chainLinked).toBe(true);
    expect(gpo?.page).toBe(0);
  });

  test("a file without signatures has none", async () => {
    expect(await validate(readFixture("generated/invoice.pdf"))).toEqual([]);
    expect(await validate(readFixture("generated/incremental-updates.pdf"))).toEqual([]);
  });
});

/** An incremental update to a file, made with MuPDF directly (not through our engine). */
function appendUpdate(bytes: Uint8Array, change: (pdf: mupdf.PDFDocument) => void): Uint8Array {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    change(pdf);
    const out = pdf.saveToBuffer("incremental");
    try {
      return out.asUint8Array().slice();
    } finally {
      out.destroy();
    }
  } finally {
    doc.destroy();
  }
}

describe("tampered files", () => {
  const original = () => readFixture("generated/signed-by-pdfoctopus.pdf");

  test("one byte changed inside the signed range: broken", async () => {
    const bytes = original();
    // "%PDF-1.x": change the version digit, which doesn't stop the file opening.
    expect(String.fromCharCode(...bytes.subarray(0, 5))).toBe("%PDF-");
    bytes[7] = (bytes[7] as number) ^ 1;
    const [result] = await validate(bytes);
    expect(result?.status).toBe("broken");
    expect(result?.check.intact).toBe(false);
    expect(result?.check.problems).toEqual([
      "The signed part of the file was altered after signing.",
    ]);
  });

  test("one byte changed in the signature itself: broken", async () => {
    const bytes = original();
    const [before] = await validate(bytes);
    const range = before?.byteRange as readonly number[];
    // Near the end of the signature value, inside the hex string.
    const at = (range[1] as number) + 1 + (before?.contents.length as number) * 2 - 10;
    bytes[at] = bytes[at] === 0x30 ? 0x31 : 0x30;
    const [result] = await validate(bytes);
    expect(result?.status).toBe("broken");
  });

  test("page content changed in a later update: changed after signing, other changes", async () => {
    const bytes = appendUpdate(original(), (pdf) => {
      const page = pdf.findPage(0);
      page.put("Contents", pdf.addStream("BT /F1 24 Tf 100 100 Td (Paid in full) Tj ET", {}));
    });
    const [result] = await validate(bytes);
    expect(result?.check.intact).toBe(true);
    expect(result?.status).toBe("changed");
    expect(result?.coversWholeFile).toBe(false);
    expect(result?.changes).toBe("other");
    expect(result?.changeNotes).toContain("Page 1 was changed.");
  });

  test("an existing content stream rewritten in a later update: other changes", async () => {
    const bytes = appendUpdate(original(), (pdf) => {
      const contents = pdf.findPage(0).get("Contents");
      const stream = contents.isArray() ? contents.get(0) : contents;
      stream.writeStream("q Q");
    });
    const [result] = await validate(bytes);
    expect(result?.status).toBe("changed");
    expect(result?.changes).toBe("other");
    expect(result?.changeNotes).toContain("The content of the document was changed.");
  });

  test("a page added in a later update: other changes", async () => {
    const bytes = appendUpdate(original(), (pdf) => {
      pdf.insertPage(-1, pdf.addPage([0, 0, 300, 300], 0, {}, ""));
    });
    const [result] = await validate(bytes);
    expect(result?.changes).toBe("other");
    expect(result?.signedPages).toBe(1);
    expect(result?.changeNotes[0]).toBe("It had 1 pages; the file now has 2.");
  });

  test("page content replaced by a stream marked /Type /XRef: still other changes", async () => {
    // Written by hand: MuPDF won't save an ordinary object marked /Type /XRef. The update
    // replaces the page's content stream, keeping its object number.
    const signed = original();
    const doc = mupdf.Document.openDocument(signed, "application/pdf");
    const pdf = doc.asPDF() as mupdf.PDFDocument;
    const num = pdf.findPage(0).get("Contents").asIndirect();
    const trailer = pdf.getTrailer();
    const root = trailer.get("Root").toString();
    const size = trailer.get("Size").asNumber();
    doc.destroy();
    const tail = new TextDecoder("latin1").decode(signed.subarray(signed.length - 64));
    const prev = Number(/startxref\s+(\d+)/.exec(tail)?.[1]);
    const content = "BT /F1 24 Tf 100 100 Td (Paid in full) Tj ET";
    const object = `${num} 0 obj\n<</Type/XRef/Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`;
    const objectAt = signed.length + 1;
    const xrefAt = objectAt + object.length;
    const update =
      `\n${object}xref\n0 1\n0000000000 65535 f \n${num} 1\n` +
      `${String(objectAt).padStart(10, "0")} 00000 n \n` +
      `trailer\n<</Size ${size}/Root ${root}/Prev ${prev}>>\nstartxref\n${xrefAt}\n%%EOF\n`;
    const bytes = new Uint8Array(signed.length + update.length);
    bytes.set(signed);
    bytes.set(new TextEncoder().encode(update), signed.length);

    const [result] = await validate(bytes);
    expect(result?.check.intact).toBe(true);
    expect(result?.status).toBe("changed");
    expect(result?.changes).toBe("other");
    expect(result?.changeNotes).toContain("The content of the document was changed.");
  });

  test("a note added with our own editor and saved: annotations", async () => {
    const engine = new PdfEngine();
    engine.open(original());
    engine.addAnnotation({
      page: 0,
      kind: "note",
      at: [100, 100],
      text: "Later",
      color: [1, 1, 0],
    });
    const bytes = engine.save();
    engine.close();
    const [result] = await validate(bytes);
    expect(result?.status).toBe("changed");
    expect(result?.changes).toBe("annotations");
  });

  test("saved again without changes: nothing changed", async () => {
    const bytes = appendUpdate(original(), (pdf) => {
      // Touch an object without changing it, so MuPDF writes an update.
      const root = pdf.getTrailer().get("Root");
      root.put("Type", pdf.newName("Catalog"));
    });
    expect(bytes.length).toBeGreaterThan(original().length);
    const [result] = await validate(bytes);
    expect(result?.changes).toBe("none");
    expect(result?.changeNotes).toEqual(["The file was saved again without changes."]);
    expect(result?.status).toBe("changed");
  });

  test("a hostile byte range is refused, not followed", async () => {
    const bytes = original();
    const text = new TextDecoder("latin1").decode(bytes);
    const match = /\/ByteRange\s*\[(\s*\d+\s+\d+\s+\d+\s+\d+\s*)\]/.exec(text);
    if (!match) throw new Error("No byte range");
    const values = match[1]?.trim().split(/\s+/).map(Number) as number[];
    // Make it start at 1 instead of 0, keeping the array's length.
    const replaced = match[1]?.replace(/\d+/, "1") as string;
    expect(replaced.length).toBe(match[1]?.length);
    const at = (match.index as number) + match[0].indexOf(match[1] as string);
    for (let i = 0; i < replaced.length; i++) bytes[at + i] = replaced.charCodeAt(i);
    expect(values[0]).toBe(0);
    const [result] = await validate(bytes);
    expect(result?.status).toBe("broken");
    expect(result?.problems).toContain(
      "Its byte range doesn't start at the beginning of the file.",
    );
  });
});

describe("certificate chains", () => {
  test("a certificate that doesn't match its issuer is flagged", async () => {
    const file = readFixture("generated/signed-by-pdfoctopus.pdf");
    const engine = new PdfEngine();
    engine.open(file);
    const [report] = engine.inspectSignatures().signatures;
    engine.close();
    if (!report?.byteRange) throw new Error("No signature");
    // Damage the signer certificate's own signature (by its issuer). It's outside the signed
    // attributes' hash, so the document's signature still checks out; the chain doesn't.
    const info = pkijs.ContentInfo.fromBER(new Uint8Array(report.contents));
    const signed = new pkijs.SignedData({ schema: info.content });
    const cert = signed.certificates?.[0] as pkijs.Certificate;
    const value = new Uint8Array(cert.signatureValue.valueBlock.valueHexView).slice();
    value[value.length - 1] = (value[value.length - 1] as number) ^ 1;
    cert.signatureValue = new asn1js.BitString({ valueHex: value });
    const der = new Uint8Array(
      new pkijs.ContentInfo({
        contentType: pkijs.ContentInfo.SIGNED_DATA,
        content: signed.toSchema(true),
      })
        .toSchema()
        .toBER(false),
    );
    const before = await verifySignature(file, report.byteRange, report.contents, report.subFilter);
    expect(before.chainLinked).toBe(true);
    expect(before.warnings).toEqual([]);
    const after = await verifySignature(file, report.byteRange, der, report.subFilter);
    expect(after.intact).toBe(true);
    expect(after.chainLinked).toBe(false);
    expect(after.warnings).toContain(
      "A certificate in the chain doesn't match its issuer, so the chain can't be relied on.",
    );
  });
});

describe("saved versions", () => {
  test('"%%EOF" inside a stream doesn\'t count as the end of a version', async () => {
    // A page whose content has 10,001 comments saying "%%EOF".
    const doc = new mupdf.PDFDocument();
    const contents = "% %%EOF\n".repeat(10_001);
    doc.insertPage(-1, doc.addPage([0, 0, 300, 300], 0, {}, contents));
    const buffer = doc.saveToBuffer("");
    const unsigned = buffer.asUint8Array().slice();
    buffer.destroy();
    doc.destroy();

    const engine = new PdfEngine();
    engine.open(unsigned);
    const identity = await loadDigitalId(testId("rsa"), TEST_ID_PASSWORD);
    const prepared = engine.prepareSignature({
      page: 0,
      rect: [50, 50, 250, 110],
      signer: identity.name,
      dateText: "2026-11-20 10:00",
      signingTime: Date.UTC(2026, 10, 20, 10),
      signatureSize: signatureSizeFor(identity),
    });
    engine.finishSignature(await signPdfBytes(identity, prepared.bytes, prepared.byteRange));
    const inspection = engine.inspectSignatures();
    engine.close();
    const [result] = await checkSignatures(inspection.file as Uint8Array, inspection.signatures);
    expect(result?.problems).toEqual([]);
    expect(result?.status).toBe("intact");
    expect([result?.revision, result?.revisions]).toEqual([2, 2]);
  });
});

describe("signed by PDFoctopus, then checked", () => {
  test("a new signature is intact, and the first is still intact after a second", async () => {
    const engine = new PdfEngine();
    engine.open(readFixture("generated/invoice.pdf"));
    for (const name of ["rsa", "ec"] as const) {
      const identity = await loadDigitalId(testId(name), TEST_ID_PASSWORD);
      const prepared = engine.prepareSignature({
        page: 0,
        rect: name === "rsa" ? [50, 50, 250, 110] : [300, 50, 500, 110],
        signer: identity.name,
        dateText: "2026-11-20 10:00",
        signingTime: Date.UTC(2026, 10, 20, 10),
        signatureSize: signatureSizeFor(identity),
      });
      engine.finishSignature(await signPdfBytes(identity, prepared.bytes, prepared.byteRange));
    }
    const inspection = engine.inspectSignatures();
    engine.close();
    const results = await checkSignatures(inspection.file as Uint8Array, inspection.signatures);
    expect(results.map((r) => r.status)).toEqual(["changed", "intact"]);
    expect(results.map((r) => r.changes)).toEqual(["signatures", "none"]);
    expect(results.map((r) => r.check.signer?.name)).toEqual(["Test Signer RSA", "Test Signer EC"]);
    expect(results.map((r) => r.name)).toEqual(["Test Signer RSA", "Test Signer EC"]);
  });
});
