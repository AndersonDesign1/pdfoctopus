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
import { makeTsaIdentity, type TsaFault, testTsa, testTsaRoot } from "./testTsa";
import { canTimestamp, OID, timestampRequest, verifyTimestampToken } from "./timestamp";
import { tsaRoots } from "./tsaRoots";

const SIGNED_AT = Date.UTC(2026, 10, 20, 9, 0);

let rsa: Promise<SigningIdentity> | null = null;
function signer() {
  rsa ??= loadDigitalId(testId("rsa"), TEST_ID_PASSWORD);
  return rsa;
}

/** In these tests, the test timestamp server's root stands in for the real servers' roots. */
const TEST_ROOTS = [testTsaRoot()];

/**
 * Sign the invoice as the app does, with a timestamp from `timestamp` (trusting the test root
 * unless it says otherwise), and check it trusting `checkRoots`.
 */
async function signInvoice(
  timestamp: (Omit<TimestampOptions, "roots"> & { roots?: TimestampOptions["roots"] }) | undefined,
  signingTime = SIGNED_AT,
  sizes: number[] = [],
  checkRoots = TEST_ROOTS,
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
    timestamp && { roots: TEST_ROOTS, ...timestamp },
  );
  const signed = engine.finishSignature(cms);
  const inspection = engine.inspectSignatures();
  engine.close();
  if (!inspection.file) throw new Error("No signatures");
  const [checked] = await checkSignatures(inspection.file, inspection.signatures, checkRoots);
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
      trusted: true,
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

describe("only timestamps from known servers are trusted", () => {
  test("asking for one: a server whose certificate doesn't lead to its root is refused", async () => {
    // A valid token in every other way, from a certificate someone made themselves.
    const tsa = await testTsa({ identity: await makeTsaIdentity() });
    const err = await signInvoice({ send: tsa.send, serverName: "The test server" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(TimestampError);
    expect(err.message).toMatch(/^The test server's answer couldn't be verified/);
    // And the real servers' roots don't vouch for the test server either.
    const test = await testTsa();
    const real = await signInvoice({ send: test.send, roots: tsaRoots().digicert }).catch((e) => e);
    expect(real).toBeInstanceOf(TimestampError);
    expect(real.message).toMatch(/couldn't be verified/);
  });

  test("in a signed file: an unknown server's timestamp is shown but doesn't replace /M", async () => {
    const claimed = Date.UTC(2060, 0, 1); // after the signer's certificate expired
    const homeMade = await makeTsaIdentity();
    const tsa = await testTsa({ identity: homeMade, now: () => new Date(SIGNED_AT) });
    // Signed trusting the home-made server (as a forger would), checked trusting only ours.
    const { checked } = await signInvoice(
      { send: tsa.send, roots: [homeMade.signer.certificate] },
      claimed,
    );
    expect(checked?.status).toBe("intact");
    expect(checked?.check.timestamp).toMatchObject({ valid: true, trusted: false });
    expect(checked?.check.validAtSigning).toBe(false);
    expect(checked?.check.warnings.join(" ")).toMatch(/isn't one we know/);
    // The same file checked with the bundled roots only (as the app does): not trusted either.
    const { checked: bundled } = await signInvoice(
      { send: tsa.send, roots: [homeMade.signer.certificate] },
      claimed,
      [],
      tsaRoots().sectigo,
    );
    expect(bundled?.check.timestamp?.trusted).toBe(false);
  });
});

describe("timestamp server certificates (RFC 3161: critical, timeStamping only)", () => {
  test.each([
    ["not critical", { critical: false }],
    ["with another purpose too", { purposes: ["1.3.6.1.5.5.7.3.8", "1.3.6.1.5.5.7.3.3"] }],
    ["for something else", { purposes: ["1.3.6.1.5.5.7.3.3"] }],
  ])("refused when the extended key usage is %s", async (_what, eku) => {
    const identity = await makeTsaIdentity(eku);
    expect(canTimestamp(identity.signer.certificate)).toBe(false);
    const tsa = await testTsa({ identity });
    const err = await signInvoice({
      send: tsa.send,
      roots: [identity.signer.certificate],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TimestampError);
    expect(err.message).toMatch(/certificate that isn't for timestamps/);
  });

  test("accepted when it's right (the test server, and one made here)", async () => {
    expect(canTimestamp((await makeTsaIdentity()).signer.certificate)).toBe(true);
    const tsa = await testTsa();
    expect(canTimestamp(tsa.identity.signer.certificate)).toBe(true);
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
