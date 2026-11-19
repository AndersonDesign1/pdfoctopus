// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Building forms: new fields (their dictionaries are made by hand, as MuPDF's JavaScript API
// can't create widgets), and the checks and snapshots that changing or deleting a field needs.

import type * as mupdf from "mupdf";
import { copyContainer, copyDirect } from "./annotationObjects";

/** Kinds of field that can be added. A date is a text field formatted as a date. */
export type NewFieldKind = "text" | "checkbox" | "radio" | "combobox" | "date" | "signature";

/** A field to add, as `addField` takes it. */
export interface NewField {
  page: number;
  kind: NewFieldKind;
  /** Where on the page, in points from its top-left corner as shown: [x0, y0, x1, y1]. */
  rect: readonly number[];
  /** The field's name; for a radio button, the name of its group (joined if it exists). */
  name: string;
  required?: boolean;
  /** Text (or a date, or one of the options) the field starts with and resets to. */
  defaultValue?: string;
  /** A dropdown's options. */
  options?: readonly string[];
  /** A radio button's value: what the group's value is when it's chosen. */
  value?: string;
  /** A text field that takes several lines. */
  multiline?: boolean;
}

/** Changes to a field's properties, as `updateField` takes them. */
export interface FieldChanges {
  name?: string;
  required?: boolean;
  defaultValue?: string;
  options?: readonly string[];
}

export const MAX_FIELD_NAME = 100;
export const MAX_OPTIONS = 200;
export const MAX_OPTION_TEXT = 200;
/** The smallest box a field can have, in points. */
export const MIN_FIELD_SIZE = 6;

const FF_REQUIRED = 1 << 1;
const FF_MULTILINE = 1 << 12;
const FF_NO_TOGGLE_TO_OFF = 1 << 14;
const FF_RADIO = 1 << 15;
const FF_COMBO = 1 << 17;
const DATE_FORMAT = "yyyy-mm-dd";

/** A field name, trimmed; throws if it can't be used. */
export function checkFieldName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("The field needs a name");
  if (trimmed.length > MAX_FIELD_NAME) {
    throw new Error(`A field name can be ${MAX_FIELD_NAME} characters at most`);
  }
  // A dot separates the parts of a field's full name ("address.city").
  if (trimmed.includes(".")) throw new Error("A field name can't contain a dot");
  return trimmed;
}

/** A dropdown's options, checked: at least one, none empty, no two the same. */
export function checkOptions(options: readonly string[] | undefined): string[] {
  const list = (options ?? []).map((o) => o.trim()).filter((o) => o.length > 0);
  if (list.length === 0) throw new Error("A dropdown needs at least one option");
  if (list.length > MAX_OPTIONS)
    throw new Error(`A dropdown can have ${MAX_OPTIONS} options at most`);
  if (list.some((o) => o.length > MAX_OPTION_TEXT)) {
    throw new Error(`An option can be ${MAX_OPTION_TEXT} characters at most`);
  }
  if (new Set(list).size !== list.length) throw new Error("Two of the options are the same");
  return list;
}

/** The full names of every field in the form ("address.city"), with the object for each. */
export function fieldNames(form: mupdf.PDFObject | null): Map<string, mupdf.PDFObject> {
  const names = new Map<string, mupdf.PDFObject>();
  if (!form) return names;
  const walk = (nodes: mupdf.PDFObject, prefix: string, depth: number) => {
    if (!nodes.isArray() || depth > 32) return;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes.get(i);
      const t = node.get("T");
      const name = t.isString() ? (prefix ? `${prefix}.${t.asString()}` : t.asString()) : prefix;
      if (t.isString()) names.set(name, node);
      walk(node.get("Kids"), name, depth + 1);
    }
  };
  walk(form.get("Fields"), "", 0);
  return names;
}

/** The full name a field would have with a new partial name (/T). */
export function renamed(field: mupdf.PDFObject, partial: string): string {
  const parts = [partial];
  let node = field.get("Parent");
  for (let depth = 0; !node.isNull() && depth < 32; depth++) {
    const t = node.get("T");
    if (t.isString()) parts.unshift(t.asString());
    node = node.get("Parent");
  }
  return parts.join(".");
}

/** One dictionary entry as it was, to put back on undo (or redo). */
export type EntrySnapshot = {
  object: mupdf.PDFObject;
  key: string;
  value: mupdf.PDFObject | null;
}[];

/**
 * Snapshot dictionary entries. An array that's changed in place (a page's /Annots, the form's
 * /Fields, a group's /Kids) is copied even when it's an indirect object, so the copy keeps the
 * old contents.
 */
export function snapshotEntries(
  pdf: mupdf.PDFDocument,
  entries: readonly [mupdf.PDFObject, string][],
): EntrySnapshot {
  return entries.map(([object, key]) => {
    const value = object.get(key);
    if (value.isNull()) return { object, key, value: null };
    const resolved = value.resolve();
    return {
      object,
      key,
      value: resolved.isArray() ? copyContainer(pdf, value) : copyDirect(pdf, value),
    };
  });
}

export function restoreEntries(pdf: mupdf.PDFDocument, snapshot: EntrySnapshot): void {
  for (const { object, key, value } of snapshot) {
    if (value === null) object.delete(key);
    else object.put(key, value.isArray() ? copyDirect(pdf, value) : value);
  }
}

/** Remove an object from an array, by identity. */
export function removeFrom(array: mupdf.PDFObject, object: mupdf.PDFObject): boolean {
  if (!array.isArray()) return false;
  const id = object.asIndirect();
  for (let i = array.length - 1; i >= 0; i--) {
    if (array.get(i).asIndirect() === id) {
      array.delete(i);
      return true;
    }
  }
  return false;
}

/** The standard font forms use (Helvetica, as /Helv), added to the form's resources. */
function ensureHelvetica(pdf: mupdf.PDFDocument, form: mupdf.PDFObject): void {
  let dr = form.get("DR");
  if (!dr.isDictionary()) {
    dr = pdf.newDictionary();
    form.put("DR", dr);
  }
  let fonts = dr.get("Font");
  if (!fonts.isDictionary()) {
    fonts = pdf.newDictionary();
    dr.put("Font", fonts);
  }
  if (!fonts.get("Helv").isNull()) return;
  const helv = pdf.newDictionary();
  helv.put("Type", pdf.newName("Font"));
  helv.put("Subtype", pdf.newName("Type1"));
  helv.put("BaseFont", pdf.newName("Helvetica"));
  helv.put("Encoding", pdf.newName("WinAnsiEncoding"));
  fonts.put("Helv", pdf.addObject(helv));
}

/**
 * The entries adding a field can change, to snapshot first: the page's /Annots, the root's
 * /AcroForm, and the form's /Fields, resources and XFA copy.
 */
export function entriesForAdd(
  pdf: mupdf.PDFDocument,
  page: mupdf.PDFObject,
  group: mupdf.PDFObject | null,
): [mupdf.PDFObject, string][] {
  const root = pdf.getTrailer().get("Root");
  const form = root.get("AcroForm");
  // The root's link to the form is in every snapshot, so undo and redo both put it right
  // whether or not the file had a form before.
  const entries: [mupdf.PDFObject, string][] = [
    [page, "Annots"],
    [root, "AcroForm"],
  ];
  // Joining a group can make it required.
  if (group) entries.push([group, "Kids"], [group, "Ff"]);
  if (form.isDictionary()) {
    entries.push([form, "Fields"], [form, "DA"], [form, "DR"], [form, "XFA"]);
    // A direct /DR is copied whole by its snapshot; an indirect one (or font dictionary) is
    // shared, so the entries Helvetica is added to are snapshot themselves.
    const dr = form.get("DR");
    if (dr.isIndirect()) entries.push([dr, "Font"]);
    const fonts = dr.isDictionary() ? dr.get("Font") : null;
    if (fonts?.isIndirect()) entries.push([fonts, "Helv"]);
  }
  return entries;
}

/** The document's form, made if it has none, with the font new fields use. */
export function ensureForm(pdf: mupdf.PDFDocument): mupdf.PDFObject {
  const root = pdf.getTrailer().get("Root");
  let form = root.get("AcroForm");
  if (!form.isDictionary()) {
    form = pdf.addObject(pdf.newDictionary());
    form.put("Fields", pdf.newArray());
    root.put("AcroForm", form);
  }
  if (!form.get("Fields").isArray()) form.put("Fields", pdf.newArray());
  if (!form.get("DA").isString()) form.put("DA", pdf.newString("/Helv 0 Tf 0 g"));
  ensureHelvetica(pdf, form);
  return form;
}

/** A radio button group at the top of the form with this name, if there is one. */
export function radioGroup(form: mupdf.PDFObject | null, name: string): mupdf.PDFObject | null {
  const fields = form?.get("Fields");
  if (!fields?.isArray()) return null;
  for (let i = 0; i < fields.length; i++) {
    const node = fields.get(i);
    const t = node.get("T");
    if (!t.isString() || t.asString() !== name) continue;
    const ff = node.get("Ff");
    const flags = ff.isNumber() ? ff.asNumber() : 0;
    const ft = node.get("FT");
    return ft.isName() && ft.asName() === "Btn" && (flags & FF_RADIO) !== 0 ? node : null;
  }
  return null;
}

/** The values (on states) of a radio group's buttons. */
export function radioValues(group: mupdf.PDFObject): string[] {
  const values: string[] = [];
  const kids = group.get("Kids");
  if (!kids.isArray()) return values;
  for (let i = 0; i < kids.length; i++) {
    const n = kids.get(i).get("AP").get("N");
    if (!n.isDictionary()) continue;
    n.forEach((_v, key) => {
      if (String(key) !== "Off") values.push(String(key));
    });
  }
  return values;
}

function numbers(pdf: mupdf.PDFDocument, values: readonly number[]): mupdf.PDFObject {
  const array = pdf.newArray();
  for (const v of values) array.push(v);
  return array;
}

/** A JavaScript action, for the date format scripts. */
function script(pdf: mupdf.PDFDocument, js: string): mupdf.PDFObject {
  const action = pdf.newDictionary();
  action.put("S", pdf.newName("JavaScript"));
  action.put("JS", pdf.newString(js));
  return action;
}

/**
 * Make a new field's widget (the box on the page) and, for a radio button that starts a group,
 * the group. Nothing is attached to the page or form yet. `rect` is in PDF coordinates.
 * Returns the widget and the object that goes into /Fields (or null to join `group`).
 */
export function buildField(
  pdf: mupdf.PDFDocument,
  page: mupdf.PDFObject,
  spec: NewField,
  name: string,
  rect: readonly number[],
  group: mupdf.PDFObject | null,
): { widget: mupdf.PDFObject; field: mupdf.PDFObject | null } {
  const widget = pdf.addObject(pdf.newDictionary());
  widget.put("Type", pdf.newName("Annot"));
  widget.put("Subtype", pdf.newName("Widget"));
  widget.put("Rect", numbers(pdf, rect));
  widget.put("F", 4); // print
  widget.put("P", page);
  // A thin dark grey border and a white background, so the field shows where it is.
  const mk = pdf.newDictionary();
  mk.put("BC", numbers(pdf, [0.4, 0.4, 0.4]));
  if (spec.kind !== "signature") mk.put("BG", numbers(pdf, [1, 1, 1]));
  widget.put("MK", mk);
  const required = spec.required ? FF_REQUIRED : 0;

  if (spec.kind === "radio") {
    const value = checkRadioValue(spec.value);
    widget.put("AS", pdf.newName("Off"));
    mk.put("CA", pdf.newString("l")); // a dot
    // MuPDF draws a radio button's appearance for the states it finds here.
    const n = pdf.newDictionary();
    n.put(value, pdf.addStream("", pdf.newDictionary()));
    n.put("Off", pdf.addStream("", pdf.newDictionary()));
    const ap = pdf.newDictionary();
    ap.put("N", n);
    widget.put("AP", ap);
    let parent = group;
    if (parent && spec.required) {
      const ff = parent.get("Ff");
      parent.put("Ff", (ff.isNumber() ? ff.asNumber() : 0) | FF_REQUIRED);
    }
    let field: mupdf.PDFObject | null = null;
    if (!parent) {
      parent = pdf.addObject(pdf.newDictionary());
      parent.put("FT", pdf.newName("Btn"));
      parent.put("T", pdf.newString(name));
      parent.put("Ff", FF_RADIO | FF_NO_TOGGLE_TO_OFF | required);
      parent.put("V", pdf.newName("Off"));
      parent.put("Kids", pdf.newArray());
      field = parent;
    }
    widget.put("Parent", parent);
    parent.get("Kids").push(widget);
    return { widget, field };
  }

  widget.put("T", pdf.newString(name));
  switch (spec.kind) {
    case "text":
    case "date": {
      widget.put("FT", pdf.newName("Tx"));
      widget.put("DA", pdf.newString("/Helv 0 Tf 0 g"));
      widget.put("Ff", required | (spec.multiline && spec.kind === "text" ? FF_MULTILINE : 0));
      if (spec.kind === "date") {
        const aa = pdf.newDictionary();
        aa.put("F", script(pdf, `AFDate_FormatEx("${DATE_FORMAT}");`));
        aa.put("K", script(pdf, `AFDate_KeystrokeEx("${DATE_FORMAT}");`));
        widget.put("AA", aa);
      }
      break;
    }
    case "checkbox": {
      widget.put("FT", pdf.newName("Btn"));
      widget.put("Ff", required);
      widget.put("V", pdf.newName("Off"));
      widget.put("AS", pdf.newName("Off"));
      mk.put("CA", pdf.newString("4")); // a tick
      break;
    }
    case "combobox": {
      widget.put("FT", pdf.newName("Ch"));
      widget.put("DA", pdf.newString("/Helv 0 Tf 0 g"));
      widget.put("Ff", FF_COMBO | required);
      const opt = pdf.newArray();
      for (const o of checkOptions(spec.options)) opt.push(pdf.newString(o));
      widget.put("Opt", opt);
      break;
    }
    case "signature": {
      widget.put("FT", pdf.newName("Sig"));
      widget.put("Ff", required);
      break;
    }
  }
  return { widget, field: widget };
}

export const FIELD_FLAGS = { required: FF_REQUIRED } as const;

/** The date format new date fields use, as a hint for whoever fills them in. */
export const NEW_DATE_FORMAT = DATE_FORMAT;

/** A PDF name for a radio button's value. */
export function checkRadioValue(value: string | undefined): string {
  const v = (value ?? "").trim() || "Choice1";
  if (v === "Off") throw new Error("A radio button's value can't be \"Off\"");
  if (v.length > MAX_OPTION_TEXT) {
    throw new Error(`A radio button's value can be ${MAX_OPTION_TEXT} characters at most`);
  }
  return v;
}
