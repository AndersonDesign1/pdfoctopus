# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Creates digitally signed test fixtures with a throwaway, self-signed certificate.
# Called by generate.mjs:  python3 sign.py <fixtures/generated>
#
# Output:
#   signed.pdf        invoice.pdf with one signature
#   signed-twice.pdf  signed.pdf with a second signature added incrementally (both valid)
#   signed-tampered.pdf  signed.pdf with one byte changed inside the signed range
#   ../trust/pdfoctopus-test-root-ca.pem  the test root CA that issued both signers

import datetime
import io
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import fields, signers
from pyhanko_certvalidator.registry import SimpleCertificateStore
from asn1crypto import keys as asn1_keys, x509 as asn1_x509


def _name(common_name: str) -> x509.Name:
    return x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "PDFoctopus test fixtures (NOT TRUSTED)"),
        ]
    )


NOT_BEFORE = datetime.datetime(2026, 11, 1, tzinfo=datetime.timezone.utc)
NOT_AFTER = NOT_BEFORE + datetime.timedelta(days=365 * 30)


def make_root_ca():
    """A throwaway root CA. Tests treat it as trusted, like a real CA in Adobe's trust list."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = _name("PDFoctopus Test Root CA")
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(NOT_BEFORE)
        .not_valid_after(NOT_AFTER)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    return key, cert


def _asn1_cert(cert: x509.Certificate) -> asn1_x509.Certificate:
    return asn1_x509.Certificate.load(cert.public_bytes(serialization.Encoding.DER))


def make_signer(common_name: str, ca) -> signers.SimpleSigner:
    """An end-entity signing certificate issued by the test root CA."""
    ca_key, ca_cert = ca
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cert = (
        x509.CertificateBuilder()
        .subject_name(_name(common_name))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(NOT_BEFORE)
        .not_valid_after(NOT_AFTER)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=True,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False
        )
        .sign(ca_key, hashes.SHA256())
    )
    signing_key = asn1_keys.PrivateKeyInfo.load(
        key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    # The CA certificate is embedded in the signature so validators can build the chain.
    return signers.SimpleSigner(
        signing_cert=_asn1_cert(cert),
        signing_key=signing_key,
        cert_registry=SimpleCertificateStore.from_certs([_asn1_cert(ca_cert)]),
    )


def sign(source: bytes, field: str, box, signer, reason: str) -> bytes:
    writer = IncrementalPdfFileWriter(io.BytesIO(source))
    fields.append_signature_field(writer, fields.SigFieldSpec(field, on_page=0, box=box))
    meta = signers.PdfSignatureMetadata(
        field_name=field,
        reason=reason,
        location="Test lab",
        subfilter=fields.SigSeedSubFilter.PADES,
    )
    out = io.BytesIO()
    signers.PdfSigner(meta, signer=signer).sign_pdf(writer, output=out)
    return out.getvalue()


def tamper(signed: bytes) -> bytes:
    """Change one byte inside the signed range, without touching the signature itself."""
    data = bytearray(signed)
    marker = b"/Producer"
    at = data.index(marker)
    data[at + 1] = ord("p")  # "/Producer" -> "/producer": still parses, but the digest fails
    return bytes(data)


def main() -> None:
    out = Path(sys.argv[1])
    trust = out.parent / "trust"
    trust.mkdir(exist_ok=True)
    ca = make_root_ca()
    (trust / "pdfoctopus-test-root-ca.pem").write_bytes(ca[1].public_bytes(serialization.Encoding.PEM))
    print("  ../trust/pdfoctopus-test-root-ca.pem")

    def save(name: str, data: bytes) -> None:
        (out / name).write_bytes(data)
        print(f"  {name} ({len(data) // 1024} KB)")

    invoice = (out / "invoice.pdf").read_bytes()
    once = sign(invoice, "Signature1", (40, 40, 240, 100), make_signer("Test Signer One", ca), "Approved")
    save("signed.pdf", once)
    twice = sign(once, "Signature2", (260, 40, 460, 100), make_signer("Test Signer Two", ca), "Counter-signed")
    save("signed-twice.pdf", twice)
    save("signed-tampered.pdf", tamper(once))


if __name__ == "__main__":
    main()
