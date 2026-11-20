// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A throwaway RFC 3161 timestamp server that answers in-process, for tests and for signing the
// B-T fixture that check-signatures.py validates: tests can't rely on reaching a real one.
// Its key and certificate are fixtures/test-ids/test-tsa.p12 (test keys only), issued by
// fixtures/trust/pdfoctopus-test-tsa-ca.pem. It can also misbehave in the ways a real server
// (or someone in the middle) might, to test that we refuse its answers.

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { sha256, signingCertificateV2 } from "./cms";
import { loadDigitalId, type SigningIdentity } from "./p12";
import { readFixture, TEST_ID_PASSWORD } from "./testIds";
import type { TimestampTransport } from "./timestamp";

const OID = {
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  testPolicy: "1.3.6.1.4.1.99999.1.1",
} as const;

/** Ways the test server can misbehave. */
export type TsaFault =
  | "rejected"
  | "wrong-imprint"
  | "wrong-nonce"
  | "no-nonce"
  | "bad-signature"
  | "no-certificate"
  | "garbage"
  | "unreachable";

export interface TestTsa {
  /** Answers TimeStampReqs; every request it was sent is in `requests`. */
  send: TimestampTransport;
  /** A fetch function answering POSTs the same way, for fetchTransport. */
  fetch: typeof fetch;
  requests: Uint8Array[];
  /** Every answer it gave. */
  responses: Uint8Array[];
  identity: SigningIdentity;
}

let identity: Promise<SigningIdentity> | null = null;

export function testTsaIdentity(): Promise<SigningIdentity> {
  identity ??= loadDigitalId(readFixture("test-ids/test-tsa.p12"), TEST_ID_PASSWORD);
  return identity;
}

/** A test timestamp server, optionally misbehaving, giving the time `now()`. */
export async function testTsa(
  options: { fault?: TsaFault; now?: () => Date; extraCertificates?: number } = {},
): Promise<TestTsa> {
  const tsa = await testTsaIdentity();
  const requests: Uint8Array[] = [];
  const responses: Uint8Array[] = [];
  let serial = 1;
  const answer: TimestampTransport = async (request) => {
    requests.push(request.slice());
    if (options.fault === "unreachable") throw new TypeError("Failed to fetch");
    if (options.fault === "garbage") return new TextEncoder().encode("<html>Not found</html>");
    const req = pkijs.TimeStampReq.fromBER(request as Uint8Array<ArrayBuffer>);
    if (options.fault === "rejected") {
      const resp = new pkijs.TimeStampResp({
        status: new pkijs.PKIStatusInfo({
          status: 2,
          statusStrings: [new asn1js.Utf8String({ value: "Bad request" })],
        }),
      });
      return new Uint8Array(resp.toSchema().toBER(false));
    }
    const hashed = new Uint8Array(req.messageImprint.hashedMessage.valueBlock.valueHexView).slice();
    if (options.fault === "wrong-imprint") hashed[0] = (hashed[0] as number) ^ 1;
    let nonce = req.nonce;
    if (options.fault === "wrong-nonce") nonce = new asn1js.Integer({ value: 12345 });
    if (options.fault === "no-nonce") nonce = undefined;
    const tst = new pkijs.TSTInfo({
      version: 1,
      policy: OID.testPolicy,
      messageImprint: new pkijs.MessageImprint({
        hashAlgorithm: req.messageImprint.hashAlgorithm,
        hashedMessage: new asn1js.OctetString({ valueHex: hashed }),
      }),
      serialNumber: new asn1js.Integer({ value: serial++ }),
      genTime: options.now?.() ?? new Date(),
      accuracy: new pkijs.Accuracy({ seconds: 1 }),
      ...(nonce ? { nonce } : {}),
    });
    const content = new Uint8Array(tst.toSchema().toBER(false));
    const cert = tsa.signer.certificate;
    const encapsulated = new pkijs.EncapsulatedContentInfo({ eContentType: OID.tstInfo });
    // Set afterwards: PKI.js's constructor would split it into pieces (BER), which real
    // timestamp servers don't do and some validators (pyhanko) refuse.
    encapsulated.eContent = new asn1js.OctetString({ valueHex: content });
    const signedData = new pkijs.SignedData({
      version: 3,
      encapContentInfo: encapsulated,
      signerInfos: [
        new pkijs.SignerInfo({
          version: 1,
          sid: new pkijs.IssuerAndSerialNumber({
            issuer: cert.issuer,
            serialNumber: cert.serialNumber,
          }),
          signedAttrs: new pkijs.SignedAndUnsignedAttributes({
            type: 0,
            attributes: [
              new pkijs.Attribute({
                type: OID.contentType,
                values: [new asn1js.ObjectIdentifier({ value: OID.tstInfo })],
              }),
              new pkijs.Attribute({
                type: OID.messageDigest,
                values: [new asn1js.OctetString({ valueHex: await sha256(content) })],
              }),
              new pkijs.Attribute({
                type: OID.signingCertificateV2,
                values: [await signingCertificateV2(tsa)],
              }),
            ],
          }),
        }),
      ],
      certificates:
        options.fault === "no-certificate" || !req.certReq
          ? undefined
          : [
              cert,
              ...tsa.chain.map((c) => c.certificate),
              // More certificates than usual, to make the token bigger than expected.
              ...Array.from({ length: options.extraCertificates ?? 0 }, () => cert),
            ],
    });
    await signedData.sign(
      tsa.privateKey,
      0,
      "SHA-256",
      undefined,
      new pkijs.CryptoEngine({ name: "webcrypto", crypto: globalThis.crypto }),
    );
    if (options.fault === "bad-signature") {
      const signerInfo = signedData.signerInfos[0] as pkijs.SignerInfo;
      const value = new Uint8Array(signerInfo.signature.valueBlock.valueHexView).slice();
      value[10] = (value[10] as number) ^ 1;
      signerInfo.signature = new asn1js.OctetString({ valueHex: value });
    }
    const resp = new pkijs.TimeStampResp({
      status: new pkijs.PKIStatusInfo({ status: 0 }),
      timeStampToken: new pkijs.ContentInfo({
        contentType: pkijs.ContentInfo.SIGNED_DATA,
        content: signedData.toSchema(true),
      }),
    });
    return new Uint8Array(resp.toSchema().toBER(false));
  };
  const send: TimestampTransport = async (request) => {
    const response = await answer(request);
    responses.push(response.slice());
    return response;
  };
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== "POST") return new Response("", { status: 405 });
    const type = new Headers(init.headers).get("Content-Type");
    if (type !== "application/timestamp-query") return new Response("", { status: 415 });
    const body = new Uint8Array(await new Response(init.body).arrayBuffer());
    const reply = await send(body);
    return new Response(reply as BodyInit, {
      status: 200,
      headers: { "Content-Type": "application/timestamp-reply" },
    });
  }) as typeof fetch;
  return { send, fetch: fetchImpl, requests, responses, identity: tsa };
}
