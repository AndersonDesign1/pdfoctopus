# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Creates throwaway digital IDs (.p12 files) for testing PDFoctopus's own signing code, issued
# by a throwaway root CA whose private key is never saved. TEST KEYS ONLY: the private keys
# are in the committed files with a published password, so they prove nothing about anyone.
#
#   pip install -r fixtures/scripts/requirements.txt
#   python3 fixtures/scripts/make-test-ids.py
#
# Output (password for every file: "test-only"):
#   ../test-ids/test-signer-rsa.p12     RSA 2048 signer, AES-256 encryption (OpenSSL 3 default)
#   ../test-ids/test-signer-ec.p12      ECDSA P-256 signer, AES-256 encryption
#   ../test-ids/test-signer-3des.p12    the RSA signer again, with old 3DES/RC2-style encryption
#   ../trust/pdfoctopus-test-signing-ca.pem  the root CA that issued them
#
# After running it, run `bun fixtures/scripts/sign-with-pdfoctopus.ts` to re-sign the PDFs that
# check-signatures.py validates.

import datetime
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

FIXTURES = Path(__file__).resolve().parent.parent
PASSWORD = b"test-only"
NOT_BEFORE = datetime.datetime(2026, 11, 1, tzinfo=datetime.timezone.utc)
NOT_AFTER = NOT_BEFORE + datetime.timedelta(days=365 * 30)


def name(common_name: str) -> x509.Name:
    return x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "PDFoctopus test IDs (NOT TRUSTED)"),
        ]
    )


def key_usage(signer: bool) -> x509.KeyUsage:
    return x509.KeyUsage(
        digital_signature=signer,
        content_commitment=signer,
        key_encipherment=False,
        data_encipherment=False,
        key_agreement=False,
        key_cert_sign=not signer,
        crl_sign=not signer,
        encipher_only=False,
        decipher_only=False,
    )


def make_ca():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = name("PDFoctopus Test Signing CA")
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(NOT_BEFORE)
        .not_valid_after(NOT_AFTER)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(key_usage(False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    return key, cert


def make_signer(common_name: str, key, ca):
    ca_key, ca_cert = ca
    cert = (
        x509.CertificateBuilder()
        .subject_name(name(common_name))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(NOT_BEFORE)
        .not_valid_after(NOT_AFTER)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(key_usage(True), critical=True)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False
        )
        .sign(ca_key, hashes.SHA256())
    )
    return cert


def write(path: Path, data: bytes) -> None:
    path.write_bytes(data)
    print(f"  {path.relative_to(FIXTURES)}")


def main() -> None:
    out = FIXTURES / "test-ids"
    out.mkdir(exist_ok=True)
    ca = make_ca()
    write(
        FIXTURES / "trust" / "pdfoctopus-test-signing-ca.pem",
        ca[1].public_bytes(serialization.Encoding.PEM),
    )

    rsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    rsa_cert = make_signer("Test Signer RSA", rsa_key, ca)
    ec_key = ec.generate_private_key(ec.SECP256R1())
    ec_cert = make_signer("Test Signer EC", ec_key, ca)

    aes = serialization.BestAvailableEncryption(PASSWORD)
    write(
        out / "test-signer-rsa.p12",
        pkcs12.serialize_key_and_certificates(b"Test Signer RSA", rsa_key, rsa_cert, [ca[1]], aes),
    )
    write(
        out / "test-signer-ec.p12",
        pkcs12.serialize_key_and_certificates(b"Test Signer EC", ec_key, ec_cert, [ca[1]], aes),
    )
    legacy = (
        serialization.PrivateFormat.PKCS12.encryption_builder()
        .kdf_rounds(2048)
        .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
        .hmac_hash(hashes.SHA1())
        .build(PASSWORD)
    )
    write(
        out / "test-signer-3des.p12",
        pkcs12.serialize_key_and_certificates(b"Test Signer RSA", rsa_key, rsa_cert, [ca[1]], legacy),
    )


if __name__ == "__main__":
    main()
