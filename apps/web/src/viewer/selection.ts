// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Page selection in the thumbnail sidebar, and the maths for dragging pages to a new place.
// Pure functions, so they can be unit-tested. Pages are 0-based and selections are kept
// sorted and without duplicates.

export interface Selection {
  pages: number[];
  /** Where a Shift-click range starts from. */
  anchor: number | null;
}

export const EMPTY_SELECTION: Selection = { pages: [], anchor: null };

/**
 * Apply a click on a thumbnail. A plain click selects just that page; Ctrl/Cmd toggles it;
 * Shift selects the range from the anchor (added to the selection with Ctrl/Cmd too).
 */
export function clickSelection(
  current: Selection,
  index: number,
  { toggle = false, range = false }: { toggle?: boolean; range?: boolean } = {},
): Selection {
  if (range && current.anchor !== null) {
    const from = Math.min(current.anchor, index);
    const to = Math.max(current.anchor, index);
    const span = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    return {
      pages: normalise(toggle ? [...current.pages, ...span] : span),
      anchor: current.anchor,
    };
  }
  if (toggle) {
    const has = current.pages.includes(index);
    return {
      pages: has ? current.pages.filter((p) => p !== index) : normalise([...current.pages, index]),
      anchor: index,
    };
  }
  return { pages: [index], anchor: index };
}

/** Select every page. */
export function selectAll(pageCount: number): Selection {
  return { pages: Array.from({ length: pageCount }, (_, i) => i), anchor: 0 };
}

/** Select a run of pages, e.g. the pages just inserted or moved. */
export function selectRun(start: number, count: number): Selection {
  return { pages: Array.from({ length: count }, (_, i) => start + i), anchor: start };
}

/** Drop pages that no longer exist after the document shrank. */
export function clampSelection(selection: Selection, pageCount: number): Selection {
  const pages = selection.pages.filter((p) => p < pageCount);
  const anchor =
    selection.anchor !== null && selection.anchor < pageCount ? selection.anchor : null;
  return { pages, anchor };
}

/** The pages a page tool acts on: the selection, or the current page when nothing is selected. */
export function targetPages(selection: Selection, currentPage: number): number[] {
  return selection.pages.length ? selection.pages : [currentPage];
}

/**
 * Turn a drop position into the engine's move target. `dropBefore` is the index of the page
 * the dragged pages were dropped in front of (pageCount for the very end). The engine wants
 * the position counted after the moved pages are taken out. Returns null for a drop that
 * would change nothing.
 */
export function moveTarget(pages: readonly number[], dropBefore: number): number | null {
  const sorted = normalise(pages);
  const to = dropBefore - sorted.filter((p) => p < dropBefore).length;
  return sorted.every((p, i) => p === to + i) ? null : to;
}

/**
 * Which gap a pointer is over while dragging: before page i (0..pageCount). `tops` and
 * `heights` are the thumbnails' positions; the pointer counts as before a page while it's in
 * that page's top half.
 */
export function dropIndexAt(
  y: number,
  tops: readonly number[],
  heights: readonly number[],
): number {
  for (let i = 0; i < tops.length; i++) {
    if (y < (tops[i] as number) + (heights[i] as number) / 2) return i;
  }
  return tops.length;
}

function normalise(pages: readonly number[]): number[] {
  return [...new Set(pages)].sort((a, b) => a - b);
}
