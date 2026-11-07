// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure layout maths for the page view: where each page sits at a given zoom, which pages are
// on screen, and what scale "fit width" / "fit page" mean. Kept free of React and the DOM so
// it can be unit-tested and reused by the thumbnail list.

export interface Size {
  width: number;
  height: number;
}

/** CSS pixels per PDF point at 100% zoom (a 96 dpi screen showing 72-point-per-inch pages). */
export const CSS_PX_PER_PT = 96 / 72;

/** Zoom limits: 10% to 800% of actual size. */
export const MIN_SCALE = 0.1 * CSS_PX_PER_PT;
export const MAX_SCALE = 8 * CSS_PX_PER_PT;

/** Zoom levels (as fractions of 100%) the zoom-in/zoom-out buttons step through. */
export const ZOOM_STEPS = [
  0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8,
];

export type ZoomMode = "fit-width" | "fit-page" | "custom";

export interface Layout {
  /** CSS pixels per PDF point. */
  scale: number;
  tops: number[];
  widths: number[];
  heights: number[];
  /** Height of the whole scrollable column, including padding. */
  totalHeight: number;
  /** Width of the widest page plus padding. */
  totalWidth: number;
}

export interface LayoutOptions {
  /** Space between pages, in CSS pixels. */
  gap: number;
  /** Space around the column of pages, in CSS pixels. */
  padding: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = { gap: 16, padding: 16 };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Stack pages vertically at `scale` CSS pixels per point. */
export function computeLayout(
  pages: readonly Size[],
  scale: number,
  { gap, padding }: LayoutOptions = DEFAULT_LAYOUT,
): Layout {
  const tops: number[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  let y = padding;
  let maxWidth = 0;
  for (const page of pages) {
    const width = Math.round(page.width * scale);
    const height = Math.round(page.height * scale);
    tops.push(y);
    widths.push(width);
    heights.push(height);
    y += height + gap;
    maxWidth = Math.max(maxWidth, width);
  }
  const totalHeight = pages.length ? y - gap + padding : 2 * padding;
  return { scale, tops, widths, heights, totalHeight, totalWidth: maxWidth + 2 * padding };
}

/** Index of the last page whose top is at or above `y` (0 if `y` is above the first page). */
export function pageAtOffset(layout: Layout, y: number): number {
  const { tops } = layout;
  let lo = 0;
  let hi = tops.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((tops[mid] as number) <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Pages that overlap the band [scrollTop, scrollTop + viewportHeight]. Empty: last < first. */
export function visibleRange(
  layout: Layout,
  scrollTop: number,
  viewportHeight: number,
): { first: number; last: number } {
  const count = layout.tops.length;
  if (count === 0) return { first: 0, last: -1 };
  let first = pageAtOffset(layout, scrollTop);
  // The page found may end above the viewport (we're in the gap below it).
  if ((layout.tops[first] as number) + (layout.heights[first] as number) < scrollTop) {
    first = Math.min(first + 1, count - 1);
  }
  const last = pageAtOffset(layout, scrollTop + viewportHeight);
  return { first, last: Math.max(first, last) };
}

/**
 * The page the reader is looking at: the topmost visible page that shows enough of itself,
 * meaning at least half of the page or enough to fill half the view, whichever is less.
 * Small pages count as soon as they're mostly visible, so "go to page N" (which puts N at
 * the top) reports N even when several pages fit on screen. A big page counts while it
 * fills much of the view, not just when a sliver of it remains at the top.
 */
export function currentPage(layout: Layout, scrollTop: number, viewportHeight: number): number {
  const { first, last } = visibleRange(layout, scrollTop, viewportHeight);
  if (last < first) return 0;
  for (let i = first; i <= last; i++) {
    const top = layout.tops[i] as number;
    const height = layout.heights[i] as number;
    const visible = Math.min(top + height, scrollTop + viewportHeight) - Math.max(top, scrollTop);
    if (visible >= Math.min(height, viewportHeight) / 2) return i;
  }
  return last;
}

/** Left edge of a page in the column (pages are centred). */
export function pageLeft(layout: Layout, index: number, viewportWidth: number): number {
  const contentWidth = Math.max(layout.totalWidth, viewportWidth);
  return (contentWidth - (layout.widths[index] ?? 0)) / 2;
}

/**
 * A point of the document and where it is shown in the viewport. A point on a page is a
 * fraction of the page's size; a point outside it (the gaps and padding, which don't scale)
 * is the nearest page edge plus a fixed offset in CSS pixels.
 */
export interface Anchor {
  page: number;
  fracX: number;
  fracY: number;
  offsetX: number;
  offsetY: number;
  viewportX: number;
  viewportY: number;
}

/** Split a position along one axis into a fraction of the page plus a fixed overhang. */
function splitAxis(pos: number, start: number, size: number): [frac: number, offset: number] {
  if (pos < start) return [0, pos - start];
  if (pos > start + size) return [1, pos - (start + size)];
  return [(pos - start) / size, 0];
}

/** The point of the document shown at (viewportX, viewportY) for this scroll position. */
export function anchorAt(
  layout: Layout,
  scroll: { top: number; left: number },
  viewportWidth: number,
  viewportX: number,
  viewportY: number,
): Anchor | null {
  if (layout.tops.length === 0) return null;
  const y = scroll.top + viewportY;
  const page = pageAtOffset(layout, y);
  const x = scroll.left + viewportX;
  const [fracX, offsetX] = splitAxis(
    x,
    pageLeft(layout, page, viewportWidth),
    layout.widths[page] as number,
  );
  const [fracY, offsetY] = splitAxis(
    y,
    layout.tops[page] as number,
    layout.heights[page] as number,
  );
  return { page, fracX, fracY, offsetX, offsetY, viewportX, viewportY };
}

/** The scroll position that shows the anchored point at the same place in the viewport. */
export function scrollForAnchor(
  layout: Layout,
  anchor: Anchor,
  viewportWidth: number,
): { top: number; left: number } {
  const page = Math.min(anchor.page, layout.tops.length - 1);
  return {
    top:
      (layout.tops[page] as number) +
      anchor.fracY * (layout.heights[page] as number) +
      anchor.offsetY -
      anchor.viewportY,
    left:
      pageLeft(layout, page, viewportWidth) +
      anchor.fracX * (layout.widths[page] as number) +
      anchor.offsetX -
      anchor.viewportX,
  };
}

/** The scale that makes a page fit the viewport, in CSS pixels per point. */
export function fitScale(
  mode: Exclude<ZoomMode, "custom">,
  page: Size,
  viewport: Size,
  { padding }: LayoutOptions = DEFAULT_LAYOUT,
): number {
  const availableWidth = Math.max(1, viewport.width - 2 * padding);
  const availableHeight = Math.max(1, viewport.height - 2 * padding);
  const byWidth = availableWidth / page.width;
  if (mode === "fit-width") return clampScale(byWidth);
  return clampScale(Math.min(byWidth, availableHeight / page.height));
}

/** Zoom as a percentage of actual size (100% = a printed page held at arm's length). */
export function scaleToPercent(scale: number): number {
  return Math.round((scale / CSS_PX_PER_PT) * 100);
}

export function percentToScale(percent: number): number {
  return clampScale((percent / 100) * CSS_PX_PER_PT);
}

/** The next zoom step above (direction 1) or below (direction -1) the current scale. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  const zoom = scale / CSS_PX_PER_PT;
  // Small enough that any zoom just below a step still goes to that step, large enough to
  // treat a step we're already at (up to floating-point error) as reached.
  const epsilon = 1e-4;
  const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  const next = steps.find((s) => (direction > 0 ? s > zoom + epsilon : s < zoom - epsilon));
  return clampScale((next ?? zoom) * CSS_PX_PER_PT);
}

/**
 * The resolution to render a page at: its on-screen size times the device pixel ratio,
 * capped so one page bitmap never exceeds `maxPixels` (deep zoom on a large page would
 * otherwise need hundreds of megabytes).
 */
export function renderScale(
  page: Size,
  scale: number,
  devicePixelRatio: number,
  maxPixels = 16_000_000,
): number {
  const wanted = scale * devicePixelRatio;
  const pixels = page.width * page.height * wanted * wanted;
  const capped = pixels > maxPixels ? Math.sqrt(maxPixels / (page.width * page.height)) : wanted;
  // Round so tiny scroll-driven changes don't produce a new render each time, but never to
  // zero for a huge page.
  return Math.max(0.01, Math.round(capped * 100) / 100);
}
