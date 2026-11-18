// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The geometry behind selecting, moving and resizing annotations that are already on a page.
// Boxes are [left, top, right, bottom] in points from the page's top-left corner as shown,
// the same as the engine's AnnotationInfo.rect. No DOM here, so it's unit-tested.

import type { AnnotationInfo, PagePoint } from "@pdfoctopus/core";

export type Box = [number, number, number, number];
type PageSize = { width: number; height: number };

/** How far outside an annotation's box a click still selects it, in points. */
export const HIT_SLOP = 3;

/** Smallest an annotation can be resized to, in points, each way. */
export const MIN_SIZE = 6;

/**
 * The annotation under a point: the topmost one (the last drawn) whose box, grown by `slop`,
 * contains it. Null when there's none.
 */
export function hitTest(
  annotations: readonly AnnotationInfo[],
  [x, y]: PagePoint,
  slop = HIT_SLOP,
): AnnotationInfo | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i] as AnnotationInfo;
    const [x0, y0, x1, y1] = a.rect;
    if (x >= x0 - slop && x <= x1 + slop && y >= y0 - slop && y <= y1 + slop) return a;
  }
  return null;
}

/**
 * Where a box's start edge can go along one side of the page: inside the page, or, for a box
 * bigger than the page (some apps make those), anywhere it still covers the whole page.
 */
function clampEdge(start: number, size: number, pageSize: number): number {
  return size <= pageSize
    ? Math.max(0, Math.min(start, pageSize - size))
    : Math.min(0, Math.max(start, pageSize - size));
}

/** A box moved by (dx, dy), kept on the page as `clampEdge` describes. */
export function moveBox([x0, y0, x1, y1]: Box, dx: number, dy: number, page: PageSize): Box {
  const w = x1 - x0;
  const h = y1 - y0;
  const left = clampEdge(x0 + dx, w, page.width);
  const top = clampEdge(y0 + dy, h, page.height);
  return [left, top, left + w, top + h];
}

/**
 * A box resized by dragging its bottom-right corner to `to`, keeping its top-left corner, on
 * the page and at least MIN_SIZE each way. With `keepAspect` (signatures and other stamps,
 * which would look squashed otherwise) the width decides and the height follows.
 */
export function resizeBox(
  [x0, y0, x1, y1]: Box,
  to: PagePoint,
  page: PageSize,
  keepAspect: boolean,
): Box {
  const maxW = page.width - x0;
  const maxH = page.height - y0;
  let w = Math.min(maxW, Math.max(MIN_SIZE, to[0] - x0));
  let h = Math.min(maxH, Math.max(MIN_SIZE, to[1] - y0));
  if (keepAspect) {
    const aspect = (x1 - x0) / (y1 - y0) || 1;
    const minW = aspect >= 1 ? MIN_SIZE * aspect : MIN_SIZE;
    w = Math.min(maxW, maxH * aspect, Math.max(minW, w));
    h = w / aspect;
  }
  return [x0, y0, x0 + w, y0 + h];
}

/** Whether resizing should keep an annotation's proportions: images and stamps. */
export function keepsAspect(annotation: Pick<AnnotationInfo, "label">): boolean {
  return ["signature", "initials", "date", "image", "stamp"].includes(annotation.label);
}

/** How far an arrow key moves the selection, in points: 1, or 10 with Shift. */
export function arrowDelta(key: string, shift: boolean): [number, number] | null {
  const step = shift ? 10 : 1;
  switch (key) {
    case "ArrowLeft":
      return [-step, 0];
    case "ArrowRight":
      return [step, 0];
    case "ArrowUp":
      return [0, -step];
    case "ArrowDown":
      return [0, step];
    default:
      return null;
  }
}

/** Whether two boxes are the same, give or take rounding. */
export function sameBox(a: Box, b: Box): boolean {
  return a.every((v, i) => Math.abs(v - (b[i] as number)) < 0.01);
}
