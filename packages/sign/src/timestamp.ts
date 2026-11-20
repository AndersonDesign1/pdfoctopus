// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Trusted timestamps (RFC 3161) for PAdES B-T signatures. After the signature is made, the
// SHA-256 hash of its signature value (a fingerprint, never the file) is sent to a public
// timestamp server, which signs it with the time. The token it sends back is checked (status,
// the hash we sent, our nonce, and its own signature) and added to the signature as the
// unsigned attribute signatureTimeStampToken. Only the user can switch this on, and only the
// two servers below can be used.
//
// verifyTimestampToken checks a token found in a signature, for the signature panel.

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import {
  attribute,
  checkSigner,
  DIGESTS,
  digestOf,
  equalBytes,
  signerCertificate,
} from "./cmsCheck";
import { displayName } from "./p12";

export const TIMESTAMP_SERVERS = {
  digicert: { name: "DigiCert", url: "http://timestamp.digicert.com" },
  sectigo: { name: "Sectigo", url: "https://timestamp.sectigo.com" },
} as const;

export type TimestampServer = keyof typeof TIMESTAMP_SERVERS;

/** Sends a DER TimeStampReq to the timestamp server and gives back its DER TimeStampResp. */
export type TimestampTransport = (request: Uint8Array) => Promise<Uint8Array>;

/** Why a timestamp couldn't be added, with a message to show as it is. */
export class TimestampError extends Error {
  constructor(
    message: string,
    readonly reason: "unreachable" | "rejected" | "invalid",
  ) {
    super(message);
    this.name = "TimestampError";
  }
}

export const OID = {
  sha256: "2.16.840.1.101.3.4.2.1",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  signedData: "1.2.840.113549.1.7.2",
  timestampToken: "1.2.840.113549.1.9.16.2.14",
  timeStamping: "1.3.6.1.5.5.7.3.8",
  extKeyUsage: "2.5.29.37",
} as const;

/** The most a timestamp response may be: real ones are 5 to 10 KB. */
export const MAX_TIMESTAMP_RESPONSE = 256 * 1024;

/** A random nonce: 8 bytes, positive, with no leading zero byte (so it encodes as given). */
function makeNonce(): Uint8Array {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(8));
  nonce[0] = ((nonce[0] as number) & 0x7f) | 0x01;
  return nonce;
}

/** A DER TimeStampReq for a SHA-256 hash, asking for the server's certificate. */
export function timestampRequest(hash: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (hash.length !== 32) throw new Error("The hash must be SHA-256");
  const request = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
      hashedMessage: new asn1js.OctetString({ valueHex: hash.slice() }),
    }),
    nonce: new asn1js.Integer({ valueHex: nonce.slice() }),
    certReq: true,
  });
  return new Uint8Array(request.toSchema().toBER(false));
}

/** What a timestamp token says, once checked. */
export interface TimestampInfo {
  /** The time it was made, in ms since 1970. */
  time: number;
  /** Who made it: the timestamp server's certificate name. */
  authority: string;
  /** Problems that mean it can't be relied on (empty if it checks out). */
  problems: string[];
  /** The timestamp server's certificate, if the token carries it. */
  certificate?: pkijs.Certificate;
  /** The other certificates the token carries (its chain). */
  certificates: pkijs.Certificate[];
}

function readToken(token: asn1js.BaseBlock): { signedData: pkijs.SignedData; tst: pkijs.TSTInfo } {
  const info = new pkijs.ContentInfo({ schema: token });
  if (info.contentType !== OID.signedData) throw new Error("not SignedData");
  const signedData = new pkijs.SignedData({ schema: info.content });
  if (signedData.encapContentInfo.eContentType !== OID.tstInfo) throw new Error("not TSTInfo");
  const eContent = signedData.encapContentInfo.eContent;
  if (!eContent) throw new Error("no TSTInfo");
  const tst = pkijs.TSTInfo.fromBER(new Uint8Array(eContent.getValue()));
  return { signedData, tst };
}

/** Whether a certificate may make timestamps (extended key usage timeStamping, if it says). */
function canTimestamp(cert: pkijs.Certificate): boolean {
  const ext = cert.extensions?.find((e) => e.extnID === OID.extKeyUsage);
  if (!ext) return false;
  const usage = ext.parsedValue as pkijs.ExtKeyUsage | undefined;
  return !!usage?.keyPurposes?.includes(OID.timeStamping);
}

/**
 * Check a timestamp token (the DER-decoded ContentInfo) against the signature value it
 * should cover: its own signature, and that its hash is of `signatureValue`.
 */
export async function verifyTimestampToken(
  token: asn1js.BaseBlock,
  signatureValue: Uint8Array,
): Promise<TimestampInfo> {
  const result: TimestampInfo = { time: 0, authority: "", problems: [], certificates: [] };
  let signedData: pkijs.SignedData;
  let tst: pkijs.TSTInfo;
  try {
    ({ signedData, tst } = readToken(token));
  } catch {
    result.problems.push("The timestamp can't be read.");
    return result;
  }
  result.time = tst.genTime.getTime();
  const signerInfo = signedData.signerInfos[0];
  const cert = signerInfo ? signerCertificate(signedData, signerInfo) : null;
  result.certificates = (signedData.certificates ?? []).filter(
    (c): c is pkijs.Certificate => c instanceof pkijs.Certificate && c !== cert,
  );
  if (cert) {
    result.certificate = cert;
    result.authority = displayName(cert.subject) || "an unknown timestamp server";
  } else {
    result.authority = "an unknown timestamp server";
  }

  const imprintHash = DIGESTS[tst.messageImprint.hashAlgorithm.algorithmId];
  if (!imprintHash) {
    result.problems.push("The timestamp uses a hash that can't be checked.");
  } else {
    const expected = await digestOf(imprintHash, signatureValue);
    const actual = new Uint8Array(tst.messageImprint.hashedMessage.valueBlock.valueHexView);
    if (!equalBytes(expected, actual)) {
      result.problems.push("The timestamp is for a different signature.");
    }
  }
  if (!signerInfo) {
    result.problems.push("The timestamp has no signer.");
    return result;
  }
  if (!cert) {
    result.problems.push("The timestamp server's certificate isn't in the timestamp.");
    return result;
  }
  const digestName = DIGESTS[signerInfo.digestAlgorithm.algorithmId];
  if (!digestName) {
    result.problems.push("The timestamp uses a hash that can't be checked.");
    return result;
  }
  const eContent = new Uint8Array(signedData.encapContentInfo.eContent?.getValue() ?? []);
  const problem = await checkSigner(signerInfo, cert, eContent, digestName);
  if (problem === "algorithm") {
    result.problems.push("The timestamp uses a signature algorithm that can't be checked.");
  } else if (problem) {
    result.problems.push("The timestamp's own signature doesn't check out.");
  }
  if (!canTimestamp(cert)) {
    result.problems.push("The timestamp was made with a certificate that isn't for timestamps.");
  }
  const notBefore = cert.notBefore.value.getTime();
  const notAfter = cert.notAfter.value.getTime();
  if (result.time < notBefore || result.time > notAfter) {
    result.problems.push("The timestamp server's certificate wasn't valid at that time.");
  }
  return result;
}

function statusText(status: pkijs.PKIStatusInfo): string {
  const words = (status.statusStrings ?? [])
    .map((s) => s.valueBlock.value)
    .filter(Boolean)
    .join(" ");
  return words ? ` It said: “${words.slice(0, 200)}”.` : "";
}

/**
 * Get a timestamp token for a signature value from a timestamp server, through `send`.
 * Checks it fully before returning its DER bytes. Throws TimestampError with a message.
 */
export async function requestTimestamp(
  signatureValue: Uint8Array,
  send: TimestampTransport,
  serverName = "The timestamp server",
): Promise<Uint8Array> {
  const hash = await digestOf("SHA-256", signatureValue);
  const nonce = makeNonce();
  const request = timestampRequest(hash, nonce);
  let response: Uint8Array;
  try {
    response = await send(request);
  } catch (err) {
    // The desktop app's native side reports errors as plain strings.
    const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
    const detail = text ? ` (${text.slice(0, 200)})` : "";
    throw new TimestampError(
      `${serverName} couldn't be reached${detail}. Check your internet connection, or sign without a timestamp.`,
      "unreachable",
    );
  }
  if (response.length > MAX_TIMESTAMP_RESPONSE) {
    throw new TimestampError(`${serverName} sent back something too big.`, "invalid");
  }
  const invalid = () =>
    new TimestampError(`${serverName} sent back a timestamp that doesn't check out.`, "invalid");

  const parsed = asn1js.fromBER(response);
  if (parsed.offset === -1) throw invalid();
  let resp: pkijs.TimeStampResp;
  try {
    resp = new pkijs.TimeStampResp({ schema: parsed.result });
  } catch {
    throw invalid();
  }
  const status = resp.status.status;
  if (status !== 0 && status !== 1) {
    throw new TimestampError(
      `${serverName} refused to make a timestamp.${statusText(resp.status)}`,
      "rejected",
    );
  }
  // The token exactly as the server sent it: the response's second member.
  const tokenBlock = (parsed.result as asn1js.Sequence).valueBlock.value[1];
  if (!tokenBlock) throw invalid();
  const tokenBytes = new Uint8Array(tokenBlock.valueBeforeDecodeView);

  let tst: pkijs.TSTInfo;
  try {
    tst = readToken(asn1js.fromBER(tokenBytes).result).tst;
  } catch {
    throw invalid();
  }
  const imprint = tst.messageImprint;
  if (
    imprint.hashAlgorithm.algorithmId !== OID.sha256 ||
    !equalBytes(new Uint8Array(imprint.hashedMessage.valueBlock.valueHexView), hash)
  ) {
    throw new TimestampError(`${serverName} timestamped something else.`, "invalid");
  }
  const echoed = tst.nonce ? new Uint8Array(tst.nonce.valueBlock.valueHexView) : null;
  if (!echoed || !equalBytes(echoed, nonce)) {
    throw new TimestampError(
      `${serverName} sent back a timestamp for another request (the nonce doesn't match).`,
      "invalid",
    );
  }
  const check = await verifyTimestampToken(asn1js.fromBER(tokenBytes).result, signatureValue);
  if (check.problems.length > 0) {
    throw new TimestampError(
      `${serverName} sent back a timestamp that doesn't check out: ${check.problems.join(" ")}`,
      "invalid",
    );
  }
  return tokenBytes;
}

/** The timestamp token attribute on a signer, if it has one. */
export function timestampTokenOf(signerInfo: pkijs.SignerInfo): asn1js.BaseBlock | null {
  return (
    (attribute(signerInfo.unsignedAttrs, OID.timestampToken)?.values[0] as
      | asn1js.BaseBlock
      | undefined) ?? null
  );
}

/** Add a timestamp token (DER) to a signer as its signatureTimeStampToken attribute. */
export function addTimestampToken(signerInfo: pkijs.SignerInfo, token: Uint8Array): void {
  const parsed = asn1js.fromBER(token);
  if (parsed.offset === -1) throw new Error("The timestamp token can't be read");
  signerInfo.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
    type: 1,
    attributes: [new pkijs.Attribute({ type: OID.timestampToken, values: [parsed.result] })],
  });
}

/**
 * A transport that POSTs to a timestamp server with fetch. Browsers block this for the public
 * servers (they send no CORS headers, and DigiCert's is plain http), so the web app doesn't use
 * it: the desktop app sends requests from its native side instead. It's for tests (with a fake
 * fetch) and scripts run outside a browser.
 */
export function fetchTransport(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): TimestampTransport {
  return async (request) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/timestamp-query" },
      body: request as BodyInit,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes;
  };
}
