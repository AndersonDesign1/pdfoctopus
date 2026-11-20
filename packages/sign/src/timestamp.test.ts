// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Trusted timestamps (PAdES B-T) against the in-process test timestamp server (testTsa.ts):
// the request we send, accepting a good answer, refusing bad ones, the token in the
// signature, and our validator's view of the result. pyhanko checks a file signed this way in
// CI (check-signatures.py).

import { PdfEngine } from "@pdfoctopus/core/engine";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, test } from "vitest";
import {
  checkSignatures,
  fetchTransport,
  loadDigitalId,
  type SigningIdentity,
  signatureSizeFor,
  signWithRoom,
  TimestampError,
  type TimestampOptions,
} from "./index";
import { readFixture, TEST_ID_PASSWORD, testId } from "./testIds";
import { type TsaFault, testTsa } from "./testTsa";
import { OID, timestampRequest, verifyTimestampToken } from "./timestamp";

const SIGNED_AT = Date.UTC(2026, 10, 20, 9, 0);

let rsa: Promise<SigningIdentity> | null = null;
function signer() {
  rsa ??= loadDigitalId(testId("rsa"), TEST_ID_PASSWORD);
  return rsa;
}

/** Sign the invoice as the app does, with a timestamp from `timestamp`. */
async function signInvoice(
  timestamp: TimestampOptions | undefined,
  signingTime = SIGNED_AT,
  sizes: number[] = [],
) {
  const identity = await signer();
  const engine = new PdfEngine();
  engine.open(readFixture("generated/invoice.pdf"));
  const cms = await signWithRoom(
    identity,
    async (signatureSize) => {
      sizes.push(signatureSize);
      return engine.prepareSignature({
        page: 0,
        rect: [40, 700, 240, 760],
        signer: identity.name,
        dateText: "2026-11-20 09:00 +00:00",
        signingTime,
        signatureSize,
      });
    },
    timestamp,
  );
  const signed = engine.finishSignature(cms);
  const inspection = engine.inspectSignatures();
  engine.close();
  if (!inspection.file) throw new Error("No signatures");
  const [checked] = await checkSignatures(inspection.file, inspection.signatures);
  return { cms, bytes: signed.bytes, checked };
}

function signerInfoOf(cms: Uint8Array): pkijs.SignerInfo {
  const info = pkijs.ContentInfo.fromBER(cms as Uint8Array<ArrayBuffer>);
  return new pkijs.SignedData({ schema: info.content }).signerInfos[0] as pkijs.SignerInfo;
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe("the timestamp request", () => {
  test("asks for a SHA-256 hash of the signature value, with a nonce and the certificate", async () => {
    const tsa = await testTsa({ now: () => new Date(SIGNED_AT + 1000) });
    const { cms } = await signInvoice({ send: tsa.send });
    expect(tsa.requests).toHaveLength(1);
    const req = pkijs.TimeStampReq.fromBER(tsa.requests[0] as Uint8Array<ArrayBuffer>);
    expect(req.version).toBe(1);
    expect(req.certReq).toBe(true);
    expect(req.messageImprint.hashAlgorithm.algorithmId).toBe(OID.sha256);
    const value = new Uint8Array(signerInfoOf(cms).signature.valueBlock.valueHexView);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
    expect(new Uint8Array(req.messageImprint.hashedMessage.valueBlock.valueHexView)).toEqual(hash);
    // Only that hash and a random nonce are sent: nothing from the file.
    const nonce = new Uint8Array(req.nonce?.valueBlock.valueHexView ?? []);
    expect(nonce).toHaveLength(8);
    expect((nonce[0] as number) & 0x80).toBe(0);
    expect(tsa.requests[0]?.length).toBeLessThan(100);
  });

  test("is plain DER (a fixed example, which `openssl ts -query -text` reads)", () => {
    const der = timestampRequest(new Uint8Array(32).fill(0xab), new Uint8Array([1, 2, 3, 4]));
    const hex = Array.from(der, (b) => b.toString(16).padStart(2, "0")).join("");
    // SEQUENCE { version 1, MessageImprint { sha256 (no parameters, as RFC 5754 prefers),
    // the hash }, nonce, certReq TRUE }
    expect(hex).toBe(
      `303d020101302f300b06096086480165030402010420${"ab".repeat(32)}0204010203040101ff`,
    );
  });
});

describe("a good answer", () => {
  test("is embedded as signatureTimeStampToken, exactly as sent, and checks out", async () => {
    const tsa = await testTsa({ now: () => new Date(SIGNED_AT + 5000) });
    const { cms, checked } = await signInvoice({ send: tsa.send });
    const attrs = signerInfoOf(cms).unsignedAttrs?.attributes ?? [];
    expect(attrs.map((a) => a.type)).toEqual([OID.timestampToken]);
    // The token: the second member of the server's answer, byte for byte.
    const response = asn1js.fromBER(tsa.responses[0] as Uint8Array).result as asn1js.Sequence;
    const token = (response.valueBlock.value[1] as asn1js.BaseBlock).valueBeforeDecodeView;
    expect(token.length).toBeGreaterThan(1000);
    expect(contains(cms, token)).toBe(true);
    expect(checked?.status).toBe("intact");
    expect(checked?.check.timestamped).toBe(true);
    expect(checked?.check.timestamp).toMatchObject({
      valid: true,
      problems: [],
      authority: "PDFoctopus Test Timestamp Server",
      time: SIGNED_AT + 5000,
    });
    expect(checked?.check.timestamp?.chain.map((c) => c.name)).toEqual([
      "PDFoctopus Test Timestamp Server",
      "PDFoctopus Test Timestamp CA",
    ]);
  });

  test("works through fetch (POST, application/timestamp-query)", async () => {
    const tsa = await testTsa();
    const { checked } = await signInvoice({
      send: fetchTransport("https://tsa.test/", tsa.fetch),
    });
    expect(checked?.check.timestamp?.valid).toBe(true);
  });

  test("a bigger token than expected gets more room: the file is prepared again", async () => {
    const tsa = await testTsa({ extraCertificates: 20 });
    const sizes: number[] = [];
    const { checked } = await signInvoice({ send: tsa.send }, SIGNED_AT, sizes);
    expect(sizes).toHaveLength(2);
    expect(sizes[0]).toBe(signatureSizeFor(await signer(), true));
    expect(sizes[1] as number).toBeGreaterThan(sizes[0] as number);
    expect(tsa.requests).toHaveLength(2);
    expect(checked?.status).toBe("intact");
    expect(checked?.check.timestamp?.valid).toBe(true);
  });

  test("the timestamp's time is used for the certificate's validity, not the claimed time", async () => {
    // The signer claims 2060, after the certificate expired (2056); the timestamp says 2026.
    const claimed = Date.UTC(2060, 0, 1);
    const tsa = await testTsa({ now: () => new Date(SIGNED_AT) });
    const { checked } = await signInvoice({ send: tsa.send }, claimed);
    expect(checked?.check.signingTime).toBe(claimed);
    expect(checked?.check.validAtSigning).toBe(true);
    // Without a timestamp, only the claim is there, and it's after the certificate expired.
    const { checked: plain } = await signInvoice(undefined, claimed);
    expect(plain?.check.timestamped).toBe(false);
    expect(plain?.check.validAtSigning).toBe(false);
  });
});

describe("bad answers are refused, never silently dropped", () => {
  test.each([
    ["rejected", "rejected", /refused to make a timestamp.*Bad request/],
    ["wrong-imprint", "invalid", /timestamped something else/],
    ["wrong-nonce", "invalid", /nonce doesn't match/],
    ["no-nonce", "invalid", /nonce doesn't match/],
    ["bad-signature", "invalid", /own signature doesn't check out/],
    ["no-certificate", "invalid", /certificate isn't in the timestamp/],
    ["garbage", "invalid", /doesn't check out/],
    ["unreachable", "unreachable", /couldn't be reached.*sign without a timestamp/],
  ] as const)("%s", async (fault: TsaFault, reason, message) => {
    const tsa = await testTsa({ fault });
    const err = await signInvoice({ send: tsa.send, serverName: "The test server" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(TimestampError);
    expect(err.reason).toBe(reason);
    expect(err.message).toMatch(message);
    expect(err.message).toMatch(/^The test server /);
  });

  test("an HTTP error from the server", async () => {
    const failing = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const err = await signInvoice({ send: fetchTransport("https://tsa.test/", failing) }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(TimestampError);
    expect(err.message).toMatch(/couldn't be reached \(HTTP 503\)/);
  });
});

describe("checking a timestamp token", () => {
  test("a token for another signature is reported", async () => {
    const tsa = await testTsa();
    const { cms } = await signInvoice({ send: tsa.send });
    const info = signerInfoOf(cms);
    const token = info.unsignedAttrs?.attributes[0]?.values[0] as asn1js.BaseBlock;
    const other = await verifyTimestampToken(token, new Uint8Array([1, 2, 3]));
    expect(other.problems).toContain("The timestamp is for a different signature.");
    const right = await verifyTimestampToken(
      token,
      new Uint8Array(info.signature.valueBlock.valueHexView),
    );
    expect(right.problems).toEqual([]);
  });
});
