# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Creates digitally signed test fixtures with a throwaway, self-signed certificate.
# Called by generate.mjs:  python3 sign.py <fixtures/generated>
#
# Output:
#   signed.pdf        invoice.pdf with one signature
#   signed-twice.pdf  signed.pdf with a second signature added incrementally (both valid)

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


def make_signer(common_name: str) -> signers.SimpleSigner:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "PDFoctopus test fixtures (NOT TRUSTED)"),
        ]
    )
    now = datetime.datetime(2026, 11, 1, tzinfo=datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=365 * 30))
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
        .sign(key, hashes.SHA256())
    )
    signing_cert = asn1_x509.Certificate.load(cert.public_bytes(serialization.Encoding.DER))
    signing_key = asn1_keys.PrivateKeyInfo.load(
        key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return signers.SimpleSigner(
        signing_cert=signing_cert,
        signing_key=signing_key,
        cert_registry=SimpleCertificateStore.from_certs([signing_cert]),
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


def main() -> None:
    out = Path(sys.argv[1])
    invoice = (out / "invoice.pdf").read_bytes()
    once = sign(invoice, "Signature1", (40, 40, 240, 100), make_signer("Test Signer One"), "Approved")
    (out / "signed.pdf").write_bytes(once)
    print(f"  signed.pdf ({len(once) // 1024} KB)")
    twice = sign(once, "Signature2", (260, 40, 460, 100), make_signer("Test Signer Two"), "Counter-signed")
    (out / "signed-twice.pdf").write_bytes(twice)
    print(f"  signed-twice.pdf ({len(twice) // 1024} KB)")


if __name__ == "__main__":
    main()
