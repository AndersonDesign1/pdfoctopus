# Test fixtures

PDFs used for regression and crash testing. Every PDF in this folder is opened by
`packages/core/src/fixtures.test.ts`, which checks the engine never crashes on any of them.

| Folder           | What                                                               | Licence                                                       |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `generated/`     | Files we made ourselves with `scripts/generate.mjs`. All fictional | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `third-party/`   | Files from other open projects and archives, unmodified            | Per file (see below)                                          |
| `public-domain/` | US federal government documents                                    | Public domain (17 U.S.C. § 105)                               |
| `trust/`         | Root certificates used to validate the signed fixtures             | See [Signatures](#signatures)                                 |

## Rules for adding a fixture

- Only add files you have the right to share, and record the source and licence below.
- Remove or anonymise personal data first (names, addresses, account numbers, images of
  handwritten signatures). Digitally signed files must keep their signatures intact (editing
  them breaks the signature), so only add signed files that contain no personal data.
- Keep each file under **25 MB**. Git keeps every version of every file forever, so each
  big file makes every clone and CI run slower for good (GitHub warns at 50 MB and refuses
  100 MB). Larger performance-test files should be downloaded by a script instead of
  committed. Ask in an issue first.
- Prefer adding a generated file (edit `scripts/generate.mjs`) when you need a specific
  feature: it has no licence questions and can be rebuilt.

## Passwords

| File                                                                                 | Open password  | Owner password       |
| ------------------------------------------------------------------------------------ | -------------- | -------------------- |
| `generated/encrypted-aes256.pdf`                                                     | `open-sesame`  | `owner-secret`       |
| `generated/encrypted-rc4-40.pdf`                                                     | `open-sesame`  | `owner-secret`       |
| `generated/restricted-permissions.pdf`                                               | none           | `owner-secret`       |
| `third-party/py-pdf/005-libreoffice-writer-password_libreoffice-writer-password.pdf` | `openpassword` | `permissionpassword` |

## generated/ (CC0-1.0)

Made by [`scripts/generate.mjs`](./scripts/generate.mjs) from the HTML in
[`scripts/sources/`](./scripts/sources). All names, companies and numbers are made up.

CC0 covers the content we wrote. Some files embed subsets of free fonts, which keep their own
licences; all of them allow embedding in documents:

| Font              | Embedded in                                            | Licence                                                                              |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| DejaVu Sans       | invoice, report and the files derived from the invoice | [DejaVu Fonts licence](https://dejavu-fonts.github.io/License.html) (Bitstream Vera) |
| Liberation Serif  | both contracts and the annotated contract              | [SIL OFL 1.1](https://openfontlicense.org)                                           |
| Inter             | `contract-libreoffice.pdf` (headings)                  | [SIL OFL 1.1](https://openfontlicense.org)                                           |
| WenQuanYi Zen Hei | `cjk-text.pdf`                                         | GPL-2.0 with a font embedding exception                                              |

| File                               | Category    | Notes                                                                                       |
| ---------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `invoice.pdf`                      | Invoice     | One page, table, embedded fonts (Chromium/Skia)                                             |
| `contract-chromium.pdf`            | Contract    | Two-page services agreement, serif, justified text (Chromium/Skia)                          |
| `contract-libreoffice.pdf`         | Contract    | Same contract through LibreOffice, a different PDF producer                                 |
| `cjk-text.pdf`                     | CJK         | Japanese, Simplified and Traditional Chinese, Korean, and vertical Japanese text            |
| `report-500-pages.pdf`             | Very large  | 500 pages of text and tables, for scrolling and performance tests                           |
| `scanned-invoice.pdf`              | Scan        | The invoice as a slightly rotated, noisy greyscale JPEG with no text layer (simulated scan) |
| `annotated-contract.pdf`           | Annotations | Highlight, sticky note, ink, rectangle, free text, strikeout                                |
| `incremental-updates.pdf`          | Revisions   | Invoice with three incremental updates appended                                             |
| `encrypted-aes256.pdf`             | Encrypted   | AES-256, needs a password to open                                                           |
| `encrypted-rc4-40.pdf`             | Encrypted   | Legacy 40-bit RC4, needs a password to open                                                 |
| `restricted-permissions.pdf`       | Encrypted   | Opens without a password; printing, copying, editing and annotating not permitted           |
| `signed.pdf`                       | Signed      | One PAdES signature from the PDFoctopus test CA (see [Signatures](#signatures))             |
| `signed-then-annotated.pdf`        | Signed      | A note added after signing (MuPDF incremental save); the signature stays intact             |
| `signed-tampered.pdf`              | Signed      | One byte changed inside the signed range, so the signature no longer verifies               |
| `signed-twice.pdf`                 | Signed      | Two signatures; the second was added incrementally and the first stays valid                |
| `malformed-truncated.pdf`          | Malformed   | Invoice cut off at 60% (no xref or trailer)                                                 |
| `malformed-bad-startxref.pdf`      | Malformed   | `startxref` points to the wrong offset; needs repair                                        |
| `malformed-junk-before-header.pdf` | Malformed   | 1 KB of junk before `%PDF-`                                                                 |
| `malformed-html-named-pdf.pdf`     | Malformed   | An HTML error page saved with a `.pdf` name (common with failed downloads)                  |
| `malformed-empty.pdf`              | Malformed   | Zero bytes                                                                                  |

## public-domain/

Works of the US federal government, which are not subject to copyright in the United States
(17 U.S.C. § 105). Downloaded unmodified on 6–7 November 2026.

| File                              | Category            | Source                                                                    | Notes                                                                     |
| --------------------------------- | ------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `irs-form-w9.pdf`                 | Form (AcroForm+XFA) | <https://www.irs.gov/pub/irs-pdf/fw9.pdf>                                 | Fillable, hybrid XFA form (Adobe Designer)                                |
| `irs-form-1040.pdf`               | Form (AcroForm+XFA) | <https://www.irs.gov/pub/irs-pdf/f1040.pdf>                               | Fillable, hybrid XFA form (Adobe Designer)                                |
| `opm-form-sf86.pdf`               | Form (XFA), large   | <https://www.opm.gov/forms/pdf_fill/sf86.pdf>                             | 136-page XFA form (LiveCycle Designer), 8 MB                              |
| `gpo-public-law-118-1-signed.pdf` | Signed (trusted)    | <https://www.govinfo.gov/content/pkg/PLAW-118publ1/pdf/PLAW-118publ1.pdf> | Public Law 118-1, digitally signed by the US Government Publishing Office |

## third-party/internet-archive/ (real scans)

Real scanned paper documents from the [Internet Archive](https://archive.org), each with the
OCR text layer the Archive adds. Downloaded unmodified on 7 November 2026 and renamed.

| File                                   | Original item                                                                                                                                                     | Licence                                                   | Notes                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| `scan-typed-business-letter-1902.pdf`  | [C.W. Trainer Manufacturing Company, letter](https://archive.org/details/cwtrainermanufac00unse_0) (1902), Boston Public Library                                  | Public domain (1902)                                      | Typed letter on printed letterhead, 2 pages, colour  |
| `scan-handwritten-letter-1900.pdf`     | [Letter regarding acquiring funds for College library](https://archive.org/details/mcht_a2ms_brainerd_19000621_02) (1900), Middlebury College Special Collections | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Handwritten, 2 pages, LuraDocument compression       |
| `scan-business-book-1896-80-pages.pdf` | [A treatise on business practice](https://archive.org/details/treatiseonbusine00powerich) (c1896)                                                                 | Public domain (marked "not in copyright")                 | 80 scanned pages including forms and cheques, 7.5 MB |

## third-party/py-pdf/ (CC-BY-SA-4.0)

From [py-pdf/sample-files](https://github.com/py-pdf/sample-files) by the py-pdf contributors,
licensed under [CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/). Files are
unmodified; each name is the upstream folder and file name joined with `_`. Downloaded on
6 November 2026.

| File (prefix)                          | Category        | What it covers                                    |
| -------------------------------------- | --------------- | ------------------------------------------------- |
| `001-trivial_*`                        | Basic           | Minimal pdfTeX document                           |
| `002-trivial-libre-office-writer_*`    | Basic           | Minimal LibreOffice Writer document               |
| `003-pdflatex-image_*`                 | Images          | Embedded image                                    |
| `004-pdflatex-4-pages_*`               | Basic           | Four pages                                        |
| `005-libreoffice-writer-password_*`    | Encrypted       | Open and permissions passwords (see above)        |
| `006-pdflatex-outline_*`               | Outline         | Bookmarks                                         |
| `007-imagemagick-images_*`             | Images / scan   | ASCII85, CCITT fax (scan-like), LZW, mixed images |
| `008-reportlab-inline-image_*`         | Images          | Inline image                                      |
| `009-pdflatex-geotopo_*`               | Large           | 117 pages, original (5 MB) and recompressed       |
| `010-pdflatex-forms_*`                 | Form (AcroForm) | pdfTeX form fields                                |
| `011-google-doc-document_*`            | Basic           | Google Docs export                                |
| `012-libreoffice-form_*`               | Form (AcroForm) | LibreOffice form fields                           |
| `013-reportlab-overlay_*`              | Form / overlay  | Page merged with an overlay                       |
| `014-outlines_*`                       | Outline         | Bookmarks with wrong titles                       |
| `015-arabic_*`                         | Right-to-left   | Arabic text, rotated pages, one-line CMap         |
| `016-libre-office-link_*`              | Links           | Hyperlink                                         |
| `017-unreadable-meta-data_*`           | Malformed       | Metadata that can't be decoded                    |
| `018-base64-image_*`                   | Images          | Image from PDF Annotator                          |
| `019-grayscale-image_*`                | Images          | Greyscale image                                   |
| `020-xmp_*`                            | Metadata        | XMP metadata                                      |
| `021-pdfa_*`                           | PDF/A           | PDF/A output from Ghostscript                     |
| `022-pdfkit_*`                         | Basic           | Qt-generated                                      |
| `023-cmyk-image_*`                     | Images          | CMYK image                                        |
| `024-annotations_*`                    | Annotations     | Annotations from fpdf2                            |
| `025-attachment_*`                     | Attachments     | Embedded file                                     |
| `026-latex-multicolumn_*`              | Multi-column    | Two-column layout                                 |
| `027-cropped-rotated-scaled_*`         | Page boxes      | Cropped, rotated and scaled pages, form field     |
| `028-image-references-deduplication_*` | Images          | Shared image references                           |
| `029-optional-content-groups_*`        | Layers          | Optional content (layers)                         |
| `030-tagged-pdf_*`                     | Accessibility   | Tagged PDF structure                              |
| `031-png-predictors_*`, `032-*`        | Images          | PNG predictors, low bit depth                     |

## Signatures

Signed fixtures are checked by [`scripts/check-signatures.py`](./scripts/check-signatures.py)
(also run in CI), using [pyhanko](https://github.com/MatthiasValvekens/pyHanko) as an
independent validator. Expected results:

| File                                            | Trusted root                            | Intact | Trusted | Changed after signing                       |
| ----------------------------------------------- | --------------------------------------- | ------ | ------- | ------------------------------------------- |
| `generated/signed.pdf`                          | `trust/pdfoctopus-test-root-ca.pem`     | yes    | yes     | no                                          |
| `generated/signed-twice.pdf`                    | `trust/pdfoctopus-test-root-ca.pem`     | yes    | yes     | first signature: yes (the second signature) |
| `generated/signed-then-annotated.pdf`           | `trust/pdfoctopus-test-root-ca.pem`     | yes    | yes     | yes (a note)                                |
| `generated/signed-tampered.pdf`                 | `trust/pdfoctopus-test-root-ca.pem`     | **no** | —       | —                                           |
| `public-domain/gpo-public-law-118-1-signed.pdf` | `trust/digicert-assured-id-root-ca.pem` | yes    | yes     | no                                          |

- `pdfoctopus-test-root-ca.pem` is a throwaway root CA created by `scripts/sign.py`. Its
  private key was never saved, so nobody can sign with it. Tests choose to trust it, the
  same way Adobe Reader trusts the CAs on its list. Anywhere else it is untrusted.
- `digicert-assured-id-root-ca.pem` is DigiCert's public root certificate (SHA-256
  fingerprint `3E:90:99:B5:01:5E:8F:48:6C:00:BC:EA:9D:11:1E:E7:21:FA:BA:35:5A:89:BC:F1:DF:69:56:1E:3D:C6:32:5C`),
  downloaded from <https://cacerts.digicert.com/DigiCertAssuredIDRootCA.crt>. It is on the
  trust lists used by Adobe Reader and operating systems, so the GPO file is a real-world
  "trusted signature" case.

## Known gaps

- A **dynamic** XFA form (all XFA forms here are static or hybrid).
