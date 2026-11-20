// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Checking a signature in a PDF: the CMS / PKCS #7 blob from its /Contents, against the bytes
// in its byte range. The bytes are hashed and compared with the messageDigest signed
// attribute, and the signer's signature over the signed attributes is checked with WebCrypto
// (RSA PKCS #1 v1.5, RSA-PSS, ECDSA P-256/384/521). A timestamp token (PAdES B-T), if there
// is one, is checked too: its own signature, and that it's for this signature; its time is
// then used for the certificate's validity at signing instead of the signer's claimed time.
// The signer's certificate and the chain the signature carries are described, but not checked
// against a trust list: the browser has none, so who signed is reported as "not verified".
// packages/core reads the signatures from the file and works out what was changed after each
// one; checkSignatures puts both together.

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import {
  attribute,
  certificatesOf,
  checkSigner,
  DIGESTS,
  digestOf,
  engine,
  equalBytes,
  signerCertificate,
} from "./cmsCheck";
import { displayName } from "./p12";
import { timestampTokenOf, verifyTimestampToken } from "./timestamp";

/** A certificate, described for people. */
export interface CertificateInfo {
  /** The common name, or the organisation if it has no common name. */
  name: string;
  /** The whole subject, e.g. "CN=Test Signer RSA, O=PDFoctopus test". */
  subject: string;
  /** The issuer's name, and its whole subject. */
  issuerName: string;
  issuer: string;
  /** Serial number in hex. */
  serial: string;
  notBefore: number;
  notAfter: number;
  /** Whether it was issued by itself (a root, or a home-made certificate). */
  selfSigned: boolean;
}

/** A trusted timestamp on a signature, once checked. */
export interface TimestampCheck {
  /** When the timestamp server says the signature existed, in ms since 1970. */
  time: number;
  /** The timestamp server, by its certificate's name. */
  authority: string;
  /** Whether the token checks out (its signature, and that it's for this signature). */
  valid: boolean;
  /** Why it doesn't, in plain words. */
  problems: string[];
  /** The timestamp server's certificate and its issuers, as far as the token carries them. */
  chain: CertificateInfo[];
}

/** The result of the cryptographic check. */
export interface CryptoCheck {
  /**
   * true: the bytes are unchanged and the signature checks out. false: the signature is
   * broken. null: it couldn't be checked (an unsupported format or algorithm).
   */
  intact: boolean | null;
  /** Why it's broken or couldn't be checked, in plain words. */
  problems: string[];
  /** Things worth knowing that don't break it (a weak hash, an expired certificate). */
  warnings: string[];
  /** The hash used for the document, e.g. "SHA-256". */
  digestAlgorithm?: string;
  signer?: CertificateInfo;
  /** The signer's certificate, then its issuer and so on, as far as the signature carries. */
  chain: CertificateInfo[];
  /** Whether each certificate in the chain was signed by the next one. */
  chainLinked: boolean;
  /**
   * Whether the signer's certificate was valid at the signing time (the timestamp's time if it
   * has a valid one, otherwise the claimed time); null if there's no time.
   */
  validAtSigning: boolean | null;
  /** The signer's claimed signing time: /M, or the signingTime attribute. */
  signingTime?: number;
  /** Whether it carries a timestamp from a timestamp server. */
  timestamped: boolean;
  /** The timestamp, checked, if it has one. */
  timestamp?: TimestampCheck;
}

const OID = {
  signedData: "1.2.840.113549.1.7.2",
  signingTime: "1.2.840.113549.1.9.5",
} as const;

const NAME_PARTS: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.6": "C",
  "1.2.840.113549.1.9.1": "E",
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A name as "CN=…, OU=…, O=…": the common name first, then the rest from the most specific. */
function fullName(name: pkijs.RelativeDistinguishedNames): string {
  const parts = name.typesAndValues
    .map((t) => {
      const key = NAME_PARTS[t.type];
      const value = t.value.valueBlock.value;
      return key && typeof value === "string" ? `${key}=${value}` : null;
    })
    .filter((s): s is string => s !== null);
  // Certificates usually list C, O, …, CN; some the other way round.
  if (!parts[0]?.startsWith("CN=")) parts.reverse();
  return parts.join(", ");
}

export function describeCertificate(cert: pkijs.Certificate): CertificateInfo {
  return {
    name: displayName(cert.subject) || "Unknown signer",
    subject: fullName(cert.subject),
    issuerName: displayName(cert.issuer) || "Unknown issuer",
    issuer: fullName(cert.issuer),
    serial: hex(cert.serialNumber.valueBlock.valueHexView),
    notBefore: cert.notBefore.value.getTime(),
    notAfter: cert.notAfter.value.getTime(),
    selfSigned: cert.subject.isEqual(cert.issuer),
  };
}

/** The bytes a byte range covers, one stretch after the other. */
function coveredBytes(file: Uint8Array, range: readonly number[]): Uint8Array {
  const [a = 0, aLength = 0, b = 0, bLength = 0] = range;
  if (a !== 0 || b < aLength || b + bLength > file.length) {
    throw new Error("The byte range doesn't fit the file");
  }
  const out = new Uint8Array(aLength + bLength);
  out.set(file.subarray(0, aLength), 0);
  out.set(file.subarray(b, b + bLength), aLength);
  return out;
}

/** The signer's certificate and its issuers, as far as the signature carries them. */
async function buildChain(
  signer: pkijs.Certificate,
  all: pkijs.Certificate[],
): Promise<{ chain: pkijs.Certificate[]; linked: boolean }> {
  const chain = [signer];
  let linked = true;
  let current = signer;
  while (chain.length < 10 && !current.subject.isEqual(current.issuer)) {
    const issuer = all.find((c) => c.subject.isEqual(current.issuer) && !chain.includes(c));
    if (!issuer) break;
    try {
      if (!(await current.verify(issuer, engine()))) linked = false;
    } catch {
      linked = false;
    }
    chain.push(issuer);
    current = issuer;
  }
  return { chain, linked };
}

/** Check the timestamp token on a signer, if it has one. */
async function checkTimestamp(signerInfo: pkijs.SignerInfo): Promise<TimestampCheck | undefined> {
  const token = timestampTokenOf(signerInfo);
  if (!token) return undefined;
  const value = new Uint8Array(signerInfo.signature.valueBlock.valueHexView);
  const info = await verifyTimestampToken(token, value);
  let chain: CertificateInfo[] = [];
  const problems = [...info.problems];
  if (info.certificate) {
    const built = await buildChain(info.certificate, info.certificates);
    chain = built.chain.map(describeCertificate);
    if (!built.linked) {
      problems.push("A certificate in the timestamp server's chain doesn't match its issuer.");
    }
  }
  return {
    time: info.time,
    authority: info.authority,
    valid: problems.length === 0,
    problems,
    chain,
  };
}

/**
 * Check a PDF signature: `der` is the CMS from /Contents, `range` its byte range in `file`,
 * `subFilter` and `claimedTime` (ms) from its signature dictionary.
 */
export async function verifySignature(
  file: Uint8Array,
  range: readonly number[],
  der: Uint8Array,
  subFilter?: string,
  claimedTime?: number,
): Promise<CryptoCheck> {
  const result: CryptoCheck = {
    intact: null,
    problems: [],
    warnings: [],
    chain: [],
    chainLinked: false,
    validAtSigning: null,
    timestamped: false,
  };
  if (subFilter === "adbe.x509.rsa_sha1") {
    result.problems.push("This old kind of signature (adbe.x509.rsa_sha1) can't be checked yet.");
    return result;
  }
  let signedData: pkijs.SignedData;
  try {
    const asn1 = asn1js.fromBER(der);
    if (asn1.offset === -1) throw new Error("not BER");
    const info = new pkijs.ContentInfo({ schema: asn1.result });
    if (info.contentType !== OID.signedData) throw new Error("not SignedData");
    signedData = new pkijs.SignedData({ schema: info.content });
  } catch {
    result.intact = false;
    result.problems.push("The signature can't be read.");
    return result;
  }
  const signerInfo = signedData.signerInfos[0];
  if (!signerInfo) {
    result.intact = false;
    result.problems.push("The signature has no signer.");
    return result;
  }
  const cert = signerCertificate(signedData, signerInfo);
  if (cert) {
    const { chain, linked } = await buildChain(cert, certificatesOf(signedData));
    result.signer = describeCertificate(cert);
    result.chain = chain.map(describeCertificate);
    result.chainLinked = linked;
    if (!linked) {
      result.warnings.push(
        "A certificate in the chain doesn't match its issuer, so the chain can't be relied on.",
      );
    }
  }
  result.timestamp = await checkTimestamp(signerInfo);
  result.timestamped = !!result.timestamp;
  if (result.timestamp && !result.timestamp.valid) {
    result.warnings.push(
      `It has a timestamp, but it can't be relied on: ${result.timestamp.problems.join(" ")}`,
    );
  }

  // The signing time: /M, or the signingTime attribute. Both are the signer's claim; a valid
  // timestamp is used instead when there is one.
  let time = claimedTime;
  const st = attribute(signerInfo.signedAttrs, OID.signingTime)?.values[0];
  if (time === undefined && st instanceof asn1js.UTCTime) time = st.toDate().getTime();
  if (time === undefined && st instanceof asn1js.GeneralizedTime) time = st.toDate().getTime();
  result.signingTime = time;
  const checkedTime = result.timestamp?.valid ? result.timestamp.time : time;
  const signer = result.signer;
  if (signer && checkedTime !== undefined) {
    result.validAtSigning = checkedTime >= signer.notBefore && checkedTime <= signer.notAfter;
    if (!result.validAtSigning) {
      result.warnings.push(
        checkedTime > signer.notAfter
          ? "The signer's certificate had expired when it was signed."
          : "The signer's certificate wasn't valid yet when it was signed.",
      );
    }
  }

  const digestName = DIGESTS[signerInfo.digestAlgorithm.algorithmId];
  if (!digestName) {
    result.problems.push("It uses a hash that can't be checked.");
    return result;
  }
  result.digestAlgorithm = digestName;
  if (digestName === "SHA-1") {
    result.warnings.push("It uses SHA-1, an old hash that is no longer considered safe.");
  }
  if (!cert) {
    result.intact = false;
    result.problems.push("The signer's certificate isn't in the signature.");
    return result;
  }

  let content: Uint8Array;
  try {
    content = coveredBytes(file, range);
  } catch {
    result.intact = false;
    result.problems.push("Its byte range doesn't fit the file.");
    return result;
  }

  // adbe.pkcs7.sha1: the signed content is the SHA-1 hash of the bytes.
  const eContent = signedData.encapContentInfo.eContent;
  if (eContent) {
    const embedded = new Uint8Array(eContent.getValue());
    if (
      subFilter !== "adbe.pkcs7.sha1" ||
      !equalBytes(embedded, await digestOf("SHA-1", content))
    ) {
      result.intact = false;
      result.problems.push("The signed part of the file was altered after signing.");
      return result;
    }
    content = embedded;
    result.warnings.push("It uses SHA-1, an old hash that is no longer considered safe.");
  }

  const problem = await checkSigner(signerInfo, cert, content, digestName);
  switch (problem) {
    case null:
      result.intact = true;
      break;
    case "no-digest":
      result.intact = false;
      result.problems.push("The signature has no hash of the document.");
      break;
    case "altered":
      result.intact = false;
      result.problems.push("The signed part of the file was altered after signing.");
      break;
    case "mismatch":
      result.intact = false;
      result.problems.push("The signature doesn't match the signer's certificate.");
      break;
    case "algorithm":
      result.problems.push("It uses a signature algorithm that can't be checked.");
      break;
  }
  return result;
}
