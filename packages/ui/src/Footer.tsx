// SPDX-License-Identifier: AGPL-3.0-or-later

export const SOURCE_CODE_URL = "https://github.com/AndersonDesign1/pdfoctopus";

/** App footer. The "Source code" link is required by the AGPL network clause. */
export function Footer() {
  return (
    <footer className="pdfo-footer">
      <span>PDFoctopus · Free and open source (AGPL-3.0-or-later)</span>
      <a href={SOURCE_CODE_URL} target="_blank" rel="noreferrer">
        Source code
      </a>
    </footer>
  );
}
