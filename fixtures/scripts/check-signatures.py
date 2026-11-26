# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Checks that the signed fixtures still have the signature status we expect, using pyhanko as
# an independent reference validator. Run in CI, and locally with:
#
#   pip install pyhanko && python3 fixtures/scripts/check-signatures.py [<folder>]
#
# The files named signed-by-pdfoctopus*.pdf were signed by PDFoctopus's own signing code
# (fixtures/scripts/sign-with-pdfoctopus.ts); they're also checked against the PAdES baseline
# B-B profile, and the timestamped one against B-T (its timestamp, from the test timestamp
# server, must be intact, trusted and for this signature). With a folder, freshly signed
# copies of those files in it are checked too: CI signs them with the code being tested first.
#
# PDFoctopus's own validator is tested against the same expectations in
# packages/sign/src/verify.test.ts; keep the two in step.

import logging
import sys
from pathlib import Path

from asn1crypto import pem, x509
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.general import check_ess_certid
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko.sign.validation.settings import KeyUsageConstraints
from pyhanko_certvalidator import ValidationContext

# pyhanko logs a full traceback when it rejects a change; the result is what we check.
logging.getLogger("pyhanko").setLevel(logging.CRITICAL)

FIXTURES = Path(__file__).resolve().parent.parent


def load_root(name: str) -> x509.Certificate:
    _, _, der = pem.unarmor((FIXTURES / "trust" / name).read_bytes())
    return x509.Certificate.load(der)


TEST_ROOT = load_root("pdfoctopus-test-root-ca.pem")
DIGICERT_ROOT = load_root("digicert-assured-id-root-ca.pem")
# Issued the test IDs in fixtures/test-ids, which PDFoctopus's own signing code is tested with.
TEST_SIGNING_ROOT = load_root("pdfoctopus-test-signing-ca.pem")
# Issued the test timestamp server (packages/sign/src/testTsa.ts, fixtures/test-ids/test-tsa.p12).
TEST_TSA_ROOT = load_root("pdfoctopus-test-tsa-ca.pem")

# file -> (trust root or roots, [per signature: (intact, trusted, modified after signing)])
# "modified" is False when nothing was changed after that signature, otherwise the kind of
# change pyhanko reports (e.g. "FORM_FILLING", "ANNOTATIONS").
EXPECTED = {
    "generated/signed.pdf": (TEST_ROOT, [(True, True, False)]),
    "generated/signed-twice.pdf": (TEST_ROOT, [(True, True, "FORM_FILLING"), (True, True, False)]),
    # A note added by MuPDF after signing. The PDF standard allows this, but pyhanko's strict
    # diff policy reports it as "OTHER" because the changed page is also referenced by the
    # signature field. Adobe Reader likewise reports changes made after signing.
    "generated/signed-then-annotated.pdf": (TEST_ROOT, [(True, True, "OTHER")]),
    "generated/signed-tampered.pdf": (TEST_ROOT, [(False, None, None)]),
    # A real document signed by the US Government Publishing Office through DigiCert.
    "public-domain/gpo-public-law-118-1-signed.pdf": (DIGICERT_ROOT, [(True, True, False)]),
}

# Signed by PDFoctopus. Each signature must also follow PAdES B-B (see check_pades_bb), and
# those in TIMESTAMPED B-T as well (see check_pades_bt).
OURS = {
    "signed-by-pdfoctopus.pdf": (TEST_SIGNING_ROOT, [(True, True, False)]),
    # The second signature was added later; the first stays valid.
    "signed-by-pdfoctopus-twice.pdf": (
        TEST_SIGNING_ROOT,
        [(True, True, "FORM_FILLING"), (True, True, False)],
    ),
    # PAdES B-T: timestamped by the test timestamp server.
    "signed-by-pdfoctopus-timestamped.pdf": (
        [TEST_SIGNING_ROOT, TEST_TSA_ROOT],
        [(True, True, False)],
    ),
}
TIMESTAMPED = {"signed-by-pdfoctopus-timestamped.pdf"}
EXPECTED.update({f"generated/{name}": expected for name, expected in OURS.items()})


def check_pades_bb(name: str, sig) -> list[str]:
    """The PAdES baseline B-B rules (ETSI EN 319 142-1, 6.3) that can be read off a signature."""
    errors = []
    obj = sig.sig_object
    if obj.get("/SubFilter") != "/ETSI.CAdES.detached":
        errors.append(f"{name}: SubFilter is {obj.get('/SubFilter')}, not /ETSI.CAdES.detached")
    if "/M" not in obj:
        errors.append(f"{name}: no signing time (/M) in the signature dictionary")
    signed_data = sig.signed_data
    if signed_data["encap_content_info"]["content"].native is not None:
        errors.append(f"{name}: the CMS isn't detached")
    attrs = {a["type"].native: a for a in sig.signer_info["signed_attrs"]}
    for required in ("content_type", "message_digest", "signing_certificate_v2"):
        if required not in attrs:
            errors.append(f"{name}: no {required} signed attribute")
    if "signing_time" in attrs:
        errors.append(f"{name}: a signing_time signed attribute (PAdES puts the time in /M)")
    if "signing_certificate_v2" in attrs:
        cert_id = attrs["signing_certificate_v2"]["values"][0]["certs"][0]
        if not check_ess_certid(sig.signer_cert, cert_id):
            errors.append(f"{name}: signingCertificateV2 doesn't match the signer's certificate")
    embedded = [c.chosen.dump() for c in signed_data["certificates"]]
    if sig.signer_cert.dump() not in embedded:
        errors.append(f"{name}: the signer's certificate isn't in the signature")
    return errors


def check_pades_bt(name: str, sig, status) -> list[str]:
    """
    PAdES baseline B-T (ETSI EN 319 142-1, 6.3): B-B plus a signature timestamp, an RFC 3161
    token over the signature value, as the unsigned attribute signature_time_stamp_token.
    pyhanko checks the token's own signature, that it is for this signature value, and the
    timestamp server's certificate chain.
    """
    errors = []
    unsigned = sig.signer_info["unsigned_attrs"]
    types = [a["type"].native for a in unsigned] if unsigned.native else []
    if "signature_time_stamp_token" not in types:
        errors.append(f"{name}: no signature_time_stamp_token unsigned attribute")
        return errors
    ts = status.timestamp_validity
    if ts is None:
        errors.append(f"{name}: pyhanko found no signature timestamp")
    else:
        if not ts.intact or not ts.valid:
            errors.append(f"{name}: the timestamp isn't intact and valid")
        if not ts.trusted:
            errors.append(f"{name}: the timestamp server isn't trusted")
        claimed = sig.self_reported_timestamp
        if claimed and ts.timestamp < claimed:
            errors.append(f"{name}: the timestamp ({ts.timestamp}) is before /M ({claimed})")
    return errors


def check(path: str, root, expected, folder: Path = FIXTURES) -> list[str]:
    errors = []
    with open(folder / path, "rb") as f:
        sigs = PdfFileReader(f, strict=False).embedded_signatures
        if len(sigs) != len(expected):
            return [f"{path}: expected {len(expected)} signatures, found {len(sigs)}"]
        for sig, (intact, trusted, modified) in zip(sigs, expected):
            errors_before = len(errors)
            # Validate at a fixed time so the check doesn't start failing when certificates expire.
            roots = root if isinstance(root, list) else [root]
            context = ValidationContext(
                trust_roots=roots, allow_fetching=False, moment=sig.self_reported_timestamp
            )
            status = validate_pdf_signature(
                sig, context, key_usage_settings=KeyUsageConstraints(key_usage={"digital_signature"})
            )
            name = f"{path} [{sig.field_name}]"
            if folder != FIXTURES:
                name = f"{folder / path} [{sig.field_name}]"
            if status.intact != intact:
                errors.append(f"{name}: intact={status.intact}, expected {intact}")
            if intact and status.trusted != trusted:
                errors.append(f"{name}: trusted={status.trusted}, expected {trusted}")
            if intact:
                level = status.modification_level.name if status.modification_level else None
                actual = False if level == "NONE" else level
                if actual != modified:
                    errors.append(f"{name}: modified after signing={actual}, expected {modified}")
            if Path(path).name in OURS:
                errors.extend(check_pades_bb(name, sig))
            if Path(path).name in TIMESTAMPED:
                errors.extend(check_pades_bt(name, sig, status))
            if len(errors) == errors_before:
                print(f"ok  {name}")
    return errors


def main() -> int:
    errors = [e for path, (root, exp) in EXPECTED.items() for e in check(path, root, exp)]
    if len(sys.argv) > 1:
        # Freshly signed copies, from: bun fixtures/scripts/sign-with-pdfoctopus.ts <folder>
        fresh = Path(sys.argv[1]).resolve()
        for name, (root, exp) in OURS.items():
            errors.extend(check(name, root, exp, fresh))
    for e in errors:
        print(f"FAIL {e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
