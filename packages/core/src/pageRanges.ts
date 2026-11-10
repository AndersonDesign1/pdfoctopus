// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Page-range helpers for split and extract. Pure functions with no MuPDF import, so the UI
// can use them cheaply. Pages are 0-based here; the text the user types is 1-based.

/**
 * Parse a list of page ranges as typed by a user, such as "1-3, 5, 8-" (1-based, inclusive).
 * "8-" means page 8 to the end and "-3" means pages 1 to 3. Returns one group of 0-based page
 * indices per range, in the order typed. Throws an Error with a readable message on bad input.
 */
export function parsePageRanges(text: string, pageCount: number): number[][] {
  const parts = text
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) throw new Error("Enter at least one page or range, such as 1-3");
  return parts.map((part) => {
    const match = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part);
    let first: number;
    let last: number;
    if (match) {
      first = match[1] ? Number(match[1]) : 1;
      last = match[2] ? Number(match[2]) : pageCount;
    } else if (/^\d+$/.test(part)) {
      first = last = Number(part);
    } else {
      throw new Error(`"${part}" isn't a page or a range`);
    }
    if (first < 1 || last > pageCount) {
      throw new Error(`"${part}" is outside the document (pages 1 to ${pageCount})`);
    }
    if (first > last) throw new Error(`"${part}" runs backwards`);
    return range(first - 1, last);
  });
}

/** Split into groups of `n` pages (the last group may be shorter). */
export function splitEvery(n: number, pageCount: number): number[][] {
  if (!Number.isInteger(n) || n < 1) throw new Error("The number of pages must be 1 or more");
  const groups: number[][] = [];
  for (let start = 0; start < pageCount; start += n) {
    groups.push(range(start, Math.min(start + n, pageCount)));
  }
  return groups;
}

/** One group per page. */
export function splitSingle(pageCount: number): number[][] {
  return splitEvery(1, pageCount);
}

/** Describe a group of 0-based pages for a file name, e.g. "pages-1-3" or "page-5". */
export function describePages(pages: readonly number[]): string {
  if (pages.length === 0) return "pages";
  const first = (pages[0] as number) + 1;
  const last = (pages[pages.length - 1] as number) + 1;
  const contiguous = pages.every((p, i) => p === (pages[0] as number) + i);
  if (pages.length === 1) return `page-${first}`;
  return contiguous ? `pages-${first}-${last}` : `pages-${first}-etc`;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}
