// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Writing PDFs by hand, byte by byte, with a correct cross-reference table: for files that
// break the rules on purpose (loops, impossible numbers), which MuPDF wouldn't write itself.

const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

/** An object's body: PDF syntax, or a stream (dictionary entries plus data). */
export type RawObject = string | { dict: string; data: string | Uint8Array };

/** A stream object with a correct /Length; `dict` is the dictionary's entries. */
export function stream(dict: string, data: string | Uint8Array): RawObject {
  return { dict, data };
}

export interface RawPdfOptions {
  /** Extra trailer entries, e.g. "/Encrypt 9 0 R". /Size and /Root 1 0 R are added. */
  trailer?: string;
  /** Leave out the cross-reference table and trailer (MuPDF then has to repair the file). */
  noXref?: boolean;
}

/**
 * A PDF with the given objects, numbered from 1 in order (null leaves a number free). Object
 * 1 must be the catalog.
 */
export function rawPdf(
  objects: readonly (RawObject | null)[],
  options: RawPdfOptions = {},
): Uint8Array {
  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    length += bytes.length;
  };
  push(latin1("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"));
  const offsets: (number | null)[] = [];
  objects.forEach((object, i) => {
    if (object === null) {
      offsets.push(null);
      return;
    }
    offsets.push(length);
    if (typeof object === "string") {
      push(latin1(`${i + 1} 0 obj\n${object}\nendobj\n`));
      return;
    }
    const data = typeof object.data === "string" ? latin1(object.data) : object.data;
    push(latin1(`${i + 1} 0 obj\n<<${object.dict} /Length ${data.length}>>\nstream\n`));
    push(data);
    push(latin1("\nendstream\nendobj\n"));
  });
  if (!options.noXref) {
    const xref = length;
    let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      table +=
        offset === null
          ? "0000000000 65535 f \n"
          : `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    table += `trailer\n<</Size ${objects.length + 1} /Root 1 0 R ${options.trailer ?? ""}>>\n`;
    table += `startxref\n${xref}\n%%EOF\n`;
    push(latin1(table));
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The usual catalog, page tree and one US Letter page drawing `content`. */
export function onePage(content = "BT /F1 24 Tf 72 700 Td (Hello) Tj ET", pageExtra = "") {
  return [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>> ${pageExtra}>>`,
    stream("", content),
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
  ] as RawObject[];
}
