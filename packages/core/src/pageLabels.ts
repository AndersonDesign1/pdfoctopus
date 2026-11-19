// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Keeping page labels ("i, ii, iii, 1, 2, 3") right when pages are deleted, moved or inserted.
// A PDF's labels are ranges keyed by page index (the /PageLabels number tree), so once pages
// move the ranges point at the wrong pages. Here each page keeps the range (section) it was
// in, and each section is numbered again in order: delete "ii" from "i, ii, iii, 1, 2" and the
// result is "i, ii, 1, 2". Pages that are new to the document carry on the section of the
// page before them (or after them, at the start). A document without labels is kept without
// them.

import type * as mupdf from "mupdf";

/** One range of the labels: from page `start` on, style, prefix and first number. */
interface LabelRange {
  start: number;
  /** "D", "R", "r", "A" or "a"; none for labels that are only the prefix. */
  style?: string;
  prefix?: string;
  /** The first number of the range (1 when not given). */
  first: number;
}

/** What labels a document had before a change, by page object, to apply afterwards. */
export interface LabelPlan {
  /**
   * A copy of the label tree before the change, for undo. A copy, because MuPDF edits the
   * tree in place when it deletes or inserts pages.
   */
  before: mupdf.PDFObject;
  ranges: LabelRange[];
  /** Page object number → index of its range in `ranges`. */
  sectionOf: Map<number, number>;
}

function root(pdf: mupdf.PDFDocument): mupdf.PDFObject {
  return pdf.getTrailer().get("Root");
}

/** A deep, direct copy of an object (references followed, to a limited depth). */
function copyObject(pdf: mupdf.PDFDocument, object: mupdf.PDFObject, depth = 0): mupdf.PDFObject {
  if (depth > 32) return pdf.newNull();
  const o = object.resolve();
  if (o.isArray()) {
    const array = pdf.newArray();
    for (let i = 0; i < o.length; i++) array.push(copyObject(pdf, o.get(i), depth + 1));
    return array;
  }
  if (o.isDictionary()) {
    const dict = pdf.newDictionary();
    o.forEach((value, key) => {
      dict.put(String(key), copyObject(pdf, value, depth + 1));
    });
    return dict;
  }
  // Numbers, names, strings and booleans are values, not shared containers.
  return o;
}

/** The number tree's pairs, from /Nums and any /Kids (depth-limited against loops). */
function treeEntries(node: mupdf.PDFObject, depth = 0): [number, mupdf.PDFObject][] {
  if (depth > 32 || !node.isDictionary()) return [];
  const out: [number, mupdf.PDFObject][] = [];
  const nums = node.get("Nums");
  if (nums.isArray()) {
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const key = nums.get(i);
      const value = nums.get(i + 1);
      if (key.isNumber() && value.isDictionary()) out.push([key.asNumber(), value]);
    }
  }
  const kids = node.get("Kids");
  if (kids.isArray()) {
    for (let i = 0; i < kids.length; i++) out.push(...treeEntries(kids.get(i), depth + 1));
  }
  return out;
}

function readRanges(tree: mupdf.PDFObject, pageCount: number): LabelRange[] {
  const ranges: LabelRange[] = [];
  for (const [start, dict] of treeEntries(tree)) {
    if (!Number.isInteger(start) || start < 0 || start >= pageCount) continue;
    const style = dict.get("S");
    const prefix = dict.get("P");
    const first = dict.get("St");
    ranges.push({
      start,
      style: style.isName() ? style.asName() : undefined,
      prefix: prefix.isString() ? prefix.asString() : undefined,
      first: first.isNumber() && first.asNumber() >= 1 ? Math.floor(first.asNumber()) : 1,
    });
  }
  ranges.sort((a, b) => a.start - b.start);
  // Pages before the first range (the tree should start at 0, but doesn't always) are shown
  // as plain numbers, as MuPDF shows them.
  if (ranges.length && (ranges[0] as LabelRange).start > 0) {
    ranges.unshift({ start: 0, style: "D", first: 1 });
  }
  return ranges.filter((r, i) => i === 0 || r.start !== (ranges[i - 1] as LabelRange).start);
}

/**
 * Note each page's label section before a change to the pages. Null when the document has no
 * labels (then nothing needs doing).
 */
export function planLabels(pdf: mupdf.PDFDocument): LabelPlan | null {
  const before = root(pdf).get("PageLabels");
  if (!before.isDictionary()) return null;
  const pageCount = pdf.countPages();
  const ranges = readRanges(before, pageCount);
  if (ranges.length === 0) return null;
  const sectionOf = new Map<number, number>();
  let section = 0;
  for (let i = 0; i < pageCount; i++) {
    while (section + 1 < ranges.length && (ranges[section + 1] as LabelRange).start <= i) section++;
    const page = pdf.findPage(i);
    if (page.isIndirect()) sectionOf.set(page.asIndirect(), section);
  }
  return { before: copyObject(pdf, before), ranges, sectionOf };
}

/** Write the labels again for the pages as they are now, each in its old section. */
export function applyLabels(pdf: mupdf.PDFDocument, plan: LabelPlan): void {
  const pageCount = pdf.countPages();
  const sections: (number | undefined)[] = [];
  for (let i = 0; i < pageCount; i++) {
    const page = pdf.findPage(i);
    sections.push(page.isIndirect() ? plan.sectionOf.get(page.asIndirect()) : undefined);
  }
  // New pages carry on the section before them; at the start, the first known one after.
  const firstKnown = sections.find((s) => s !== undefined) ?? 0;
  let previous = firstKnown;
  const resolved = sections.map((s) => {
    previous = s ?? previous;
    return previous;
  });

  const next = plan.ranges.map((r) => r.first);
  const nums = pdf.newArray();
  let current = -1;
  for (let i = 0; i < pageCount; i++) {
    const section = resolved[i] as number;
    if (section !== current) {
      const range = plan.ranges[section] as LabelRange;
      const dict = pdf.newDictionary();
      dict.put("Type", pdf.newName("PageLabel"));
      if (range.style) dict.put("S", pdf.newName(range.style));
      if (range.prefix !== undefined) dict.put("P", pdf.newString(range.prefix));
      const first = next[section] as number;
      if (first !== 1) dict.put("St", first);
      nums.push(i);
      nums.push(dict);
      current = section;
    }
    next[section] = (next[section] as number) + 1;
  }
  const tree = pdf.newDictionary();
  tree.put("Nums", nums);
  root(pdf).put("PageLabels", pdf.addObject(tree));
}

/**
 * For a document without labels: take away any MuPDF added while moving or inserting pages
 * (it adds a tree that numbers the pages wrongly, e.g. "1, 1, 2").
 */
export function removeLabels(pdf: mupdf.PDFDocument): void {
  const catalog = root(pdf);
  if (!catalog.get("PageLabels").isNull()) catalog.delete("PageLabels");
}

/** Put back the labels a plan was made from (for undo), as a fresh copy each time. */
export function restoreLabels(pdf: mupdf.PDFDocument, plan: LabelPlan): void {
  root(pdf).put("PageLabels", pdf.addObject(copyObject(pdf, plan.before)));
}
