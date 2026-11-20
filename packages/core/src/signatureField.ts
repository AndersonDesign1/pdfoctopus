// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The PDF side of certificate signing: the signature field (a widget on the page), its
// visible appearance, and the signature dictionary with room for the signature. MuPDF's
// JavaScript API can't sign, so the dictionary is written by hand (PAdES: ETSI EN 319 142-1,
// SubFilter /ETSI.CAdES.detached) and filled in after saving (see signature.ts).

import * as mupdf from "mupdf";
import { invert, type Matrix6, transformRect } from "./annotationObjects";
import { buildField, fieldNames } from "./formBuild";
import { acroForm } from "./forms";
import { BYTE_RANGE_PLACEHOLDER, pdfDate } from "./signature";
import { textWidth } from "./textStamp";

/** What the signature's box shows, and what goes in the signature dictionary. */
export interface SignatureDetails {
  /** The signer's name, from their certificate. */
  signer: string;
  /** The date and time shown in the box, as the app formats it. */
  dateText: string;
  /** When the signature was made, for the dictionary's /M entry. */
  signingTime: Date;
  reason?: string;
  location?: string;
}

/** A signature field (empty or signed) as the app lists it. */
export interface SignatureFieldInfo {
  /** The field's full name. */
  name: string;
  page: number;
  /** Where on the page, in points from its top-left corner as shown. */
  rect: [number, number, number, number];
  signed: boolean;
}

/** /SigFlags: SignaturesExist (1) and AppendOnly (2). */
const SIG_FLAGS = 3;
/** Widget flags: print (4) and locked (128), so the signed box can't be moved. */
const SIGNED_WIDGET_FLAGS = 4 | 128;
export const MAX_SIGNATURE_TEXT = 200;

/** From PDF space to points from the page's top-left corner as shown. */
export function shownTransform(page: mupdf.PDFPage): Matrix6 {
  const [a, b, c, d, e, f] = page.getTransform();
  const [x0, y0] = page.getBounds();
  return [a, b, c, d, e - x0, f - y0];
}

function pageRotation(page: mupdf.PDFObject): number {
  const value = page.getInheritable("Rotate");
  const r = value.isNumber() ? ((Math.round(value.asNumber()) % 360) + 360) % 360 : 0;
  return r % 90 === 0 ? r : 0;
}

/** Every signature field's widget on every page, with whether it's signed. */
export function listSignatureFields(pdf: mupdf.PDFDocument): SignatureFieldInfo[] {
  const out: SignatureFieldInfo[] = [];
  const count = pdf.countPages();
  for (let i = 0; i < count; i++) {
    const page = pdf.loadPage(i);
    try {
      const shown = shownTransform(page);
      for (const w of page.getWidgets()) {
        if (w.getFieldType() !== "signature") continue;
        const object = w.getObject();
        const r = object.get("Rect");
        if (!r.isArray() || r.length !== 4) continue;
        const rect = [0, 1, 2, 3].map((k) => r.get(k).asNumber());
        out.push({
          name: w.getName(),
          page: i,
          rect: transformRect(shown, rect),
          signed: isSigned(object),
        });
      }
    } finally {
      page.destroy();
    }
  }
  return out;
}

/** Whether a signature widget's field has a value (a signature dictionary). */
function isSigned(widget: mupdf.PDFObject): boolean {
  for (let node = widget, depth = 0; !node.isNull() && depth < 32; depth++) {
    if (!node.get("V").isNull()) return true;
    if (!node.get("T").isNull()) return false;
    node = node.get("Parent");
  }
  return false;
}

/** A new field name, "Signature1", "Signature2"…, that the form doesn't use yet. */
export function newSignatureName(pdf: mupdf.PDFDocument): string {
  const taken = fieldNames(acroForm(pdf));
  for (let i = 1; ; i++) {
    const name = `Signature${i}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * The signature dictionary, with placeholders for /ByteRange and /Contents (`size` bytes of
 * zeros, written as hex). The time is in /M; no signingTime goes in the signed attributes,
 * as PAdES B-B asks.
 */
export function signatureDictionary(
  pdf: mupdf.PDFDocument,
  details: SignatureDetails,
  size: number,
): mupdf.PDFObject {
  const sig = pdf.newDictionary();
  sig.put("Type", pdf.newName("Sig"));
  sig.put("Filter", pdf.newName("Adobe.PPKLite"));
  sig.put("SubFilter", pdf.newName("ETSI.CAdES.detached"));
  const range = pdf.newArray();
  for (const v of BYTE_RANGE_PLACEHOLDER) range.push(pdf.newInteger(v));
  sig.put("ByteRange", range);
  sig.put("Contents", pdf.newByteString(new Uint8Array(size)));
  sig.put("M", pdf.newString(pdfDate(details.signingTime)));
  if (details.signer) sig.put("Name", pdf.newString(details.signer));
  if (details.reason) sig.put("Reason", pdf.newString(details.reason));
  if (details.location) sig.put("Location", pdf.newString(details.location));
  return pdf.addObject(sig);
}

/**
 * Put a signature into the document: in the empty signature field called `field` on `page`,
 * or in a new field covering `rect` (points as shown) on `page`. Returns the field's name.
 */
export function placeSignature(
  pdf: mupdf.PDFDocument,
  page: number,
  target: { field: string } | { rect: readonly number[] },
  details: SignatureDetails,
  size: number,
): string {
  const pageObject = pdf.findPage(page);
  const loaded = pdf.loadPage(page);
  let shown: Matrix6;
  let widget: mupdf.PDFObject | null = null;
  try {
    shown = shownTransform(loaded);
    if ("field" in target) {
      const w = loaded
        .getWidgets()
        .find((x) => x.getFieldType() === "signature" && x.getName() === target.field);
      if (!w) throw new Error(`There's no signature field called "${target.field}" on that page`);
      widget = w.getObject();
      if (isSigned(widget)) throw new Error(`The field "${target.field}" is already signed`);
    }
  } finally {
    loaded.destroy();
  }

  let form = acroForm(pdf);
  if (!form) {
    form = pdf.addObject(pdf.newDictionary());
    form.put("Fields", pdf.newArray());
    pdf.getTrailer().get("Root").put("AcroForm", form);
  }
  if (!form.get("Fields").isArray()) form.put("Fields", pdf.newArray());
  const flags = form.get("SigFlags");
  if (!flags.isNumber() || flags.asNumber() !== SIG_FLAGS) form.put("SigFlags", SIG_FLAGS);
  // A hybrid form's XFA copy would show the form without the signature (in Adobe Reader).
  if (!form.get("XFA").isNull()) form.delete("XFA");

  let name: string;
  if (widget) {
    name = (target as { field: string }).field;
  } else {
    const [x0, y0, x1, y1] = (target as { rect: readonly number[] }).rect as [
      number,
      number,
      number,
      number,
    ];
    name = newSignatureName(pdf);
    const rect = transformRect(invert(shown), [x0, y0, x1, y1]);
    widget = buildField(
      pdf,
      pageObject,
      { page, kind: "signature", rect: [x0, y0, x1, y1], name },
      name,
      rect,
      null,
    ).widget;
    form.get("Fields").push(widget);
    let annots = pageObject.get("Annots");
    if (!annots.isArray()) {
      annots = pdf.newArray();
      pageObject.put("Annots", annots);
    }
    annots.push(widget);
  }

  // The value goes on the field (the widget, or the parent holding the name).
  let field = widget;
  for (let depth = 0; field.get("T").isNull() && depth < 32; depth++) {
    const parent = field.get("Parent");
    if (parent.isNull()) break;
    field = parent;
  }
  field.put("V", signatureDictionary(pdf, details, size));
  widget.put("F", SIGNED_WIDGET_FLAGS);
  if (widget.get("P").isNull()) widget.put("P", pageObject);

  // The box as shown, which is what the appearance is drawn for.
  const r = widget.get("Rect");
  const pdfRect = [0, 1, 2, 3].map((k) => r.get(k).asNumber());
  const [sx0, sy0, sx1, sy1] = transformRect(shown, pdfRect);
  const ap = pdf.newDictionary();
  ap.put("N", signatureAppearance(pdf, details, sx1 - sx0, sy1 - sy0, pageRotation(pageObject)));
  widget.put("AP", ap);
  return name;
}

/** Text in WinAnsi, the encoding the standard fonts use: other characters become "?". */
export function winAnsi(text: string): string {
  const extra: Record<string, number> = {
    "€": 0x80,
    "…": 0x85,
    "‘": 0x91,
    "’": 0x92,
    "“": 0x93,
    "”": 0x94,
    "•": 0x95,
    "–": 0x96,
    "—": 0x97,
  };
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) out += ch;
    else if (extra[ch] !== undefined) out += String.fromCharCode(extra[ch]);
    else out += "?";
  }
  return out;
}

function hexString(text: string): string {
  let hex = "";
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(2, "0");
  return `<${hex}>`;
}

const num = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** Lines of the box: [text, bold]. */
export function signatureLines(details: SignatureDetails): [string, boolean][] {
  const lines: [string, boolean][] = [
    ["Digitally signed by", false],
    [details.signer || "Unknown signer", true],
    [`Date: ${details.dateText}`, false],
  ];
  if (details.reason) lines.push([`Reason: ${details.reason}`, false]);
  if (details.location) lines.push([`Location: ${details.location}`, false]);
  return lines;
}

/**
 * The box's appearance: who signed and when, in Helvetica, sized to fit a `width` × `height`
 * box (as the page is shown). `rotation` turns it back by the page's rotation.
 */
export function signatureAppearance(
  pdf: mupdf.PDFDocument,
  details: SignatureDetails,
  width: number,
  height: number,
  rotation: number,
): mupdf.PDFObject {
  const lines = signatureLines(details).map(([t, bold]) => [winAnsi(t), bold] as const);
  const bold = new mupdf.Font("Helvetica-Bold");
  const regular = new mupdf.Font("Helvetica");
  const NAME = 1.35; // The name is this much bigger than the other lines.
  const LEADING = 1.2;
  const pad = Math.min(4, width * 0.05, height * 0.08);
  let size: number;
  try {
    // At size 1: the widest line, and the height of all the lines.
    const widest = Math.max(
      ...lines.map(([t, b]) => textWidth(b ? bold : regular, t) * (b ? NAME : 1)),
    );
    const tall = lines.reduce((sum, [, b]) => sum + (b ? NAME : 1) * LEADING, 0);
    size = Math.min((width - 2 * pad) / widest, (height - 2 * pad) / tall, 11);
  } finally {
    bold.destroy();
    regular.destroy();
  }
  size = Math.max(size, 1);
  const total = lines.reduce((sum, [, b]) => sum + (b ? NAME : 1) * LEADING * size, 0);
  let y = height - (height - total) / 2;
  const ops = ["q", "0.1 0.1 0.1 rg"];
  for (const [text, b] of lines) {
    const s = (b ? NAME : 1) * size;
    y -= s * LEADING;
    // The baseline sits a little above the bottom of the line's slot.
    const baseline = y + s * (LEADING - 1) + s * 0.2;
    ops.push(
      `BT /${b ? "F2" : "F1"} ${num(s)} Tf ${num(pad)} ${num(baseline)} Td ${hexString(text)} Tj ET`,
    );
  }
  ops.push("Q");

  const font = (base: string) => {
    const dict = pdf.newDictionary();
    dict.put("Type", pdf.newName("Font"));
    dict.put("Subtype", pdf.newName("Type1"));
    dict.put("BaseFont", pdf.newName(base));
    dict.put("Encoding", pdf.newName("WinAnsiEncoding"));
    return pdf.addObject(dict);
  };
  const fonts = pdf.newDictionary();
  fonts.put("F1", font("Helvetica"));
  fonts.put("F2", font("Helvetica-Bold"));
  const resources = pdf.newDictionary();
  resources.put("Font", fonts);

  const form = pdf.newDictionary();
  form.put("Type", pdf.newName("XObject"));
  form.put("Subtype", pdf.newName("Form"));
  const bbox = pdf.newArray();
  for (const v of [0, 0, width, height]) bbox.push(v);
  form.put("BBox", bbox);
  form.put("Resources", resources);
  if (rotation !== 0) {
    const t = (rotation * Math.PI) / 180;
    const c = Math.round(Math.cos(t));
    const s = Math.round(Math.sin(t));
    const matrix = pdf.newArray();
    for (const v of [c, s, -s, c, 0, 0]) matrix.push(v);
    form.put("Matrix", matrix);
  }
  return pdf.addStream(ops.join("\n"), form);
}
