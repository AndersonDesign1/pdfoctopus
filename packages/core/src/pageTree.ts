// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Checking a page tree before pages are added, removed or moved. MuPDF trusts the tree when it
// changes it: the fuzzer found that inserting a page into a tree that lists a page whose
// object is missing never returns (the app would hang for good). MuPDF also keeps each /Count
// up to date by walking up through /Parent, so a /Parent chain that loops is refused too.
// Showing such a file is fine (MuPDF finds pages through /Kids, carefully), so only changing
// its pages is refused.

import type * as mupdf from "mupdf";

/** Most nodes a page tree may have for it to be checked (pages included). */
const MAX_NODES = 2_000_000;

/** Deepest a page can be in the tree; real files use a few levels. */
const MAX_DEPTH = 256;

export const DAMAGED_PAGE_TREE =
  "This file's list of pages is damaged, so pages can't be added, removed or moved in it.";

/**
 * Why this document's pages can't be changed safely, or null if they can. The whole tree is
 * checked (unless `wholeTree` is false, when it was checked before), and `pages`, the pages
 * about to change.
 */
export function pageTreeProblem(
  pdf: mupdf.PDFDocument,
  pages: readonly mupdf.PDFObject[] = [],
  wholeTree = true,
): string | null {
  const root = wholeTree ? pdf.getTrailer().get("Root").get("Pages") : null;
  /** Nodes whose /Parent chain is known to end. */
  const good = new Set<number>();
  const chainEnds = (node: mupdf.PDFObject): boolean => {
    const path: number[] = [];
    let current = node;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      if (!current.isIndirect()) {
        // A direct object can't be pointed back at, but its parent can.
        if (!current.isDictionary()) break;
      } else {
        const num = current.asIndirect();
        if (good.has(num)) break;
        if (path.includes(num)) return false;
        path.push(num);
      }
      const parent = current.get("Parent");
      if (!parent.isDictionary()) break;
      current = parent;
      if (depth === MAX_DEPTH) return false;
    }
    for (const num of path) good.add(num);
    return true;
  };

  // Every node reachable through /Kids, each once.
  const seen = new Set<number>();
  const stack: mupdf.PDFObject[] = root?.isDictionary() ? [root] : [];
  let nodes = 0;
  while (stack.length > 0) {
    const node = stack.pop() as mupdf.PDFObject;
    if (node.isIndirect()) {
      const num = node.asIndirect();
      if (seen.has(num)) continue;
      seen.add(num);
    }
    if (++nodes > MAX_NODES) return DAMAGED_PAGE_TREE;
    if (!chainEnds(node)) return DAMAGED_PAGE_TREE;
    const kids = node.get("Kids");
    if (kids.isArray()) {
      for (let i = 0; i < kids.length; i++) {
        const kid = kids.get(i);
        // A page that isn't there (its object is missing or isn't a dictionary): MuPDF never
        // finishes inserting a page next to one.
        if (!kid.isDictionary()) return DAMAGED_PAGE_TREE;
        stack.push(kid);
      }
    }
  }
  // And the pages being changed, however MuPDF found them.
  for (const page of pages) {
    if (!page.isDictionary() || !chainEnds(page)) return DAMAGED_PAGE_TREE;
  }
  return null;
}
