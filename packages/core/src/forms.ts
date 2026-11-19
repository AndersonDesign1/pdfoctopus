// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Helpers for filling in a PDF's form (AcroForm): what kind each field is, which objects hold
// its value and appearance (a field and its widgets, the boxes on pages), and snapshots of
// those so a change can be undone.

import type * as mupdf from "mupdf";
import { copyDirect } from "./annotationObjects";

export type FieldKind =
  | "text"
  | "checkbox"
  | "radio"
  | "combobox"
  | "listbox"
  | "signature"
  | "button";

/** What PDFoctopus calls each of MuPDF's field types. */
export function fieldKind(widget: mupdf.PDFWidget): FieldKind {
  switch (widget.getFieldType()) {
    case "text":
      return "text";
    case "checkbox":
      return "checkbox";
    case "radiobutton":
      return "radio";
    case "combobox":
      return "combobox";
    case "listbox":
      return "listbox";
    case "signature":
      return "signature";
    default:
      return "button";
  }
}

/** Kinds of field that can be filled in. */
export function isFillable(kind: FieldKind): boolean {
  return kind !== "signature" && kind !== "button";
}

/**
 * The field a widget belongs to: the nearest object, going up through /Parent, that has a
 * name of its own (/T). A widget is often its own field; a field with several boxes (a group
 * of radio buttons, a name repeated on every page) is their parent. The field type (/FT) can't
 * be used for this: it's inherited, and some files repeat it on every box.
 */
export function fieldOf(widget: mupdf.PDFObject): mupdf.PDFObject {
  let node = widget;
  for (let depth = 0; depth < 32; depth++) {
    if (!node.get("T").isNull()) return node;
    const parent = node.get("Parent");
    if (parent.isNull()) break;
    node = parent;
  }
  return node;
}

/** A field and every widget (box) it has: the objects a change to its value can touch. */
export function fieldObjects(field: mupdf.PDFObject): mupdf.PDFObject[] {
  const out: mupdf.PDFObject[] = [field];
  const walk = (node: mupdf.PDFObject, depth: number) => {
    const kids = node.get("Kids");
    if (!kids.isArray() || depth > 32) return;
    for (let i = 0; i < kids.length; i++) {
      const kid = kids.get(i);
      out.push(kid);
      walk(kid, depth + 1);
    }
  };
  walk(field, 0);
  return out;
}

/** Entries a change of value can touch: the value, the state shown, and the appearance. */
const VALUE_KEYS = ["V", "AS", "AP"] as const;

export type FieldSnapshot = {
  object: mupdf.PDFObject;
  entries: Map<string, mupdf.PDFObject | null>;
}[];

export function snapshotField(pdf: mupdf.PDFDocument, objects: mupdf.PDFObject[]): FieldSnapshot {
  return objects.map((object) => {
    const entries = new Map<string, mupdf.PDFObject | null>();
    for (const key of VALUE_KEYS) {
      const v = object.get(key);
      entries.set(key, v.isNull() ? null : copyDirect(pdf, v));
    }
    return { object, entries };
  });
}

export function restoreField(pdf: mupdf.PDFDocument, snapshot: FieldSnapshot): void {
  for (const { object, entries } of snapshot) {
    for (const [key, v] of entries) {
      if (v === null) object.delete(key);
      else object.put(key, copyDirect(pdf, v));
    }
  }
}

/** Whether a checkbox or radio button widget is on (its shown state isn't /Off). */
export function isOn(widget: mupdf.PDFObject): boolean {
  const state = widget.get("AS");
  return state.isName() && state.asName() !== "Off";
}

/** The document's AcroForm dictionary, or null if it has none. */
export function acroForm(pdf: mupdf.PDFDocument): mupdf.PDFObject | null {
  const form = pdf.getTrailer().get("Root").get("AcroForm");
  return form.isDictionary() ? form : null;
}
