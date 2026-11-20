// SPDX-License-Identifier: AGPL-3.0-or-later

import { writeFileSync } from "node:fs";
import { PdfEngine } from "@pdfoctopus/core/engine";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, test } from "vitest";
import {
  DigitalIdError,
  displayName,
  identityProblem,
  loadDigitalId,
  rangeBytes,
  type SigningIdentity,
  signatureSizeFor,
  signPdfBytes,
} from "./index";
import { readFixture, TEST_ID_PASSWORD, testId } from "./testIds";

const OID_SIGNING_CERTIFICATE_V2 = "1.2.840.113549.1.9.16.2.47";
const OID_SIGNING_TIME = "1.2.840.113549.1.9.5";

/** Sign the open document in `engine` with `identity`, as the app does. */
async function sign(
  engine: PdfEngine,
  identity: SigningIdentity,
  where: { page: number; rect?: [number, number, number, number]; field?: string },
) {
  const prepared = engine.prepareSignature({
    ...where,
    signer: identity.name,
    dateText: "2026-11-19 14:30 +00:00",
    signingTime: Date.UTC(2026, 10, 19, 14, 30),
    reason: "Approved",
    signatureSize: signatureSizeFor(identity),
  });
  const cms = await signPdfBytes(identity, prepared.bytes, prepared.byteRange);
  return { prepared, cms, signed: engine.finishSignature(cms) };
}

/** Every signature in a file: its byte range and CMS, read straight from the bytes. */
function signaturesIn(bytes: Uint8Array): Sig[] {
  const text = new TextDecoder("latin1").decode(bytes);
  const out: Sig[] = [];
  for (const m of text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)) {
    const range = [m[1], m[2], m[3], m[4]].map(Number) as Sig["range"];
    const hex = text.slice(range[1] + 1, range[2] - 1);
    const padded = new Uint8Array(hex.length / 2);
    for (let i = 0; i < padded.length; i++) {
      padded[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    // The zeros after the DER are padding; the DER says how long it is.
    const der = asn1js.fromBER(padded);
    out.push({ range, cms: padded.slice(0, der.offset) });
  }
  return out;
}

interface Sig {
  range: [number, number, number, number];
  cms: Uint8Array;
}

const caPem = new TextDecoder().decode(readFixture("trust/pdfoctopus-test-signing-ca.pem"));
const caCert = pkijs.Certificate.fromBER(
  Uint8Array.from(atob(caPem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0)),
);

/** Check a signature with PKI.js: the CMS verifies over the range, and chains to the test CA. */
async function verify(bytes: Uint8Array, sig: Sig | undefined) {
  if (!sig) throw new Error("No signature");
  const content = pkijs.ContentInfo.fromBER(new Uint8Array(sig.cms));
  const signed = new pkijs.SignedData({ schema: content.content });
  // The file as it was when this signature was made (later ones were appended after it).
  const [, , b, bLength] = sig.range;
  const data = rangeBytes(bytes.subarray(0, b + bLength), sig.range);
  const result = await signed.verify({
    signer: 0,
    data: data.buffer as ArrayBuffer,
    trustedCerts: [caCert],
    checkChain: true,
    checkDate: new Date(Date.UTC(2026, 10, 19)),
    extendedMode: true,
  });
  return {
    ok: result.signatureVerified === true && result.signerCertificateVerified === true,
    signed,
  };
}

describe("loading a digital ID", () => {
  test("an RSA .p12 with AES-256 encryption", async () => {
    const id = await loadDigitalId(testId("rsa"), TEST_ID_PASSWORD);
    expect(id.name).toBe("Test Signer RSA");
    expect(id.issuer).toBe("PDFoctopus Test Signing CA");
    expect(id.chain).toHaveLength(1);
    expect(id.canSign).toBe(true);
    expect(id.privateKey.extractable).toBe(false);
    expect(id.privateKey.usages).toEqual(["sign"]);
    expect(identityProblem(id, new Date(Date.UTC(2026, 10, 19)))).toBeNull();
  });

  test("an elliptic-curve (P-256) .p12", async () => {
    const id = await loadDigitalId(testId("ec"), TEST_ID_PASSWORD);
    expect(id.name).toBe("Test Signer EC");
    expect(id.privateKey.algorithm.name).toBe("ECDSA");
  });

  test("the certificate that matches the key is used, not just the first one", async () => {
    // Someone else's certificate comes first, and nothing marks which is the key's.
    const id = await loadDigitalId(testId("ec-unmarked"), TEST_ID_PASSWORD);
    expect(id.name).toBe("Test Signer EC");
    expect(id.chain.map((c) => displayName(c.certificate.subject))).toEqual([
      "Someone Else",
      "PDFoctopus Test Signing CA",
    ]);
    // And a signature made with it verifies.
    const engine = new PdfEngine();
    engine.open(readFixture("generated/invoice.pdf"));
    const { signed } = await sign(engine, id, { page: 0, rect: [40, 700, 240, 760] });
    expect((await verify(signed.bytes, signaturesIn(signed.bytes)[0])).ok).toBe(true);
  });

  test("a file with no certificate for its key is refused", async () => {
    const err = await loadDigitalId(testId("ec-wrong-cert"), TEST_ID_PASSWORD).catch((e) => e);
    expect(err).toBeInstanceOf(DigitalIdError);
    expect(err.reason).toBe("no-key");
    expect(err.message).toMatch(/no certificate for its private key/);
  });

  test("a wrong password is refused", async () => {
    await expect(loadDigitalId(testId("rsa"), "wrong")).rejects.toMatchObject({
      reason: "password",
      message: "The password is wrong.",
    });
  });

  test("old 3DES encryption is explained", async () => {
    const err = await loadDigitalId(testId("3des"), TEST_ID_PASSWORD).catch((e) => e);
    expect(err).toBeInstanceOf(DigitalIdError);
    expect(err.reason).toBe("unsupported");
    expect(err.message).toMatch(/old encryption/);
  });

  test("something that isn't a .p12 is refused", async () => {
    const err = await loadDigitalId(readFixture("generated/invoice.pdf"), "x").catch((e) => e);
    expect(err).toMatchObject({ reason: "not-p12" });
  });

  test("expired or not-yet-valid certificates are reported", async () => {
    const id = await loadDigitalId(testId("rsa"), TEST_ID_PASSWORD);
    expect(identityProblem(id, new Date(Date.UTC(2060, 0, 1)))).toMatch(/expired on 2056-/);
    expect(identityProblem(id, new Date(Date.UTC(2020, 0, 1)))).toMatch(/isn't valid until/);
    expect(identityProblem({ ...id, canSign: false }, new Date(Date.UTC(2026, 10, 19)))).toMatch(
      /isn't meant for signing/,
    );
  });
});

describe("signing a PDF", () => {
  test("a new visible signature is PAdES B-B and verifies", async () => {
    const id = await loadDigitalId(testId("rsa"), TEST_ID_PASSWORD);
    const original = readFixture("generated/invoice.pdf");
    const engine = new PdfEngine();
    engine.open(original);
    const { prepared, signed } = await sign(engine, id, { page: 0, rect: [40, 700, 240, 760] });
    expect(prepared.field).toBe("Signature1");

    const bytes = signed.bytes;
    // Saved incrementally: the original file is untouched at the start.
    expect(bytes.subarray(0, original.length)).toEqual(original);
    const text = new TextDecoder("latin1").decode(bytes.subarray(original.length));
    expect(text).toContain("/SubFilter/ETSI.CAdES.detached");
    expect(text).toContain("/Filter/Adobe.PPKLite");
    expect(text).toMatch(/\/M\(D:20261119143000Z\)/);

    const [sig] = signaturesIn(bytes);
    expect(sig?.range).toEqual(prepared.byteRange);
    // The byte range covers the whole file except the signature.
    expect(sig?.range[0]).toBe(0);
    expect((sig?.range[2] ?? 0) + (sig?.range[3] ?? 0)).toBe(bytes.length);

    const { ok, signed: cms } = await verify(bytes, sig);
    expect(ok).toBe(true);
    const signerInfo = cms.signerInfos[0] as pkijs.SignerInfo;
    const types = signerInfo.signedAttrs?.attributes.map((a) => a.type) ?? [];
    expect(types).toContain(OID_SIGNING_CERTIFICATE_V2);
    expect(types).not.toContain(OID_SIGNING_TIME);
    expect(cms.encapContentInfo.eContent).toBeUndefined(); // detached
    expect(cms.certificates).toHaveLength(2); // the signer and its CA
    // signingCertificateV2 holds the SHA-256 of the signer's certificate.
    const attr = signerInfo.signedAttrs?.attributes.find(
      (a) => a.type === OID_SIGNING_CERTIFICATE_V2,
    );
    if (!attr) throw new Error("No signingCertificateV2");
    const certs = (attr.values[0] as asn1js.Sequence).valueBlock.value[0] as asn1js.Sequence;
    const first = (certs.valueBlock.value[0] as asn1js.Sequence).valueBlock.value[0];
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", id.signer.der as BufferSource),
    );
    expect(new Uint8Array((first as asn1js.OctetString).valueBlock.valueHexView)).toEqual(hash);

    // The signed file is the open document now: it shows the signed field.
    expect(engine.signatureFields()).toEqual([
      expect.objectContaining({ name: "Signature1", page: 0, signed: true }),
    ]);
    // Saving without changes gives back the signed file as it is.
    expect(engine.save()).toEqual(bytes);
    if (process.env.PDFOCTOPUS_SIGNED_OUT)
      writeFileSync(`${process.env.PDFOCTOPUS_SIGNED_OUT}/one.pdf`, bytes);
  });

  test("a second signature leaves the first one valid", async () => {
    const rsa = await loadDigitalId(testId("rsa"), TEST_ID_PASSWORD);
    const ec = await loadDigitalId(testId("ec"), TEST_ID_PASSWORD);
    const engine = new PdfEngine();
    engine.open(readFixture("generated/invoice.pdf"));
    const first = (await sign(engine, rsa, { page: 0, rect: [40, 700, 240, 760] })).signed.bytes;
    const second = (await sign(engine, ec, { page: 0, rect: [300, 700, 500, 760] })).signed.bytes;
    expect(second.subarray(0, first.length)).toEqual(first);
    const sigs = signaturesIn(second);
    expect(sigs).toHaveLength(2);
    for (const sig of sigs) expect((await verify(second, sig)).ok).toBe(true);
    // The first signature covers exactly the file as it was after the first signing.
    expect((sigs[0]?.range[2] ?? 0) + (sigs[0]?.range[3] ?? 0)).toBe(first.length);
    expect(engine.signatureFields().map((f) => [f.name, f.signed])).toEqual([
      ["Signature1", true],
      ["Signature2", true],
    ]);
    if (process.env.PDFOCTOPUS_SIGNED_OUT)
      writeFileSync(`${process.env.PDFOCTOPUS_SIGNED_OUT}/two.pdf`, second);
  });

  test("changes made before signing are signed with it; ones after are appended", async () => {
    const id = await loadDigitalId(testId("rsa"), TEST_ID_PASSWORD);
    const original = readFixture("generated/invoice.pdf");
    const engine = new PdfEngine();
    engine.open(original);
    engine.addAnnotation({
      page: 0,
      kind: "note",
      at: [100, 100],
      text: "Before",
      color: [1, 0.8, 0],
    });
    const signed = (await sign(engine, id, { page: 0, rect: [40, 700, 240, 760] })).signed.bytes;
    expect(signed.subarray(0, original.length)).toEqual(original);
    // Signing can't be undone.
    expect(engine.history().canUndo).toBe(false);
    engine.addAnnotation({
      page: 0,
      kind: "note",
      at: [140, 100],
      text: "After",
      color: [1, 0.8, 0],
    });
    const saved = engine.save();
    expect(saved.subarray(0, signed.length)).toEqual(signed);
    const [sig] = signaturesIn(saved);
    expect((await verify(saved, sig)).ok).toBe(true);
    // Undoing the later change brings back the signed file exactly.
    engine.undo();
    expect(engine.save()).toEqual(signed);
  });

  test("an existing empty signature field can be signed", async () => {
    const id = await loadDigitalId(testId("rsa"), TEST_ID_PASSWORD);
    const engine = new PdfEngine();
    engine.open(readFixture("generated/invoice.pdf"));
    engine.addField({ page: 0, kind: "signature", rect: [50, 600, 250, 650], name: "Approver" });
    const fields = engine.signatureFields();
    expect(fields).toEqual([expect.objectContaining({ name: "Approver", signed: false })]);
    const { signed } = await sign(engine, id, { page: 0, field: "Approver" });
    const [sig] = signaturesIn(signed.bytes);
    expect((await verify(signed.bytes, sig)).ok).toBe(true);
    expect(engine.signatureFields()).toEqual([
      expect.objectContaining({ name: "Approver", signed: true }),
    ]);
    // A signed field can't be signed again.
    expect(() =>
      engine.prepareSignature({
        page: 0,
        field: "Approver",
        signer: "x",
        dateText: "x",
        signingTime: Date.now(),
      }),
    ).toThrow(/already signed/);
  });

  test("signing is refused when the next save would rewrite the file", async () => {
    const engine = new PdfEngine();
    const spec = {
      page: 0,
      rect: [40, 700, 240, 760] as [number, number, number, number],
      signer: "x",
      dateText: "x",
      signingTime: Date.now(),
    };
    engine.open(readFixture("generated/invoice.pdf"));
    engine.setPassword({
      openPassword: "pw",
      permissions: {
        print: true,
        copy: true,
        edit: true,
        annotate: true,
        fillForms: true,
        assemble: true,
      },
    });
    expect(() => engine.prepareSignature(spec)).toThrow(/password change is waiting/);

    engine.open(readFixture("generated/encrypted-aes256.pdf"));
    engine.authenticate("open-sesame");
    expect(() => engine.prepareSignature(spec)).toThrow(/has a password/);

    engine.open(readFixture("generated/malformed-bad-startxref.pdf"));
    expect(() => engine.prepareSignature(spec)).toThrow(/repaired/);

    engine.open(readFixture("generated/invoice.pdf"));
    engine.markForRedaction([{ page: 0, quads: [[50, 50, 150, 50, 50, 70, 150, 70]] }]);
    engine.applyRedactions();
    expect(() => engine.prepareSignature(spec)).toThrow(/Redactions were applied/);
  });

  test("a signature too big for the space set aside is refused", async () => {
    const engine = new PdfEngine();
    engine.open(readFixture("generated/invoice.pdf"));
    engine.prepareSignature({
      page: 0,
      rect: [40, 700, 240, 760],
      signer: "x",
      dateText: "x",
      signingTime: Date.now(),
      signatureSize: 1024,
    });
    expect(() => engine.finishSignature(new Uint8Array(1025))).toThrow(/only 1024 were set aside/);
  });
});
