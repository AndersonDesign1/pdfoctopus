// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reading the signatures in a file that's opened, for the Signatures panel. For each signed
// signature field this reads the signature dictionary, checks its /ByteRange makes sense (it
// starts at 0, leaves out exactly the /Contents hex string and ends where a saved version of
// the file ends), and works out what was changed after it: the signed version (the file up to
// the end of the byte range) is opened on its own and compared object by object with the whole
// file. The cryptographic check (hashes and the signer's signature) is done by packages/sign.
//
// Files can be hostile, so everything is capped: the number of signatures, the size of a
// signature, the number of objects compared and the bytes of streams compared. When a limit
// is hit, or anything can't be read, the change is reported as "unknown", never as harmless.

import * as mupdf from "mupdf";
import type { ByteRange } from "./signature";

/** Signatures read from one file; later ones are left out. */
export const MAX_SIGNATURES = 50;
/** The largest signature (CMS, in bytes) that's read. */
export const MAX_CONTENTS = 1_048_576;
/** Files with more objects than this aren't compared object by object. */
export const MAX_OBJECTS = 300_000;
/** Stream bytes compared per signature, at most. */
const MAX_STREAM_BYTES = 256 * 1024 * 1024;
/** Form fields looked at, at most. */
const MAX_FIELDS = 20_000;

/**
 * What was changed after a signature, from least to most worrying:
 * - "none": nothing; the signature covers the whole file.
 * - "signatures": only more signatures were added.
 * - "form": form fields were filled in (and perhaps signatures added).
 * - "annotations": comments or mark-up were added, changed or removed.
 * - "other": anything else, such as pages or their content.
 * - "unknown": something was added, but it couldn't be worked out what.
 * The middle three are the kinds of change the PDF standard allows after signing; they still
 * change what the document shows, so they are reported, not hidden.
 */
export type ChangeLevel = "none" | "signatures" | "form" | "annotations" | "other" | "unknown";

const RANK: Record<ChangeLevel, number> = {
  none: 0,
  signatures: 1,
  form: 2,
  annotations: 3,
  other: 4,
  unknown: 5,
};

/** One signature as read from the file (before its cryptographic check). */
export interface SignatureReport {
  /** The signature field's full name. */
  field: string;
  /** The page its box is on (0-based), or null if it has none. */
  page: number | null;
  /** From the signature dictionary; any of them may be missing. */
  name?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** The signing time the signature dictionary claims (/M), in ms since 1970. */
  time?: number;
  filter?: string;
  subFilter?: string;
  /** The byte range as written, or null if it's missing or not four numbers. */
  byteRange: ByteRange | null;
  /** The signature (DER), read from the /Contents hex string; empty if it couldn't be. */
  contents: Uint8Array;
  /** Why the byte range or the signature can't be trusted, in plain words; empty if fine. */
  problems: string[];
  /** Which saved version of the file the signature ends (1-based), and how many there are. */
  revision: number;
  revisions: number;
  /** Whether the signature covers the whole file (nothing was added after it). */
  coversWholeFile: boolean;
  /** What was changed after the signature, and a few words about it. */
  changes: ChangeLevel;
  changeNotes: string[];
  /** How many pages the signed version had. */
  signedPages: number | null;
}

/** All the signatures in a file, with the file itself for the cryptographic check. */
export interface SignatureInspection {
  /** The file as it was opened (or as signed); null when it has no signatures. */
  file: Uint8Array | null;
  signatures: SignatureReport[];
  /** True if there were more signatures than are listed. */
  truncated: boolean;
  /** How many signatures weren't read (beyond MAX_SIGNATURES; at least this many). */
  skipped: number;
}

const LT = 0x3c;
const GT = 0x3e;

/** An object with its reference followed. A missing entry (MuPDF's shared null) stays null. */
function resolved(obj: mupdf.PDFObject): mupdf.PDFObject {
  return obj.isNull() ? obj : obj.resolve();
}

const latin1 = new TextDecoder("latin1");
/** The end of a saved version: "startxref", the offset, "%%EOF" and at most a line end. */
const REVISION_END = /startxref\s+\d+\s*%%EOF(?:\r\n|\r|\n)?$/;

/**
 * Whether a saved version of the file ends at `end`: the bytes just before it are "startxref",
 * a number and "%%EOF" (perhaps with a line end). A "%%EOF" anywhere else, such as inside a
 * string or stream, doesn't count.
 */
export function endsRevisionAt(bytes: Uint8Array, end: number): boolean {
  if (end < 5 || end > bytes.length) return false;
  return REVISION_END.test(latin1.decode(bytes.subarray(Math.max(0, end - 64), end)));
}

/**
 * Where the saved versions of the file end: just after each "%%EOF" that follows "startxref"
 * and a number. Only used to number the versions; at most 100,000 "%%EOF"s are looked at.
 */
export function revisionEnds(bytes: Uint8Array): number[] {
  const out: number[] = [];
  const marker = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF
  let seen = 0;
  for (let i = 0; i + 5 <= bytes.length && seen < 100_000; i++) {
    if (bytes[i] !== 0x25) continue;
    let k = 1;
    while (k < 5 && bytes[i + k] === marker[k]) k++;
    if (k < 5) continue;
    seen++;
    if (endsRevisionAt(bytes, i + 5)) out.push(i + 5);
  }
  return out;
}

function isHexDigit(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

function isWhite(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
}

function hexValue(c: number): number {
  if (c <= 0x39) return c - 0x30;
  if (c <= 0x46) return c - 0x41 + 10;
  return c - 0x61 + 10;
}

/** Decode a hex string's digits (between "<" and ">"), or null if it isn't one. */
export function decodeHex(bytes: Uint8Array, from: number, to: number): Uint8Array | null {
  const digits: number[] = [];
  for (let i = from; i < to; i++) {
    const c = bytes[i] as number;
    if (isHexDigit(c)) digits.push(hexValue(c));
    else if (!isWhite(c)) return null;
  }
  if (digits.length % 2) digits.push(0);
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = ((digits[2 * i] as number) << 4) | (digits[2 * i + 1] as number);
  }
  return out;
}

/** The length of the DER element at the start of `der` (tag, length and value), or null. */
export function derLength(der: Uint8Array): number | null {
  if (der.length < 2) return null;
  const first = der[1] as number;
  if (first < 0x80) return 2 + first <= der.length ? 2 + first : null;
  const n = first & 0x7f;
  if (n === 0 || n > 4 || der.length < 2 + n) return null;
  let length = 0;
  for (let i = 0; i < n; i++) length = length * 256 + (der[2 + i] as number);
  const total = 2 + n + length;
  return total <= der.length ? total : null;
}

/**
 * Check a byte range against the file: it must start at 0, leave out exactly one hex string
 * (the signature), and end where a saved version of the file ends. Returns the signature's
 * bytes and any problems.
 */
export function checkByteRange(
  bytes: Uint8Array,
  range: ByteRange,
): { contents: Uint8Array; problems: string[] } {
  const [a, aLength, b, bLength] = range;
  const problems: string[] = [];
  const none = new Uint8Array(0);
  if (!range.every((v) => Number.isSafeInteger(v) && v >= 0)) {
    return { contents: none, problems: ["Its byte range isn't valid."] };
  }
  if (a !== 0) problems.push("Its byte range doesn't start at the beginning of the file.");
  const end = b + bLength;
  if (aLength < 1 || b <= aLength || end > bytes.length) {
    problems.push("Its byte range doesn't fit the file.");
    return { contents: none, problems };
  }
  if (bytes[aLength] !== LT || bytes[b - 1] !== GT) {
    problems.push("Its byte range leaves out more than the signature.");
    return { contents: none, problems };
  }
  if (b - aLength - 2 > MAX_CONTENTS * 2) {
    problems.push("The signature is too large to check.");
    return { contents: none, problems };
  }
  const decoded = decodeHex(bytes, aLength + 1, b - 1);
  if (!decoded) {
    problems.push("Its byte range leaves out more than the signature.");
    return { contents: none, problems };
  }
  // BER with an indefinite length (0x80) is kept whole: its end isn't known until parsed.
  const indefinite = decoded[1] === 0x80;
  const length = indefinite ? decoded.length : derLength(decoded);
  if (decoded[0] !== 0x30 || length === null) {
    problems.push("The signature can't be read.");
    return { contents: none, problems };
  }
  if (!endsRevisionAt(bytes, end))
    problems.push("Its byte range doesn't end where a saved version ends.");
  return { contents: decoded.slice(0, length), problems };
}

/** A PDF date ("D:20261119143000Z", "D:20230104120000-05'00'") in ms since 1970. */
export function parsePdfDate(text: string): number | undefined {
  const m =
    /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:([Zz+-])(\d{2})?'?(\d{2})?'?)?/.exec(
      text.trim(),
    );
  if (!m) return undefined;
  const n = (s: string | undefined, d: number) => (s === undefined ? d : Number(s));
  let t = Date.UTC(n(m[1], 0), n(m[2], 1) - 1, n(m[3], 1), n(m[4], 0), n(m[5], 0), n(m[6], 0));
  if (m[7] === "+" || m[7] === "-") {
    const offset = (n(m[8], 0) * 60 + n(m[9], 0)) * 60_000;
    t += m[7] === "+" ? -offset : offset;
  }
  return Number.isNaN(t) ? undefined : t;
}

function text(obj: mupdf.PDFObject, key: string): string | undefined {
  const v = obj.get(key);
  if (v.isString()) return v.asString().slice(0, 500) || undefined;
  if (v.isName()) return v.asName().slice(0, 500) || undefined;
  return undefined;
}

interface SignedField {
  name: string;
  signature: mupdf.PDFObject;
  widget: mupdf.PDFObject;
}

/** Every field with a signature dictionary as its value, from the form's field tree. */
export function signedFields(pdf: mupdf.PDFDocument): SignedField[] {
  const form = pdf.getTrailer().get("Root").get("AcroForm");
  if (!form.isDictionary()) return [];
  const out: SignedField[] = [];
  const seen = new Set<number>();
  const seenValues = new Set<number>();
  let visited = 0;
  const walk = (node: mupdf.PDFObject, prefix: string, ft: string, depth: number) => {
    if (depth > 32 || visited++ > MAX_FIELDS) return;
    if (node.isIndirect()) {
      const num = node.asIndirect();
      if (seen.has(num)) return;
      seen.add(num);
    }
    const dict = resolved(node);
    if (!dict.isDictionary()) return;
    const t = dict.get("T");
    const name = t.isString() ? (prefix ? `${prefix}.${t.asString()}` : t.asString()) : prefix;
    const type = dict.get("FT").isName() ? dict.get("FT").asName() : ft;
    const value = dict.get("V");
    if (type === "Sig" && resolved(value).isDictionary()) {
      const num = value.isIndirect() ? value.asIndirect() : -1;
      if (num < 0 || !seenValues.has(num)) {
        if (num >= 0) seenValues.add(num);
        const kids = dict.get("Kids");
        const widget = kids.isArray() && kids.length > 0 ? resolved(kids.get(0)) : dict;
        out.push({ name: name || "(unnamed)", signature: resolved(value), widget });
      }
      return;
    }
    const kids = dict.get("Kids");
    if (kids.isArray()) {
      for (let i = 0; i < kids.length; i++) walk(kids.get(i), name, type, depth + 1);
    }
  };
  const fields = form.get("Fields");
  if (fields.isArray()) for (let i = 0; i < fields.length; i++) walk(fields.get(i), "", "", 0);
  return out;
}

/** Page object numbers to page indexes (for the first 10,000 pages). */
function pageNumbers(pdf: mupdf.PDFDocument): Map<number, number> {
  const out = new Map<number, number>();
  const count = Math.min(pdf.countPages(), 10_000);
  for (let i = 0; i < count; i++) {
    const page = pdf.findPage(i);
    if (page.isIndirect()) out.set(page.asIndirect(), i);
  }
  return out;
}

function pageOf(widget: mupdf.PDFObject, pages: Map<number, number>): number | null {
  const p = widget.get("P");
  if (p.isIndirect()) return pages.get(p.asIndirect()) ?? null;
  return null;
}

function readByteRange(sig: mupdf.PDFObject): ByteRange | null {
  const r = sig.get("ByteRange");
  if (!r.isArray() || r.length !== 4) return null;
  const values = [0, 1, 2, 3].map((i) => r.get(i));
  if (!values.every((v) => v.isNumber())) return null;
  return values.map((v) => v.asNumber()) as unknown as ByteRange;
}

/** The keys whose values differ between two dictionaries. */
function changedKeys(a: mupdf.PDFObject, b: mupdf.PDFObject): Set<string> {
  const before = new Map<string, string>();
  a.forEach((v, k) => {
    before.set(String(k), v.toString(true));
  });
  const out = new Set<string>();
  b.forEach((v, k) => {
    const key = String(k);
    if (before.get(key) !== v.toString(true)) out.add(key);
    before.delete(key);
  });
  for (const key of before.keys()) out.add(key);
  return out;
}

function only(keys: Set<string>, allowed: string[]): boolean {
  for (const k of keys) if (!allowed.includes(k)) return false;
  return true;
}

function nameOf(obj: mupdf.PDFObject, key: string): string | null {
  const v = obj.get(key);
  return v.isName() ? v.asName() : null;
}

/** The field type of a widget or field, looking at its parents too. */
function fieldType(obj: mupdf.PDFObject): string | null {
  let node = obj;
  for (let depth = 0; depth < 32 && node.isDictionary(); depth++) {
    const ft = nameOf(node, "FT");
    if (ft) return ft;
    node = resolved(node.get("Parent"));
  }
  return null;
}

const ANNOTATION_TYPES = new Set([
  "Text",
  "Link",
  "FreeText",
  "Line",
  "Square",
  "Circle",
  "Polygon",
  "PolyLine",
  "Highlight",
  "Underline",
  "Squiggly",
  "StrikeOut",
  "Stamp",
  "Caret",
  "Ink",
  "Popup",
  "FileAttachment",
  "Sound",
  "Redact",
  "Widget",
]);

/** A stream's stated /Length, or 0 if it doesn't say. */
function statedLength(stream: mupdf.PDFObject): number {
  const length = resolved(stream.get("Length"));
  return length.isNumber() ? Math.max(0, length.asNumber()) : 0;
}

/**
 * Compare two streams' bytes, charging them to the budget first (by their stated lengths,
 * then by what was really read). "over" when the budget runs out: they aren't compared.
 */
export function sameStream(
  a: mupdf.PDFObject,
  b: mupdf.PDFObject,
  budget: { bytes: number },
): "same" | "different" | "over" {
  const stated = statedLength(a) + statedLength(b);
  budget.bytes -= stated;
  if (budget.bytes < 0) return "over";
  const x = a.readRawStream().asUint8Array();
  const y = b.readRawStream().asUint8Array();
  // A /Length that understates the stream doesn't get round the budget.
  budget.bytes -= Math.max(0, x.length + y.length - stated);
  if (budget.bytes < 0) return "over";
  if (x.length !== y.length) return "different";
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return "different";
  return "same";
}

/** Appearance streams of the annotations in a document: object number -> is a form field's. */
function appearanceStreams(pdf: mupdf.PDFDocument): Map<number, boolean> {
  const out = new Map<number, boolean>();
  const count = Math.min(pdf.countPages(), 10_000);
  const add = (v: mupdf.PDFObject, widget: boolean) => {
    if (v.isIndirect()) out.set(v.asIndirect(), widget);
  };
  for (let i = 0; i < count && out.size < 100_000; i++) {
    const annots = resolved(pdf.findPage(i).get("Annots"));
    if (!annots.isArray()) continue;
    for (let k = 0; k < annots.length && k < 10_000; k++) {
      const annot = resolved(annots.get(k));
      if (!annot.isDictionary()) continue;
      const widget = nameOf(annot, "Subtype") === "Widget";
      const ap = resolved(annot.get("AP"));
      if (!ap.isDictionary()) continue;
      for (const key of ["N", "D", "R"]) {
        const entry = ap.get(key);
        add(entry, widget);
        const states = resolved(entry);
        // MuPDF only knows a stream through its reference, so ask the entry, not `states`.
        if (states.isDictionary() && !entry.isStream()) {
          states.forEach((v) => {
            add(v, widget);
          });
        }
      }
    }
  }
  return out;
}

interface Change {
  level: ChangeLevel;
  note: string;
}

/**
 * What changed between the signed version of a file and the whole file, by comparing every
 * object. Objects only reachable from changed ones (a new annotation's appearance, say) are
 * judged by what refers to them.
 */
export function compareVersions(
  signed: mupdf.PDFDocument,
  current: mupdf.PDFDocument,
  streamBudget = MAX_STREAM_BYTES,
): { level: ChangeLevel; notes: string[] } {
  const oldCount = signed.countObjects();
  const newCount = current.countObjects();
  if (newCount > MAX_OBJECTS || oldCount > MAX_OBJECTS) {
    return { level: "unknown", notes: ["The file is too large to compare."] };
  }
  const ref = (pdf: mupdf.PDFDocument, key: string) => {
    const v = pdf.getTrailer().get(key);
    return v.isIndirect() ? v.asIndirect() : -1;
  };
  const rootNum = ref(current, "Root");
  if (rootNum !== ref(signed, "Root")) {
    return { level: "other", notes: ["The document's structure was replaced."] };
  }
  const infoNum = ref(current, "Info");
  const formRef = current.getTrailer().get("Root").get("AcroForm");
  const formNum = formRef.isIndirect() ? formRef.asIndirect() : -1;
  const pages = pageNumbers(current);
  let streams: Map<number, boolean> | null = null;
  const budget = { bytes: streamBudget };

  const classify = (
    num: number,
    a: mupdf.PDFObject | null,
    b: mupdf.PDFObject | null,
    isStream: boolean,
  ): Change | null => {
    if (!b) return { level: "other", note: "Parts of the document were removed." };
    const type = nameOf(b, "Type");
    const subtype = nameOf(b, "Subtype");
    // A cross-reference or object stream the update added. An object that was in the signed
    // version is never let off this way, whatever its /Type now says: replacing a page's
    // content with a stream marked /Type /XRef must still count as a change.
    if (!a && (type === "XRef" || type === "ObjStm")) return null;
    if (num === infoNum) return null;
    if (num === rootNum) {
      const keys = a ? changedKeys(a, b) : new Set(["*"]);
      if (only(keys, ["AcroForm", "DSS"])) return { level: "signatures", note: "" };
      return { level: "other", note: "The document's settings were changed." };
    }
    if (num === formNum && b.isDictionary() && !isStream) {
      const keys = a ? changedKeys(a, b) : new Set(["Fields", "SigFlags"]);
      if (only(keys, ["Fields", "SigFlags"])) return { level: "signatures", note: "" };
      if (only(keys, ["Fields", "SigFlags", "NeedAppearances", "DR", "DA"])) {
        return { level: "form", note: "Form fields were filled in." };
      }
      return { level: "other", note: "The form was changed." };
    }
    if (type === "Page") {
      if (!a) return { level: "other", note: "A page was added." };
      const keys = changedKeys(a, b);
      const page = pages.get(num);
      const where = page === undefined ? "A page" : `Page ${page + 1}`;
      if (!only(keys, ["Annots"])) return { level: "other", note: `${where} was changed.` };
      // Annotations added to the page are judged on their own; removed ones count here.
      const refs = (o: mupdf.PDFObject) => {
        const list = resolved(o.get("Annots"));
        const set = new Set<string>();
        if (list.isArray()) for (let i = 0; i < list.length; i++) set.add(list.get(i).toString());
        return set;
      };
      const now = refs(b);
      for (const r of refs(a)) {
        if (!now.has(r)) return { level: "annotations", note: "Comments or mark-up were removed." };
      }
      return null;
    }
    if (type === "Sig" || (b.isDictionary() && !b.get("ByteRange").isNull())) {
      if (a) return { level: "other", note: "An earlier signature's details were changed." };
      return { level: "signatures", note: "Another signature was added." };
    }
    if (type === "Annot" || (subtype && ANNOTATION_TYPES.has(subtype) && !isStream)) {
      if (subtype !== "Widget") {
        return {
          level: "annotations",
          note: a ? "Comments or mark-up were changed." : "Comments or mark-up were added.",
        };
      }
      const ft = fieldType(b);
      if (!a) {
        if (ft === "Sig") return { level: "signatures", note: "Another signature was added." };
        return { level: "other", note: "A form field was added." };
      }
      const keys = changedKeys(a, b);
      if (ft === "Sig" && a.get("V").isNull() && only(keys, ["V", "AP", "AS", "F", "MK"])) {
        return { level: "signatures", note: "Another signature was added." };
      }
      if (ft !== "Sig" && only(keys, ["V", "AP", "AS", "MK"])) {
        return { level: "form", note: "Form fields were filled in." };
      }
      return { level: "other", note: "A form field was changed." };
    }
    if (b.isDictionary() && !isStream && (!b.get("FT").isNull() || !b.get("T").isNull())) {
      // A form field that isn't also a widget.
      const ft = fieldType(b);
      if (!a) {
        if (ft === "Sig") return { level: "signatures", note: "Another signature was added." };
        return { level: "other", note: "A form field was added." };
      }
      const keys = changedKeys(a, b);
      if (only(keys, ["Kids"]) && ft === "Sig") return { level: "signatures", note: "" };
      if (only(keys, ["V", "Kids"])) return { level: "form", note: "Form fields were filled in." };
      return { level: "other", note: "A form field was changed." };
    }
    // Anything new not covered above (fonts, pictures, appearances) can only be seen through
    // a changed object, which is judged on its own.
    if (!a) return null;
    if (isStream) {
      streams ??= appearanceStreams(signed);
      const widget = streams.get(num);
      if (widget === true) return { level: "form", note: "Form fields were filled in." };
      if (widget === false)
        return { level: "annotations", note: "Comments or mark-up were changed." };
    }
    return { level: "other", note: "The content of the document was changed." };
  };

  let level = "none" as ChangeLevel;
  const notes: string[] = [];
  const record = (change: Change | null) => {
    if (!change) return;
    if (RANK[change.level] > RANK[level]) level = change.level;
    if (change.note && !notes.includes(change.note) && notes.length < 6) notes.push(change.note);
  };
  const last = Math.max(oldCount, newCount);
  for (let num = 1; num < last; num++) {
    // The references are kept: MuPDF only treats an object as a stream through its reference.
    const beforeRef = num < oldCount ? signed.newIndirect(num) : null;
    const afterRef = num < newCount ? current.newIndirect(num) : null;
    const before = beforeRef?.resolve() ?? null;
    const after = afterRef?.resolve() ?? null;
    const a = before && !before.isNull() ? before : null;
    const b = after && !after.isNull() ? after : null;
    if (!a && !b) continue;
    const isStream = !!(b && afterRef?.isStream());
    if (a && b && beforeRef && afterRef) {
      if (a.toString(true) === b.toString(true) && beforeRef.isStream() === isStream) {
        if (!isStream) continue;
        const same = sameStream(beforeRef, afterRef, budget);
        if (same === "over") {
          return { level: "unknown", notes: ["The file is too large to compare."] };
        }
        if (same === "same") continue;
      }
    }
    record(classify(num, a, b, isStream));
    if (level === "other" && notes.length >= 6) break;
  }
  return { level, notes };
}

/** The signature's dictionary, read and checked (no comparison of versions yet). */
function readSignature(
  bytes: Uint8Array,
  field: SignedField,
  pages: Map<number, number>,
  eofs: number[],
  encrypted: boolean,
): SignatureReport {
  const sig = field.signature;
  const range = readByteRange(sig);
  const report: SignatureReport = {
    field: field.name,
    page: pageOf(field.widget, pages),
    name: text(sig, "Name"),
    reason: text(sig, "Reason"),
    location: text(sig, "Location"),
    contactInfo: text(sig, "ContactInfo"),
    time: (() => {
      const m = text(sig, "M");
      return m ? parsePdfDate(m) : undefined;
    })(),
    filter: text(sig, "Filter"),
    subFilter: text(sig, "SubFilter"),
    byteRange: range,
    contents: new Uint8Array(0),
    problems: [],
    revision: eofs.length,
    revisions: Math.max(eofs.length, 1),
    coversWholeFile: false,
    changes: "unknown",
    changeNotes: [],
    signedPages: null,
  };
  if (!range) {
    report.problems.push("It has no valid byte range.");
    return report;
  }
  const checked = checkByteRange(bytes, range);
  report.contents = checked.contents;
  report.problems.push(...checked.problems);
  if (report.contents.length && !encrypted) {
    // The hex string left out of the byte range must be this signature's /Contents.
    const contents = sig.get("Contents");
    const own = contents.isString() ? contents.asByteString() : new Uint8Array(0);
    const n = report.contents.length;
    let same = own.length >= n;
    for (let i = 0; same && i < n; i++) same = own[i] === report.contents[i];
    if (!same) report.problems.push("Its byte range doesn't point at its own signature.");
  }
  const end = range[2] + range[3];
  report.coversWholeFile = end === bytes.length;
  const index = eofs.findIndex((e) => e <= end && end - e <= 2);
  report.revision = index >= 0 ? index + 1 : eofs.filter((e) => e <= end).length;
  return report;
}

/**
 * Read every signature in a file. `current` is the file opened as it is (not with unsaved
 * changes). Signatures are listed in the order they were added.
 */
export function inspectSignatures(
  bytes: Uint8Array,
  current: mupdf.PDFDocument,
): SignatureInspection {
  const fields = signedFields(current);
  if (fields.length === 0) return { file: null, signatures: [], truncated: false, skipped: 0 };
  const skipped = Math.max(0, fields.length - MAX_SIGNATURES);
  const truncated = skipped > 0;
  const eofs = revisionEnds(bytes);
  const pages = pageNumbers(current);
  const method = current.getMetaData("encryption");
  const encrypted = !!method && method !== "None";
  const reports = fields
    .slice(0, MAX_SIGNATURES)
    .map((f) => readSignature(bytes, f, pages, eofs, encrypted));
  const end = (r: SignatureReport) => (r.byteRange ? r.byteRange[2] + r.byteRange[3] : 0);
  reports.sort((x, y) => end(x) - end(y));

  // Compare each signed version with the whole file. Signatures ending at the same place
  // share the result.
  const results = new Map<number, { level: ChangeLevel; notes: string[]; pages: number | null }>();
  for (const report of reports) {
    if (!report.byteRange || report.contents.length === 0) continue;
    if (report.coversWholeFile) {
      report.changes = "none";
      report.signedPages = current.countPages();
      continue;
    }
    const at = end(report);
    let result = results.get(at);
    if (!result) {
      result = compareAt(bytes, at, current);
      results.set(at, result);
    }
    report.changes = result.level;
    report.changeNotes = result.notes;
    report.signedPages = result.pages;
  }
  return { file: bytes, signatures: reports, truncated, skipped };
}

function compareAt(
  bytes: Uint8Array,
  end: number,
  current: mupdf.PDFDocument,
): { level: ChangeLevel; notes: string[]; pages: number | null } {
  let signed: mupdf.Document | null = null;
  try {
    signed = mupdf.Document.openDocument(bytes.slice(0, end), "application/pdf");
    const pdf = signed.asPDF();
    if (!pdf || signed.needsPassword()) {
      return { level: "unknown", notes: ["The signed version can't be read."], pages: null };
    }
    if (pdf.wasRepaired()) {
      return { level: "unknown", notes: ["The signed version is damaged."], pages: null };
    }
    const pages = pdf.countPages();
    const result = compareVersions(pdf, current);
    if (result.level === "none") {
      // Bytes were added but nothing in the document changed (a re-save, say).
      return { level: "none", notes: ["The file was saved again without changes."], pages };
    }
    if (pages !== current.countPages()) {
      result.notes.unshift(`It had ${pages} pages; the file now has ${current.countPages()}.`);
    }
    return { ...result, pages };
  } catch {
    return { level: "unknown", notes: ["The signed version can't be compared."], pages: null };
  } finally {
    signed?.destroy();
  }
}
