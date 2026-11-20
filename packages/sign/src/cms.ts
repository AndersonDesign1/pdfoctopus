// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The signature itself: a detached CMS SignedData (RFC 5652) following the PAdES baseline
// B-B profile (ETSI EN 319 142-1). The signed attributes are contentType, messageDigest
// (SHA-256 of the PDF's byte range) and signingCertificateV2 (RFC 5035), which ties the
// signature to the signer's certificate. There's no signingTime attribute: PAdES puts the
// time in the signature dictionary's /M instead. The signer's certificate and the others
// from the .p12 file (its chain) are included, so validators can build the chain.
//
// With a timestamp (PAdES B-T), the signature value's hash is sent to a timestamp server
// once the signature is made, and the token it sends back is added as an unsigned attribute.

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import type { SigningIdentity } from "./p12";
import { addTimestampToken, requestTimestamp, type TimestampTransport } from "./timestamp";

/** How to get a timestamp for a signature (PAdES B-T), if one is wanted. */
export interface TimestampOptions {
  send: TimestampTransport;
  /** The server's name, for messages, e.g. "DigiCert's timestamp server". */
  serverName?: string;
}

const OID = {
  data: "1.2.840.113549.1.7.1",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
} as const;

function engine(): pkijs.ICryptoEngine {
  return new pkijs.CryptoEngine({ name: "webcrypto", crypto: globalThis.crypto });
}

/** SHA-256 of some bytes. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource));
}

/** Compare two DER encodings, as DER sorts the members of a SET OF. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return a.length - b.length;
}

/**
 * signingCertificateV2: the SHA-256 hash of the signer's certificate, with its issuer and
 * serial number. The hash algorithm is left out, as SHA-256 is the default.
 */
export async function signingCertificateV2(identity: SigningIdentity): Promise<asn1js.Sequence> {
  const cert = identity.signer.certificate;
  const hash = await sha256(identity.signer.der);
  const issuerSerial = new asn1js.Sequence({
    value: [
      // GeneralNames with one directoryName ([4], explicit, as Name is a CHOICE).
      new asn1js.Sequence({
        value: [
          new asn1js.Constructed({
            idBlock: { tagClass: 3, tagNumber: 4 },
            value: [cert.issuer.toSchema()],
          }),
        ],
      }),
      new asn1js.Integer({ valueHex: cert.serialNumber.valueBlock.valueHexView.slice() }),
    ],
  });
  const essCertIdV2 = new asn1js.Sequence({
    value: [new asn1js.OctetString({ valueHex: hash }), issuerSerial],
  });
  return new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIdV2] })] });
}

/**
 * Make a PAdES B-B signature for a PDF: a DER-encoded CMS SignedData over `digest`, the
 * SHA-256 hash of the bytes in the signature's byte range. With `timestamp`, B-T: a trusted
 * timestamp is added (throws TimestampError if it can't be).
 */
export async function padesSignature(
  identity: SigningIdentity,
  digest: Uint8Array,
  timestamp?: TimestampOptions,
): Promise<Uint8Array> {
  if (digest.length !== 32) throw new Error("The digest must be a SHA-256 hash");
  const cert = identity.signer.certificate;
  const attributes = [
    new pkijs.Attribute({
      type: OID.contentType,
      values: [new asn1js.ObjectIdentifier({ value: OID.data })],
    }),
    new pkijs.Attribute({
      type: OID.messageDigest,
      values: [new asn1js.OctetString({ valueHex: digest.slice() })],
    }),
    new pkijs.Attribute({
      type: OID.signingCertificateV2,
      values: [await signingCertificateV2(identity)],
    }),
  ];
  // DER: a SET OF is sorted by its members' encodings. The signature is over this encoding,
  // and validators that re-encode the attributes would otherwise get different bytes.
  const encoded = (a: pkijs.Attribute) => new Uint8Array(a.toSchema().toBER(false));
  attributes.sort((a, b) => compareBytes(encoded(a), encoded(b)));

  const signedData = new pkijs.SignedData({
    version: 1,
    // Detached: the content (the PDF's bytes) isn't included.
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: cert.issuer,
          serialNumber: cert.serialNumber,
        }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes }),
      }),
    ],
    certificates: [cert, ...identity.chain.map((c) => c.certificate)],
  });
  await signedData.sign(identity.privateKey, 0, "SHA-256", undefined, engine());

  if (timestamp) {
    const signerInfo = signedData.signerInfos[0] as pkijs.SignerInfo;
    const value = new Uint8Array(signerInfo.signature.valueBlock.valueHexView);
    const token = await requestTimestamp(value, timestamp.send, timestamp.serverName);
    addTimestampToken(signerInfo, token);
  }

  const contentInfo = new pkijs.ContentInfo({
    contentType: pkijs.ContentInfo.SIGNED_DATA,
    content: signedData.toSchema(true),
  });
  return new Uint8Array(contentInfo.toSchema().toBER(false));
}
