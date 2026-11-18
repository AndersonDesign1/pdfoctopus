// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Low-level helpers for changing annotations that are already in a file: what to call them,
// which changes MuPDF can redraw, moving their coordinates, and snapshots of their dictionary
// entries so an edit can be undone without copying the document.

import type * as mupdf from "mupdf";

/** A 2D matrix [a, b, c, d, e, f], as MuPDF uses. */
export type Matrix6 = [number, number, number, number, number, number];

/**
 * Keys an edit can change. A snapshot of these (and the pop-up's /Rect) is enough to put an
 * annotation back exactly as it was.
 */
export const EDITABLE_KEYS = [
  "Rect",
  "RD",
  "QuadPoints",
  "InkList",
  "L",
  "Vertices",
  "CL",
  "C",
  "IC",
  "DA",
  "DS",
  "RC",
  "Contents",
  "AP",
  "M",
] as const;

/** Keys holding coordinates that a move shifts: flat lists of x, y pairs, or lists of them. */
const POINT_KEYS = ["Rect", "QuadPoints", "L", "Vertices", "CL"] as const;

/** Annotation types that aren't markup a person added, so they're never listed. */
const HIDDEN_TYPES = new Set(["Popup", "Link", "Widget", "PrinterMark", "TrapNet", "Watermark"]);

/** Flag (PDF 1.7, 12.5.3) for annotations that aren't shown. */
const ANNOT_FLAG_HIDDEN = 2;

/** Types whose box can be resized: MuPDF redraws shapes and text boxes, and stamps scale. */
const RESIZABLE = new Set(["Square", "Circle", "FreeText", "Stamp"]);

/** Types MuPDF can redraw in a new colour. */
const RECOLORABLE = new Set([
  "Highlight",
  "Underline",
  "StrikeOut",
  "Squiggly",
  "Ink",
  "Square",
  "Circle",
  "Line",
  "Polygon",
  "PolyLine",
  "Text",
  "FreeText",
]);

/** Types whose text can be edited: sticky notes and text boxes. */
const TEXT_TYPES = new Set(["Text", "FreeText"]);

/** Whether an annotation is one a person can select, move or delete. */
export function isListed(object: mupdf.PDFObject): boolean {
  const type = object.get("Subtype");
  if (!type.isName() || HIDDEN_TYPES.has(type.asName())) return false;
  const flags = object.get("F");
  if (flags.isNumber() && (flags.asNumber() & ANNOT_FLAG_HIDDEN) !== 0) return false;
  return object.isIndirect() && object.get("Rect").isArray();
}

export function subtype(object: mupdf.PDFObject): string {
  const type = object.get("Subtype");
  return type.isName() ? type.asName() : "";
}

/** What people would call an annotation: "highlight", "signature", "white-out box". */
export function describe(object: mupdf.PDFObject): string {
  const type = subtype(object);
  switch (type) {
    case "Highlight":
      return "highlight";
    case "Underline":
      return "underline";
    case "Squiggly":
      return "squiggly underline";
    case "StrikeOut":
      return "strikethrough";
    case "Ink":
      return "drawing";
    case "Square":
      return isWhiteout(object) ? "white-out box" : "rectangle";
    case "Circle":
      return "ellipse";
    case "Line": {
      const ends = object.get("LE");
      let arrow = false;
      if (ends.isArray()) {
        for (let i = 0; i < ends.length; i++) {
          const end = ends.get(i);
          if (end.isName() && end.asName() !== "None" && end.asName() !== "Butt") arrow = true;
        }
      }
      return arrow ? "arrow" : "line";
    }
    case "Polygon":
    case "PolyLine":
      return "shape";
    case "Text":
      return "note";
    case "FreeText":
      return "text box";
    case "Stamp": {
      const name = object.get("Name");
      const own: Record<string, string> = {
        PDFoctopusSignature: "signature",
        PDFoctopusInitials: "initials",
        PDFoctopusDate: "date",
        PDFoctopusImage: "image",
      };
      return (name.isName() && own[name.asName()]) || "stamp";
    }
    case "FileAttachment":
      return "attachment";
    case "Caret":
      return "insertion mark";
    case "Redact":
      return "redaction mark";
    default:
      return "annotation";
  }
}

/** A white box with no border, as the White-out tool makes. */
function isWhiteout(object: mupdf.PDFObject): boolean {
  const fill = object.get("IC");
  const border = object.get("C");
  const white =
    fill.isArray() &&
    fill.length === 3 &&
    [0, 1, 2].every((i) => fill.get(i).isNumber() && fill.get(i).asNumber() === 1);
  return white && (!border.isArray() || border.length === 0);
}

export function canResize(object: mupdf.PDFObject): boolean {
  return RESIZABLE.has(subtype(object));
}

export function canRecolor(object: mupdf.PDFObject): boolean {
  return RECOLORABLE.has(subtype(object)) && !isWhiteout(object);
}

export function canEditText(object: mupdf.PDFObject): boolean {
  return TEXT_TYPES.has(subtype(object));
}

/** The annotation's colour as RGB from 0 to 1, or null if it has none (or isn't RGB). */
export function readColor(object: mupdf.PDFObject): [number, number, number] | null {
  const c = object.get("C");
  if (!c.isArray()) return null;
  const v = Array.from({ length: c.length }, (_, i) => c.get(i).asNumber());
  if (v.length === 3) return [v[0] as number, v[1] as number, v[2] as number];
  if (v.length === 1) return [v[0] as number, v[0] as number, v[0] as number];
  return null;
}

/** The annotation's /Rect, normalised to [x0, y0, x1, y1] with x0 ≤ x1, y0 ≤ y1. */
export function readRect(object: mupdf.PDFObject): [number, number, number, number] {
  const r = object.get("Rect");
  const [a, b, c, d] = [0, 1, 2, 3].map((i) => r.get(i).asNumber()) as [
    number,
    number,
    number,
    number,
  ];
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

export function transformPoint(m: Matrix6, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

export function invert(m: Matrix6): Matrix6 {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0) throw new Error("The page has an unusable transform");
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** The axis-aligned box around a rectangle after a transform. */
export function transformRect(
  m: Matrix6,
  [x0, y0, x1, y1]: readonly number[],
): [number, number, number, number] {
  const points = [
    transformPoint(m, x0 as number, y0 as number),
    transformPoint(m, x1 as number, y0 as number),
    transformPoint(m, x0 as number, y1 as number),
    transformPoint(m, x1 as number, y1 as number),
  ];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function numberArray(pdf: mupdf.PDFDocument, values: readonly number[]): mupdf.PDFObject {
  const array = pdf.newArray();
  for (const v of values) array.push(v);
  return array;
}

/** Replace a list of x, y pairs with the same points shifted by (dx, dy). */
function shiftPairs(
  pdf: mupdf.PDFDocument,
  list: mupdf.PDFObject,
  dx: number,
  dy: number,
): mupdf.PDFObject {
  const values = Array.from({ length: list.length }, (_, i) => {
    const v = list.get(i);
    return v.isNumber() ? v.asNumber() + (i % 2 === 0 ? dx : dy) : 0;
  });
  return numberArray(pdf, values);
}

/**
 * Shift every coordinate of an annotation by (dx, dy) in PDF space. Its appearance is drawn
 * into /Rect, so it moves along with it and isn't redrawn: anything an annotation looks like,
 * even one MuPDF can't draw, moves unchanged.
 */
export function shiftAnnotation(
  pdf: mupdf.PDFDocument,
  object: mupdf.PDFObject,
  dx: number,
  dy: number,
): void {
  for (const key of POINT_KEYS) {
    const list = object.get(key);
    if (list.isArray()) object.put(key, shiftPairs(pdf, list, dx, dy));
  }
  const ink = object.get("InkList");
  if (ink.isArray()) {
    const strokes = pdf.newArray();
    for (let i = 0; i < ink.length; i++) {
      const stroke = ink.get(i);
      strokes.push(stroke.isArray() ? shiftPairs(pdf, stroke, dx, dy) : pdf.newArray());
    }
    object.put("InkList", strokes);
  }
}

export function putRect(
  pdf: mupdf.PDFDocument,
  object: mupdf.PDFObject,
  rect: readonly number[],
): void {
  object.put("Rect", numberArray(pdf, rect));
}

/**
 * A copy of a value held directly in a dictionary, so later changes to the original can't
 * reach it. Indirect objects are shared, not copied: an edit never changes those in place
 * (an appearance is replaced by a new stream, see `editAnnotation`).
 */
export function copyDirect(pdf: mupdf.PDFDocument, value: mupdf.PDFObject): mupdf.PDFObject {
  if (value.isIndirect()) return value;
  if (value.isArray()) {
    const copy = pdf.newArray();
    value.forEach((item) => {
      copy.push(copyDirect(pdf, item));
    });
    return copy;
  }
  if (value.isDictionary()) {
    const copy = pdf.newDictionary();
    value.forEach((item, key) => {
      copy.put(key, copyDirect(pdf, item));
    });
    return copy;
  }
  return value;
}

/** The editable entries of an annotation, copied; missing entries are recorded as null. */
export type Snapshot = Map<string, mupdf.PDFObject | null>;

export function snapshot(pdf: mupdf.PDFDocument, object: mupdf.PDFObject): Snapshot {
  const snap: Snapshot = new Map();
  for (const key of EDITABLE_KEYS) {
    const value = object.get(key);
    snap.set(key, value.isNull() ? null : copyDirect(pdf, value));
  }
  return snap;
}

export function restore(pdf: mupdf.PDFDocument, object: mupdf.PDFObject, snap: Snapshot): void {
  for (const [key, value] of snap) {
    if (value === null) object.delete(key);
    else object.put(key, copyDirect(pdf, value));
  }
}

/**
 * Put `value` into `array` at `index`, moving later items along. MuPDF arrays have no insert,
 * so this appends and shifts.
 */
export function insertAt(array: mupdf.PDFObject, index: number, value: mupdf.PDFObject): void {
  const at = Math.min(Math.max(0, index), array.length);
  if (at === array.length) {
    array.push(value);
    return;
  }
  array.push(array.get(array.length - 1));
  for (let i = array.length - 2; i > at; i--) array.put(i, array.get(i - 1));
  array.put(at, value);
}
