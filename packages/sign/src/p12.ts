// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reading a digital ID from a .p12 / .pfx file (PKCS #12) with PKI.js and WebCrypto. Files
// encrypted with AES (PBES2) are decrypted by PKI.js; older ones with 3DES or RC2, which
// WebCrypto can't do, by our own code (pkcs12Pbe.ts). The file's integrity check is ours too.
// The private key is imported into WebCrypto as non-extractable, for signing only, and our
// copies of the decrypted key bytes and of the password are wiped once used (as far as
// JavaScript allows: PKI.js's own objects are left to the garbage collector). Nothing is
// stored or sent anywhere.

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { BadPaddingError } from "./legacyCiphers";
import {
  bmpPassword,
  checkPkcs12Mac,
  LEGACY_PBE,
  legacyPbeDecrypt,
  MAX_ITERATIONS,
  macHashName,
  type PbeParams,
  UnsupportedPbeError,
} from "./pkcs12Pbe";

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

const UNSUPPORTED_ENCRYPTION =
  "This file uses an encryption method that isn't supported. Export it again with AES-256 " +
  "encryption (in Windows: tick “AES256-SHA256” when exporting; with OpenSSL 3, the default), " +
  "then try again.";

const WRONG_PASSWORD = "The password is wrong.";

const NOT_P12 = "This isn't a .p12 or .pfx file.";

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

/** The bytes of an OCTET STRING, joined up if it's in pieces (BER). */
function octets(value: unknown): Uint8Array {
  if (!(value instanceof asn1js.OctetString)) throw new Error("Not an OCTET STRING");
  return new Uint8Array(value.getValue());
}

/** The salt and rounds of an old PKCS #12 PBE scheme: SEQUENCE { OCTET STRING, INTEGER }. */
function pbeParams(algorithm: pkijs.AlgorithmIdentifier): PbeParams {
  const params = algorithm.algorithmParams;
  const [salt, rounds] = params instanceof asn1js.Sequence ? params.valueBlock.value : [];
  if (!(salt instanceof asn1js.OctetString) || !(rounds instanceof asn1js.Integer)) {
    throw new DigitalIdError("This file's encryption settings can't be read.", "unsupported");
  }
  const iterations = rounds.valueBlock.valueDec;
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    throw new DigitalIdError(UNSUPPORTED_ENCRYPTION, "unsupported");
  }
  return { salt: new Uint8Array(salt.valueBlock.valueHexView), iterations };
}

/** The password as each kind of encryption wants it. */
interface Passwords {
  /** UTF-8, for AES (PBES2), as OpenSSL and Windows use. */
  utf8: ArrayBuffer;
  /** UTF-16 with two zero bytes at the end, for the old schemes and the integrity check. */
  bmp: Uint8Array;
}

/**
 * Decrypt something encrypted with the password: with PKI.js for AES (PBES2), with our own
 * code for the old 3DES and RC2 schemes. Throws DigitalIdError with a message to show.
 */
async function decryptWithPassword(
  algorithm: pkijs.AlgorithmIdentifier,
  data: Uint8Array,
  passwords: Passwords,
  pbes2: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const oid = algorithm.algorithmId;
  try {
    if (oid === OID.pbes2) return await pbes2();
    if (LEGACY_PBE[oid]) {
      return await legacyPbeDecrypt(oid, pbeParams(algorithm), passwords.bmp, data);
    }
  } catch (err) {
    if (err instanceof DigitalIdError) throw err;
    if (err instanceof UnsupportedPbeError) {
      throw new DigitalIdError(UNSUPPORTED_ENCRYPTION, "unsupported");
    }
    if (err instanceof BadPaddingError) throw new DigitalIdError(WRONG_PASSWORD, "password");
    const message = err instanceof Error ? err.message : String(err);
    if (/Unknown|Unsupported|not supported/i.test(message)) {
      throw new DigitalIdError(UNSUPPORTED_ENCRYPTION, "unsupported");
    }
    // A wrong password makes AES decryption fail (when no integrity check said so first).
    throw new DigitalIdError(WRONG_PASSWORD, "password");
  }
  // RC4, or something newer or stranger.
  throw new DigitalIdError(UNSUPPORTED_ENCRYPTION, "unsupported");
}

/**
 * Check the file's integrity (MacData): an HMAC keyed from the password with the PKCS #12
 * derivation. A wrong password fails here. Returns false if it doesn't match.
 */
async function checkIntegrity(
  pfx: pkijs.PFX,
  content: Uint8Array,
  passwords: Passwords,
): Promise<boolean> {
  const mac = pfx.macData;
  if (!mac) return true;
  const hashOid = mac.mac.digestAlgorithm.algorithmId;
  if (!macHashName(hashOid)) throw new DigitalIdError(UNSUPPORTED_ENCRYPTION, "unsupported");
  const iterations = mac.iterations ?? 1;
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    throw new DigitalIdError(UNSUPPORTED_ENCRYPTION, "unsupported");
  }
  const salt = new Uint8Array(mac.macSalt.valueBlock.valueHexView);
  const expected = new Uint8Array(mac.mac.digest.valueBlock.valueHexView);
  const check = (password: Uint8Array) =>
    checkPkcs12Mac(hashOid, password, salt, iterations, content, expected);
  if (await check(passwords.bmp)) return true;
  // With no password, some programs use nothing at all rather than two zero bytes.
  return passwords.bmp.length === 2 && check(new Uint8Array(0));
}

/**
 * Read a .p12 / .pfx file and import its private key for signing. Throws DigitalIdError with
 * a message to show if the file can't be read, the password is wrong, or it has no key.
 */
export async function loadDigitalId(file: Uint8Array, password: string): Promise<SigningIdentity> {
  const crypto = engine();
  const asn = asn1js.fromBER(file);
  let pfx: pkijs.PFX;
  let content: Uint8Array;
  try {
    if (asn.offset === -1) throw new Error("not DER");
    pfx = new pkijs.PFX({ schema: asn.result });
    if (pfx.authSafe.contentType !== OID.data) {
      throw new DigitalIdError(
        "This file is protected with a certificate instead of a password, which isn't supported.",
        "unsupported",
      );
    }
    content = octets(pfx.authSafe.content);
  } catch (err) {
    if (err instanceof DigitalIdError) throw err;
    throw new DigitalIdError(NOT_P12, "not-p12");
  }
  const passwords: Passwords = {
    utf8: new TextEncoder().encode(password).buffer as ArrayBuffer,
    bmp: bmpPassword(password),
  };
  try {
    return await readDigitalId(crypto, pfx, content, passwords);
  } finally {
    new Uint8Array(passwords.utf8).fill(0);
    passwords.bmp.fill(0);
  }
}

async function readDigitalId(
  crypto: pkijs.ICryptoEngine,
  pfx: pkijs.PFX,
  content: Uint8Array,
  passwords: Passwords,
): Promise<SigningIdentity> {
  let intact: boolean;
  try {
    intact = await checkIntegrity(pfx, content, passwords);
  } catch (err) {
    if (err instanceof DigitalIdError) throw err;
    throw new DigitalIdError(UNSUPPORTED_ENCRYPTION, "unsupported");
  }
  if (!intact) throw new DigitalIdError(WRONG_PASSWORD, "password");

  let authenticated: pkijs.AuthenticatedSafe;
  try {
    authenticated = pkijs.AuthenticatedSafe.fromBER(content as Uint8Array<ArrayBuffer>);
  } catch {
    throw new DigitalIdError(NOT_P12, "not-p12");
  }

  const safes: pkijs.SafeContents[] = [];
  for (const c of authenticated.safeContents) {
    if (c.contentType === OID.data) {
      try {
        safes.push(pkijs.SafeContents.fromBER(octets(c.content) as Uint8Array<ArrayBuffer>));
      } catch {
        throw new DigitalIdError(NOT_P12, "not-p12");
      }
    } else if (c.contentType === OID.encryptedData) {
      let encrypted: pkijs.EncryptedData;
      let data: Uint8Array;
      try {
        encrypted = new pkijs.EncryptedData({ schema: c.content });
        data = new Uint8Array(encrypted.encryptedContentInfo.getEncryptedContent());
      } catch {
        throw new DigitalIdError(NOT_P12, "not-p12");
      }
      const decrypted = await decryptWithPassword(
        encrypted.encryptedContentInfo.contentEncryptionAlgorithm,
        data,
        passwords,
        async () => new Uint8Array(await encrypted.decrypt({ password: passwords.utf8 }, crypto)),
      );
      try {
        safes.push(pkijs.SafeContents.fromBER(decrypted as Uint8Array<ArrayBuffer>));
      } catch {
        // Decrypted into nonsense: a wrong password, in a file with no integrity check.
        throw new DigitalIdError(WRONG_PASSWORD, "password");
      }
    } else {
      throw new DigitalIdError(
        "This file is protected with a certificate instead of a password, which isn't supported.",
        "unsupported",
      );
    }
  }

  const certificates: (LoadedCertificate & { keyId: Uint8Array | null })[] = [];
  const keys: { info: pkijs.PrivateKeyInfo; der: Uint8Array; keyId: Uint8Array | null }[] = [];
  const keyIdOf = (bag: pkijs.SafeBag) => {
    const attribute = bag.bagAttributes?.find((a) => a.type === OID.localKeyId);
    const value = attribute?.values[0];
    return value instanceof asn1js.OctetString ? view(value.valueBlock.valueHexView).slice() : null;
  };
  for (const safe of safes) {
    for (const bag of safe.safeBags) {
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
        if (bag.bagId === OID.shroudedKeyBag) {
          info = await decryptKeyBag(crypto, bag.bagValue as pkijs.PKCS8ShroudedKeyBag, passwords);
        } else {
          info = bag.bagValue as pkijs.PrivateKeyInfo;
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

  let imported: { key: CryptoKey; params: RsaHashedImportParams | EcKeyImportParams };
  try {
    imported = await importSigningKey(key.info, key.der);
  } finally {
    key.der.fill(0);
  }
  const privateKey = imported.key;

  // The signer's certificate is the one whose public key belongs to the private key. The
  // key's localKeyId and "not a CA" only decide which certificates are tried first: a file
  // can hold other people's certificates too, and signing with the wrong one would make a
  // signature that never validates.
  const isCa = (c: pkijs.Certificate) =>
    c.extensions?.some(
      (e) => e.extnID === "2.5.29.19" && (e.parsedValue as pkijs.BasicConstraints)?.cA,
    ) ?? false;
  const rank = (c: (typeof certificates)[number]) =>
    (key.keyId && c.keyId && sameBytes(c.keyId, key.keyId) ? 0 : 2) + (isCa(c.certificate) ? 1 : 0);
  const candidates = [...certificates].sort((a, b) => rank(a) - rank(b));
  let signer: (typeof certificates)[number] | undefined;
  for (const c of candidates) {
    if (await keyMatches(privateKey, imported.params, c.certificate)) {
      signer = c;
      break;
    }
  }
  if (!signer) {
    throw new DigitalIdError(
      "This file has no certificate for its private key, so it can't be used to sign.",
      "no-key",
    );
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

/** Decrypt a private key (PKCS #8, encrypted with the password). */
async function decryptKeyBag(
  crypto: pkijs.ICryptoEngine,
  shrouded: pkijs.PKCS8ShroudedKeyBag,
  passwords: Passwords,
): Promise<pkijs.PrivateKeyInfo> {
  // Public in PKI.js's code, but typed as protected.
  const pki = shrouded as unknown as {
    parseInternalValues(p: { password: ArrayBuffer }, c: pkijs.ICryptoEngine): Promise<void>;
  };
  let data: Uint8Array;
  try {
    data = octets(shrouded.encryptedData);
  } catch {
    throw new DigitalIdError(NOT_P12, "not-p12");
  }
  let parsed: pkijs.PrivateKeyInfo | undefined;
  const decrypted = await decryptWithPassword(
    shrouded.encryptionAlgorithm,
    data,
    passwords,
    async () => {
      await pki.parseInternalValues({ password: passwords.utf8 }, crypto);
      if (!shrouded.parsedValue) throw new Error("No key");
      parsed = shrouded.parsedValue;
      return new Uint8Array(0);
    },
  );
  try {
    return parsed ?? pkijs.PrivateKeyInfo.fromBER(decrypted as Uint8Array<ArrayBuffer>);
  } catch {
    throw new DigitalIdError(WRONG_PASSWORD, "password");
  } finally {
    decrypted.fill(0);
  }
}

/**
 * Whether a certificate's public key belongs to the private key: a test value signed with
 * the private key verifies with the certificate's key.
 */
async function keyMatches(
  privateKey: CryptoKey,
  params: RsaHashedImportParams | EcKeyImportParams,
  cert: pkijs.Certificate,
): Promise<boolean> {
  const subtle = globalThis.crypto.subtle;
  const sign = params.name === "ECDSA" ? { name: "ECDSA", hash: "SHA-256" } : params;
  try {
    const spki = new Uint8Array(cert.subjectPublicKeyInfo.toSchema().toBER(false));
    const publicKey = await subtle.importKey("spki", spki, params, false, ["verify"]);
    const test = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const signature = await subtle.sign(sign, privateKey, test);
    return await subtle.verify(sign, publicKey, signature, test);
  } catch {
    // Another kind of key (RSA against EC, another curve): not this one.
    return false;
  }
}

/** The WebCrypto algorithm a key signs with: RSA PKCS #1 v1.5 or ECDSA, with SHA-256. */
async function importSigningKey(
  info: pkijs.PrivateKeyInfo,
  der: Uint8Array,
): Promise<{ key: CryptoKey; params: RsaHashedImportParams | EcKeyImportParams }> {
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
    const key = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      der as BufferSource,
      params,
      false,
      ["sign"],
    );
    return { key, params };
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
