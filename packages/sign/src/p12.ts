// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reading a digital ID from a .p12 / .pfx file (PKCS #12) with PKI.js and WebCrypto. The
// private key is imported into WebCrypto as non-extractable, for signing only, and our copy
// of the decrypted key bytes is wiped once imported (as far as JavaScript allows: PKI.js's own
// objects are left to the garbage collector). Nothing is stored or sent anywhere.

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

/** A certificate and its DER encoding, exactly as it was in the file. */
export interface LoadedCertificate {
  certificate: pkijs.Certificate;
  der: Uint8Array;
}

/** A digital ID ready to sign with. */
export interface SigningIdentity {
  /** Non-extractable, usable for signing only. */
  privateKey: CryptoKey;
  /** The signer's certificate. */
  signer: LoadedCertificate;
  /** The other certificates in the file (normally the issuing CAs), to embed for validators. */
  chain: LoadedCertificate[];
  /** The signer's name (common name, or organisation). */
  name: string;
  /** Who issued the certificate (common name, or organisation). */
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  /** Whether the certificate's key usage allows signing documents (true if it doesn't say). */
  canSign: boolean;
}

/** A problem with the file or password, with a message to show as it is. */
export class DigitalIdError extends Error {
  constructor(
    message: string,
    readonly reason: "not-p12" | "password" | "unsupported" | "no-key",
  ) {
    super(message);
    this.name = "DigitalIdError";
  }
}

const OID = {
  keyBag: "1.2.840.113549.1.12.10.1.1",
  shroudedKeyBag: "1.2.840.113549.1.12.10.1.2",
  certBag: "1.2.840.113549.1.12.10.1.3",
  x509Certificate: "1.2.840.113549.1.9.22.1",
  localKeyId: "1.2.840.113549.1.9.21",
  data: "1.2.840.113549.1.7.1",
  encryptedData: "1.2.840.113549.1.7.6",
  pbes2: "1.2.840.113549.1.5.13",
  rsa: "1.2.840.113549.1.1.1",
  ec: "1.2.840.10045.2.1",
  commonName: "2.5.4.3",
  organisation: "2.5.4.10",
  keyUsage: "2.5.29.15",
} as const;

const CURVES: Record<string, string> = {
  "1.2.840.10045.3.1.7": "P-256",
  "1.3.132.0.34": "P-384",
  "1.3.132.0.35": "P-521",
};

const OLD_ENCRYPTION =
  "This file uses old encryption (3DES or RC2) that browsers can't decrypt. Export it again " +
  "with AES-256 encryption (in Windows: tick “AES256-SHA256” when exporting; with OpenSSL 3, " +
  "the default), then try again.";

/** Make sure PKI.js uses this environment's WebCrypto (the browser's, or Node's in tests). */
function engine(): pkijs.ICryptoEngine {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new DigitalIdError("This browser can't sign: it has no WebCrypto.", "unsupported");
  }
  return new pkijs.CryptoEngine({ name: "webcrypto", crypto });
}

function view(buffer: ArrayBuffer | Uint8Array): Uint8Array {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A readable name from a distinguished name: its common name, or its organisation. */
export function displayName(name: pkijs.RelativeDistinguishedNames): string {
  const find = (oid: string) =>
    name.typesAndValues.find((t) => t.type === oid)?.value.valueBlock.value as string | undefined;
  return (find(OID.commonName) ?? find(OID.organisation) ?? "").trim();
}

/** Whether a certificate may sign documents: digitalSignature or nonRepudiation, if it says. */
function keyUsageAllowsSigning(cert: pkijs.Certificate): boolean {
  const ext = cert.extensions?.find((e) => e.extnID === OID.keyUsage);
  if (!ext) return true;
  const bits = asn1js.fromBER(ext.extnValue.valueBlock.valueHexView);
  if (bits.offset === -1 || !(bits.result instanceof asn1js.BitString)) return true;
  const first = bits.result.valueBlock.valueHexView[0] ?? 0;
  // Bit 0 (0x80) is digitalSignature, bit 1 (0x40) nonRepudiation.
  return (first & 0xc0) !== 0;
}

function encryptionOf(content: pkijs.ContentInfo): string | null {
  if (content.contentType !== OID.encryptedData) return null;
  // From a copy: PKI.js changes the schema objects it reads, so they can't be read twice.
  const copy = asn1js.fromBER((content.content as asn1js.BaseBlock).toBER(false)).result;
  const encrypted = new pkijs.EncryptedData({ schema: copy });
  return encrypted.encryptedContentInfo.contentEncryptionAlgorithm.algorithmId;
}

/** Turn PKI.js's errors into ones a person can act on. */
function explain(err: unknown, algorithm: string | null): DigitalIdError {
  if (err instanceof DigitalIdError) return err;
  if (algorithm && algorithm !== OID.pbes2)
    return new DigitalIdError(OLD_ENCRYPTION, "unsupported");
  const message = err instanceof Error ? err.message : String(err);
  if (/Unknown "contentEncryptionAlgorithm"|Unsupported|not supported/i.test(message)) {
    return new DigitalIdError(OLD_ENCRYPTION, "unsupported");
  }
  // A wrong password fails the integrity check, or (without one) the decryption.
  return new DigitalIdError("The password is wrong.", "password");
}

/**
 * Read a .p12 / .pfx file and import its private key for signing. Throws DigitalIdError with
 * a message to show if the file can't be read, the password is wrong, or it has no key.
 */
export async function loadDigitalId(file: Uint8Array, password: string): Promise<SigningIdentity> {
  const crypto = engine();
  const asn = asn1js.fromBER(file);
  let pfx: pkijs.PFX;
  try {
    if (asn.offset === -1) throw new Error("not DER");
    pfx = new pkijs.PFX({ schema: asn.result });
  } catch {
    throw new DigitalIdError("This isn't a .p12 or .pfx file.", "not-p12");
  }
  // PKCS #12 passwords are text; PKI.js turns them into what each algorithm needs.
  const secret = new TextEncoder().encode(password).buffer as ArrayBuffer;

  let authenticated: pkijs.AuthenticatedSafe;
  try {
    await pfx.parseInternalValues({ password: secret, checkIntegrity: !!pfx.macData }, crypto);
    const parsed = pfx.parsedValue?.authenticatedSafe;
    if (!parsed) throw new Error("No contents");
    authenticated = parsed;
  } catch (err) {
    throw explain(err, null);
  }

  const contents = authenticated.safeContents;
  for (const c of contents) {
    if (c.contentType !== OID.data && c.contentType !== OID.encryptedData) {
      throw new DigitalIdError(
        "This file is protected with a certificate instead of a password, which isn't supported.",
        "unsupported",
      );
    }
  }
  let algorithm: string | null = null;
  try {
    for (const c of contents) algorithm = encryptionOf(c) ?? algorithm;
    await authenticated.parseInternalValues(
      { safeContents: contents.map(() => ({ password: secret })) },
      crypto,
    );
  } catch (err) {
    throw explain(err, algorithm);
  }

  const certificates: (LoadedCertificate & { keyId: Uint8Array | null })[] = [];
  const keys: { info: pkijs.PrivateKeyInfo; der: Uint8Array; keyId: Uint8Array | null }[] = [];
  const keyIdOf = (bag: pkijs.SafeBag) => {
    const attribute = bag.bagAttributes?.find((a) => a.type === OID.localKeyId);
    const value = attribute?.values[0];
    return value instanceof asn1js.OctetString ? view(value.valueBlock.valueHexView).slice() : null;
  };
  for (const safe of authenticated.parsedValue?.safeContents ?? []) {
    for (const bag of safe.value.safeBags) {
      if (bag.bagId === OID.certBag) {
        const certBag = bag.bagValue as pkijs.CertBag;
        if (certBag.certId !== OID.x509Certificate) continue;
        const value = certBag.certValue;
        if (!(value instanceof asn1js.OctetString)) continue;
        const der = view(value.valueBlock.valueHexView).slice();
        certificates.push({
          certificate: pkijs.Certificate.fromBER(der),
          der,
          keyId: keyIdOf(bag),
        });
      } else if (bag.bagId === OID.shroudedKeyBag || bag.bagId === OID.keyBag) {
        let info: pkijs.PrivateKeyInfo;
        try {
          if (bag.bagId === OID.shroudedKeyBag) {
            const shrouded = bag.bagValue as pkijs.PKCS8ShroudedKeyBag;
            const keyAlgorithm = shrouded.encryptionAlgorithm.algorithmId;
            if (keyAlgorithm !== OID.pbes2) throw new DigitalIdError(OLD_ENCRYPTION, "unsupported");
            // Public in PKI.js's code, but typed as protected.
            const decrypt = shrouded as unknown as {
              parseInternalValues(
                p: { password: ArrayBuffer },
                c: pkijs.ICryptoEngine,
              ): Promise<void>;
            };
            await decrypt.parseInternalValues({ password: secret }, crypto);
            if (!shrouded.parsedValue) throw new Error("No key");
            info = shrouded.parsedValue;
          } else {
            info = bag.bagValue as pkijs.PrivateKeyInfo;
          }
        } catch (err) {
          throw explain(err, null);
        }
        keys.push({ info, der: view(info.toSchema().toBER(false)), keyId: keyIdOf(bag) });
      }
    }
  }

  const key = keys[0];
  if (!key) {
    throw new DigitalIdError(
      "This file has no private key, so it can't be used to sign. Export your digital ID with its private key.",
      "no-key",
    );
  }
  if (keys.length > 1) {
    for (const k of keys.slice(1)) k.der.fill(0);
  }

  // The signer's certificate: the one marked as the key's, or the one whose public key is
  // the key's (RSA), or the only one that isn't a CA.
  const isCa = (c: pkijs.Certificate) =>
    c.extensions?.some(
      (e) => e.extnID === "2.5.29.19" && (e.parsedValue as pkijs.BasicConstraints)?.cA,
    ) ?? false;
  let signer =
    (key.keyId &&
      certificates.find((c) => c.keyId && sameBytes(c.keyId, key.keyId as Uint8Array))) ||
    undefined;
  const rsa = key.info.parsedKey instanceof pkijs.RSAPrivateKey ? key.info.parsedKey : null;
  if (!signer && rsa) {
    signer = certificates.find((c) => {
      const pub = c.certificate.subjectPublicKeyInfo.parsedKey;
      return (
        pub instanceof pkijs.RSAPublicKey &&
        sameBytes(
          view(pub.modulus.valueBlock.valueHexView),
          view(rsa.modulus.valueBlock.valueHexView),
        )
      );
    });
  }
  signer ??= certificates.find((c) => !isCa(c.certificate));
  if (!signer) {
    key.der.fill(0);
    throw new DigitalIdError("This file has no certificate for its private key.", "no-key");
  }

  let privateKey: CryptoKey;
  try {
    privateKey = await importSigningKey(key.info, key.der);
  } finally {
    key.der.fill(0);
  }

  const cert = signer.certificate;
  return {
    privateKey,
    signer: { certificate: cert, der: signer.der },
    chain: certificates
      .filter((c) => c !== signer)
      .map(({ certificate, der }) => ({ certificate, der })),
    name: displayName(cert.subject) || "Unknown signer",
    issuer: displayName(cert.issuer) || "Unknown issuer",
    notBefore: cert.notBefore.value,
    notAfter: cert.notAfter.value,
    canSign: keyUsageAllowsSigning(cert),
  };
}

/** The WebCrypto algorithm a key signs with: RSA PKCS #1 v1.5 or ECDSA, with SHA-256. */
async function importSigningKey(info: pkijs.PrivateKeyInfo, der: Uint8Array): Promise<CryptoKey> {
  const algorithm = info.privateKeyAlgorithm;
  let params: RsaHashedImportParams | EcKeyImportParams;
  if (algorithm.algorithmId === OID.rsa) {
    params = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  } else if (algorithm.algorithmId === OID.ec) {
    const curveOid =
      algorithm.algorithmParams instanceof asn1js.ObjectIdentifier
        ? algorithm.algorithmParams.valueBlock.toString()
        : "";
    const namedCurve = CURVES[curveOid];
    if (!namedCurve) {
      throw new DigitalIdError(
        "This digital ID uses an elliptic curve that isn't supported.",
        "unsupported",
      );
    }
    params = { name: "ECDSA", namedCurve };
  } else {
    throw new DigitalIdError(
      "This digital ID's key type isn't supported (only RSA and elliptic-curve keys are).",
      "unsupported",
    );
  }
  try {
    return await globalThis.crypto.subtle.importKey("pkcs8", der as BufferSource, params, false, [
      "sign",
    ]);
  } catch {
    throw new DigitalIdError("The private key in this file couldn't be read.", "unsupported");
  }
}

/**
 * What stops an identity signing now, as a message to show, or null if nothing does: an
 * expired or not-yet-valid certificate, or one not meant for signing documents.
 */
export function identityProblem(identity: SigningIdentity, now = new Date()): string | null {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  if (now > identity.notAfter) {
    return `This certificate expired on ${day(identity.notAfter)}, so signatures made with it wouldn't be valid.`;
  }
  if (now < identity.notBefore) {
    return `This certificate isn't valid until ${day(identity.notBefore)}.`;
  }
  if (!identity.canSign) return "This certificate isn't meant for signing documents.";
  return null;
}
