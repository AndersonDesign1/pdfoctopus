// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Checking one signer of a CMS SignedData: finding its certificate, comparing the
// messageDigest attribute with the content's hash, and checking the signature over the
// signed attributes with WebCrypto. Used for PDF signatures (verify.ts) and for the
// timestamp tokens inside them (timestamp.ts).

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

const OID = {
  messageDigest: "1.2.840.113549.1.9.4",
  rsaEncryption: "1.2.840.113549.1.1.1",
  subjectKeyIdentifier: "2.5.29.14",
} as const;

export const DIGESTS: Record<string, string> = {
  "1.3.14.3.2.26": "SHA-1",
  "2.16.840.1.101.3.4.2.1": "SHA-256",
  "2.16.840.1.101.3.4.2.2": "SHA-384",
  "2.16.840.1.101.3.4.2.3": "SHA-512",
};

export function engine(): pkijs.CryptoEngine {
  return new pkijs.CryptoEngine({ name: "webcrypto", crypto: globalThis.crypto });
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function digestOf(name: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest(name, data as BufferSource));
}

export function attribute(attrs: pkijs.SignedAndUnsignedAttributes | undefined, oid: string) {
  return attrs?.attributes.find((a) => a.type === oid);
}

/** The certificates a SignedData carries. */
export function certificatesOf(signedData: pkijs.SignedData): pkijs.Certificate[] {
  return (signedData.certificates ?? []).filter(
    (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
  );
}

/** The signer's certificate, by issuer and serial number or subject key identifier. */
export function signerCertificate(
  signedData: pkijs.SignedData,
  signerInfo: pkijs.SignerInfo,
): pkijs.Certificate | null {
  const certs = certificatesOf(signedData);
  const sid = signerInfo.sid;
  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    return (
      certs.find((c) => c.issuer.isEqual(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber)) ??
      null
    );
  }
  // A subject key identifier ([0] OCTET STRING).
  const id = (sid as asn1js.Primitive | undefined)?.valueBlock?.valueHexView;
  if (!id) return null;
  return (
    certs.find((c) => {
      const ext = c.extensions?.find((e) => e.extnID === OID.subjectKeyIdentifier);
      const parsed = ext ? asn1js.fromBER(ext.extnValue.valueBlock.valueHexView) : null;
      const value =
        parsed && parsed.offset !== -1 && parsed.result instanceof asn1js.OctetString
          ? parsed.result.valueBlock.valueHexView
          : null;
      return !!value && equalBytes(new Uint8Array(value), new Uint8Array(id));
    }) ?? null
  );
}

/**
 * Check a signer over some content: the messageDigest attribute (if there are signed
 * attributes) against the content's hash, then the signature. Returns null if it checks out,
 * or a problem: "altered" (the hash doesn't match), "no-digest", "mismatch" (the signature
 * doesn't match the certificate) or "algorithm" (one that can't be checked).
 */
export async function checkSigner(
  signerInfo: pkijs.SignerInfo,
  cert: pkijs.Certificate,
  content: Uint8Array,
  digestName: string,
): Promise<null | "altered" | "no-digest" | "mismatch" | "algorithm"> {
  let data: ArrayBuffer | Uint8Array = content;
  if (signerInfo.signedAttrs) {
    const md = attribute(signerInfo.signedAttrs, OID.messageDigest)?.values[0];
    if (!(md instanceof asn1js.OctetString)) return "no-digest";
    const expected = new Uint8Array(md.valueBlock.valueHexView);
    if (!equalBytes(expected, await digestOf(digestName, content))) return "altered";
    data = signerInfo.signedAttrs.encodedValue;
  }
  try {
    const crypto = engine();
    const ok =
      signerInfo.signatureAlgorithm.algorithmId === OID.rsaEncryption
        ? await crypto.verifyWithPublicKey(
            data as ArrayBuffer,
            signerInfo.signature,
            cert.subjectPublicKeyInfo,
            signerInfo.signatureAlgorithm,
            digestName,
          )
        : await crypto.verifyWithPublicKey(
            data as ArrayBuffer,
            signerInfo.signature,
            cert.subjectPublicKeyInfo,
            signerInfo.signatureAlgorithm,
          );
    return ok ? null : "mismatch";
  } catch {
    return "algorithm";
  }
}
