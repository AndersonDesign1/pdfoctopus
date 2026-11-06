# Test fixtures

PDFs used for regression and crash testing. Every file in this folder is opened by
`packages/core/src/fixtures.test.ts`, which checks the engine never crashes on any of them.

| Folder           | What                                                               | Licence                                                       |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `generated/`     | Files we made ourselves with `scripts/generate.mjs`. All fictional | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `third-party/`   | Files from other open projects, unmodified                         | Per file (see below)                                          |
| `public-domain/` | US federal government forms                                        | Public domain (17 U.S.C. § 105)                               |

## Rules for adding a fixture

- Only add files you have the right to share, and record the source and licence below.
- Remove or anonymise personal data first (names, addresses, account numbers, images of
  handwritten signatures). Digitally signed files must keep their signatures intact (editing
  them breaks the signature), so only add signed files that contain no personal data.
- Keep each file under 5 MB. Larger test files (needed for performance tests) will be
  stored outside git, for example as release assets or with Git LFS. Don't commit them here.
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
| `signed.pdf`                       | Signed      | One PAdES signature, self-signed test certificate (not trusted)                             |
| `signed-twice.pdf`                 | Signed      | Two signatures; the second was added incrementally and the first stays valid                |
| `malformed-truncated.pdf`          | Malformed   | Invoice cut off at 60% (no xref or trailer)                                                 |
| `malformed-bad-startxref.pdf`      | Malformed   | `startxref` points to the wrong offset; needs repair                                        |
| `malformed-junk-before-header.pdf` | Malformed   | 1 KB of junk before `%PDF-`                                                                 |
| `malformed-html-named-pdf.pdf`     | Malformed   | An HTML error page saved with a `.pdf` name (common with failed downloads)                  |
| `malformed-empty.pdf`              | Malformed   | Zero bytes                                                                                  |

## public-domain/

Works of the US federal government, which are not subject to copyright in the United States
(17 U.S.C. § 105). Downloaded unmodified on 6 November 2026.

| File                | Category            | Source                                      | Notes                                      |
| ------------------- | ------------------- | ------------------------------------------- | ------------------------------------------ |
| `irs-form-w9.pdf`   | Form (AcroForm+XFA) | <https://www.irs.gov/pub/irs-pdf/fw9.pdf>   | Fillable, hybrid XFA form (Adobe Designer) |
| `irs-form-1040.pdf` | Form (AcroForm+XFA) | <https://www.irs.gov/pub/irs-pdf/f1040.pdf> | Fillable, hybrid XFA form (Adobe Designer) |

## third-party/py-pdf/ (CC-BY-SA-4.0)

From [py-pdf/sample-files](https://github.com/py-pdf/sample-files) by the py-pdf contributors,
licensed under [CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/). Files are
unmodified; each name is the upstream folder and file name joined with `_`. Downloaded on
6 November 2026. `009-pdflatex-geotopo/GeoTopo.pdf` is left out because it is over 5 MB (its
compressed version is included).

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
| `009-pdflatex-geotopo_*-komprimiert*`  | Large           | 117 pages, recompressed by a PDF optimiser        |
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

## Known gaps

- A **dynamic** XFA form (the IRS forms are hybrid, so they also have AcroForm fields). The
  public-domain ones we found are over 5 MB.
- Real scanned documents (only simulated scans so far).
- A real-world signed document validating against a trusted certificate.
