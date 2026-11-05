# Test fixtures

Real-world PDFs used for regression and crash testing (target: 30+). Cover invoices,
contracts, forms (AcroForm and XFA), scans, CJK text, encrypted files, signed files,
very large files and deliberately malformed files.

Rules for adding a fixture:

- Only add files you have the right to share.
- Remove or anonymise personal data first (names, addresses, account numbers, images of
  handwritten signatures). Digitally signed files must keep their signatures intact (editing
  them breaks the signature), so only add signed files that contain no personal data.
- Keep each file under 5 MB. Larger test files (needed for performance tests) will be
  stored outside git, for example as release assets or with Git LFS. Don't commit them here.
- Record each file in the table below.

| File         | Category | Source | Licence |
| ------------ | -------- | ------ | ------- |
| _(none yet)_ |          |        |         |
