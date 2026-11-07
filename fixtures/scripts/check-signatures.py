# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Checks that the signed fixtures still have the signature status we expect, using pyhanko as
# an independent reference validator. Run in CI, and locally with:
#
#   pip install pyhanko && python3 fixtures/scripts/check-signatures.py
#
# Later, PDFoctopus's own validator (Phase 5) is tested against the same expectations.

import logging
import sys
from pathlib import Path

from asn1crypto import pem, x509
from pyhanko.pdf_utils.reader import PdfFileReader
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

# file -> (trust root, [per signature: (intact, trusted, modified after signing)])
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


def check(path: str, root, expected) -> list[str]:
    errors = []
    with open(FIXTURES / path, "rb") as f:
        sigs = PdfFileReader(f, strict=False).embedded_signatures
        if len(sigs) != len(expected):
            return [f"{path}: expected {len(expected)} signatures, found {len(sigs)}"]
        for sig, (intact, trusted, modified) in zip(sigs, expected):
            # Validate at a fixed time so the check doesn't start failing when certificates expire.
            context = ValidationContext(
                trust_roots=[root], allow_fetching=False, moment=sig.self_reported_timestamp
            )
            status = validate_pdf_signature(
                sig, context, key_usage_settings=KeyUsageConstraints(key_usage={"digital_signature"})
            )
            name = f"{path} [{sig.field_name}]"
            if status.intact != intact:
                errors.append(f"{name}: intact={status.intact}, expected {intact}")
            if intact and status.trusted != trusted:
                errors.append(f"{name}: trusted={status.trusted}, expected {trusted}")
            if intact:
                level = status.modification_level.name if status.modification_level else None
                actual = False if level == "NONE" else level
                if actual != modified:
                    errors.append(f"{name}: modified after signing={actual}, expected {modified}")
            if not errors:
                print(f"ok  {name}")
    return errors


def main() -> int:
    errors = [e for path, (root, exp) in EXPECTED.items() for e in check(path, root, exp)]
    for e in errors:
        print(f"FAIL {e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
