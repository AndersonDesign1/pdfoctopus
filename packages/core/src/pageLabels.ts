// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Keeping page labels ("i, ii, iii, 1, 2, 3") right when pages are deleted, moved or inserted.
// A PDF's labels are ranges keyed by page index (the /PageLabels number tree), so once pages
// move the ranges point at the wrong pages. Here each page keeps the range (section) it was
// in, and each section is numbered again in order: delete "ii" from "i, ii, iii, 1, 2" and the
// result is "i, ii, 1, 2". A section can be written as several ranges (after a move, "1" at
// the front and "2, 3" at the back): a range that carries on the count of an earlier range in
// the same style counts as the same section. Pages that are new to the document carry on the section of the
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

/** A label section: its style, prefix and first number. */
interface Section {
  style?: string;
  prefix?: string;
  first: number;
}

/** Most nodes a label tree walk visits: a crafted file can't make an edit hang. */
const MAX_TREE_NODES = 100_000;

/** What labels a document had before a change, by page object, to apply afterwards. */
export interface LabelPlan {
  /**
   * A copy of the label tree before the change, for undo. A copy, because MuPDF edits the
   * tree in place when it deletes or inserts pages.
   */
  before: mupdf.PDFObject;
  sections: Section[];
  /** Page object number → index of its section in `sections`. */
  sectionOf: Map<number, number>;
}

function root(pdf: mupdf.PDFDocument): mupdf.PDFObject {
  return pdf.getTrailer().get("Root");
}

/** Counts the nodes a walk visits, and stops it when there are too many. */
class Budget {
  private left = MAX_TREE_NODES;
  spend(): void {
    if (--this.left < 0) throw new Error("This file's page labels are too complex to update");
  }
}

/**
 * A deep copy of an object. Each referenced object is copied once, as a new object, and
 * shared where it's referred to again; a loop becomes null; and the whole copy is bounded.
 */
function copyObject(
  pdf: mupdf.PDFDocument,
  object: mupdf.PDFObject,
  budget = new Budget(),
  copies = new Map<number, mupdf.PDFObject>(),
  path = new Set<number>(),
): mupdf.PDFObject {
  budget.spend();
  if (object.isIndirect()) {
    const num = object.asIndirect();
    const done = copies.get(num);
    if (done) return done;
    if (path.has(num) || path.size > 32) return pdf.newNull();
    path.add(num);
    try {
      // Kept as an object of its own, so copying the copy (for each undo) shares it too.
      const copy = pdf.addObject(copyObject(pdf, object.resolve(), budget, copies, path));
      copies.set(num, copy);
      return copy;
    } finally {
      path.delete(num);
    }
  }
  if (object.isArray()) {
    const array = pdf.newArray();
    for (let i = 0; i < object.length; i++) {
      array.push(copyObject(pdf, object.get(i), budget, copies, path));
    }
    return array;
  }
  if (object.isDictionary()) {
    const dict = pdf.newDictionary();
    object.forEach((value, key) => {
      dict.put(String(key), copyObject(pdf, value, budget, copies, path));
    });
    return dict;
  }
  // Numbers, names, strings and booleans are values, not shared containers.
  return object;
}

/**
 * The number tree's pairs, from /Nums and any /Kids. Each node is read once, however often
 * it's referred to, and the walk is bounded.
 */
function treeEntries(
  node: mupdf.PDFObject,
  budget = new Budget(),
  seen = new Set<number>(),
  depth = 0,
): [number, mupdf.PDFObject][] {
  budget.spend();
  if (node.isIndirect()) {
    const num = node.asIndirect();
    if (seen.has(num)) return [];
    seen.add(num);
  }
  if (depth > 32 || !node.isDictionary()) return [];
  const out: [number, mupdf.PDFObject][] = [];
  const nums = node.get("Nums");
  if (nums.isArray()) {
    for (let i = 0; i + 1 < nums.length; i += 2) {
      budget.spend();
      const key = nums.get(i);
      const value = nums.get(i + 1);
      if (key.isNumber() && value.isDictionary()) out.push([key.asNumber(), value]);
    }
  }
  const kids = node.get("Kids");
  if (kids.isArray()) {
    for (let i = 0; i < kids.length; i++) {
      out.push(...treeEntries(kids.get(i), budget, seen, depth + 1));
    }
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

  // Ranges become sections. A range that carries on the count of the latest section in the
  // same style and prefix (as when a move split one) joins it; others start a new section.
  const sections: Section[] = [];
  const nextNumber: number[] = [];
  const latest = new Map<string, number>();
  const sectionOfRange = ranges.map((range, r) => {
    const end = r + 1 < ranges.length ? (ranges[r + 1] as LabelRange).start : pageCount;
    const key = `${range.style ?? ""}\u0000${range.prefix ?? ""}`;
    let section = latest.get(key);
    if (section === undefined || nextNumber[section] !== range.first) {
      section = sections.length;
      sections.push({ style: range.style, prefix: range.prefix, first: range.first });
      nextNumber.push(range.first);
      latest.set(key, section);
    }
    nextNumber[section] = (nextNumber[section] as number) + (end - range.start);
    return section;
  });

  const sectionOf = new Map<number, number>();
  let r = 0;
  for (let i = 0; i < pageCount; i++) {
    while (r + 1 < ranges.length && (ranges[r + 1] as LabelRange).start <= i) r++;
    const page = pdf.findPage(i);
    if (page.isIndirect()) sectionOf.set(page.asIndirect(), sectionOfRange[r] as number);
  }
  return { before: copyObject(pdf, before), sections, sectionOf };
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

  const next = plan.sections.map((section) => section.first);
  const nums = pdf.newArray();
  let current = -1;
  for (let i = 0; i < pageCount; i++) {
    const section = resolved[i] as number;
    if (section !== current) {
      const range = plan.sections[section] as Section;
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
