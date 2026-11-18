// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers for signatures: smoothing pen strokes, trimming and cleaning up images, and
// sizing and keeping a stamp on its page. No DOM here, so all of it is unit-tested.

/** A point of a pen stroke, in pixels. `pressure` is 0 to 1 (0.5 for a mouse). */
export interface InkPoint {
  x: number;
  y: number;
  pressure: number;
}

/** One quadratic curve of a smoothed stroke. */
export interface CurveSegment {
  from: { x: number; y: number };
  control: { x: number; y: number };
  to: { x: number; y: number };
  /** Pen pressure at the segment's control point, for its line width. */
  pressure: number;
}

const mid = (a: InkPoint, b: InkPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Smooth a stroke: each recorded point becomes the control point of a curve running between
 * the midpoints of its neighbouring segments. The curve passes through the first and last
 * points, so a stroke still starts and ends where the pen did. A single point (a dot) gives
 * one zero-length segment, which a round line cap draws as a dot.
 */
export function smoothStroke(points: readonly InkPoint[]): CurveSegment[] {
  const first = points[0];
  if (!first) return [];
  if (points.length === 1) {
    return [{ from: first, control: first, to: first, pressure: first.pressure }];
  }
  if (points.length === 2) {
    const b = points[1] as InkPoint;
    return [
      { from: first, control: mid(first, b), to: b, pressure: (first.pressure + b.pressure) / 2 },
    ];
  }
  const segments: CurveSegment[] = [];
  let from: { x: number; y: number } = first;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i] as InkPoint;
    const next = points[i + 1] as InkPoint;
    const to = i === points.length - 2 ? next : mid(p, next);
    segments.push({ from, control: p, to, pressure: p.pressure });
    from = to;
  }
  return segments;
}

/** Line width for a pressure: a mouse (0.5) draws at `base`, a pen varies around it. */
export function strokeWidth(base: number, pressure: number): number {
  return base * (0.6 + 0.8 * Math.min(1, Math.max(0, pressure)));
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The smallest box holding every pixel more opaque than `threshold`, or null if none is. */
export function contentBounds(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 8,
): Box | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if ((rgba[row + x * 4 + 3] as number) > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Grow a box by `margin` pixels each way, staying inside the image. */
export function padBox(box: Box, margin: number, width: number, height: number): Box {
  const x = Math.max(0, box.x - margin);
  const y = Math.max(0, box.y - margin);
  return {
    x,
    y,
    width: Math.min(width, box.x + box.width + margin) - x,
    height: Math.min(height, box.y + box.height + margin) - y,
  };
}

/** The share (0 to 1) of pixels that are mostly see-through. */
export function transparentShare(rgba: Uint8ClampedArray): number {
  const total = rgba.length / 4;
  if (total === 0) return 0;
  let clear = 0;
  for (let i = 3; i < rgba.length; i += 4) if ((rgba[i] as number) < 128) clear++;
  return clear / total;
}

const luminance = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Make the paper behind a photographed or scanned signature transparent, in place.
 *
 * The paper's colour is taken from the image's border (the median, so a pen stroke that
 * touches the edge doesn't skew it). Pixels close to it become transparent, and pixels much
 * darker stay opaque, with a soft ramp in between so strokes keep smooth edges. Each kept
 * pixel's colour is un-mixed from the paper, so edges don't keep a pale halo.
 */
export function removeBackground(rgba: Uint8ClampedArray, width: number, height: number): void {
  if (width === 0 || height === 0) return;
  // The paper's colour, channel by channel, from the border (so tinted paper un-mixes right).
  const border: [number[], number[], number[]] = [[], [], []];
  const sample = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    // Transparent padding (around some scans) isn't paper.
    if ((rgba[i + 3] as number) < 128) return;
    for (let c = 0; c < 3; c++) border[c]?.push(rgba[i + c] as number);
  };
  for (let x = 0; x < width; x++) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    sample(0, y);
    sample(width - 1, y);
  }
  if (border[0].length === 0) return; // No opaque border: nothing to take the paper from.
  const median = (values: number[]) => {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] as number;
  };
  const paperRgb = border.map(median) as [number, number, number];
  const paper = luminance(...paperRgb);
  // Darker than the paper by less than `low`: paper (shadows, grain). More than `high`: ink.
  const low = Math.max(12, paper * 0.12);
  const high = Math.max(low + 20, paper * 0.4);
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] as number;
    const g = rgba[i + 1] as number;
    const b = rgba[i + 2] as number;
    const darkness = paper - luminance(r, g, b);
    const alpha = Math.min(1, Math.max(0, (darkness - low) / (high - low)));
    if (alpha < 1 && alpha > 0) {
      // Seen over the paper, this pixel is paper*(1-a) + ink*a; solve for the ink.
      const unmix = (value: number, p: number) =>
        Math.min(255, Math.max(0, (value - p * (1 - alpha)) / alpha));
      rgba[i] = unmix(r, paperRgb[0]);
      rgba[i + 1] = unmix(g, paperRgb[1]);
      rgba[i + 2] = unmix(b, paperRgb[2]);
    }
    rgba[i + 3] = Math.round(alpha * (rgba[i + 3] as number));
  }
}

/** Scale (width, height) down, never up, to fit within (maxWidth, maxHeight). */
export function fitWithin(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const k = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: width * k, height: height * k };
}

/** A rectangle on a page, in points from its top-left corner as shown. */
export interface PageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type StampSizeKind = "signature" | "initials" | "date" | "stamp";

/** Usual width of each kind of stamp, in points (a signature is about 6 cm wide). */
const TYPICAL_WIDTH: Record<StampSizeKind, number> = {
  signature: 170,
  initials: 60,
  date: 110,
  stamp: 150,
};
/** Never wider than this share of the page. */
const MAX_SHARE: Record<StampSizeKind, number> = {
  signature: 0.45,
  initials: 0.2,
  date: 0.35,
  stamp: 0.4,
};

/**
 * Where a new stamp goes: a sensible size for its kind and the page, keeping the image's
 * proportions, centred on `centre` (the page's middle by default) and inside the page.
 */
export function initialRect(
  page: { width: number; height: number },
  aspect: number,
  kind: StampSizeKind,
  centre?: { x: number; y: number },
): PageRect {
  const ratio = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const width = Math.min(TYPICAL_WIDTH[kind], page.width * MAX_SHARE[kind]);
  const size = fitWithin(width, width / ratio, page.width, page.height);
  const c = centre ?? { x: page.width / 2, y: page.height / 2 };
  return clampRect({ left: c.x - size.width / 2, top: c.y - size.height / 2, ...size }, page);
}

/** Move a rectangle back inside the page (shrinking it, keeping proportions, if too big). */
export function clampRect(rect: PageRect, page: { width: number; height: number }): PageRect {
  const { width, height } = fitWithin(rect.width, rect.height, page.width, page.height);
  return {
    left: Math.min(Math.max(0, rect.left), page.width - width),
    top: Math.min(Math.max(0, rect.top), page.height - height),
    width,
    height,
  };
}

/** Smallest a stamp can be resized to, in points. */
export const MIN_STAMP_SIZE = 8;

/**
 * Resize from the bottom-right corner to make the width `width`, keeping proportions and the
 * top-left corner, within the page and no smaller than MIN_STAMP_SIZE on its short side.
 */
export function resizeRect(
  rect: PageRect,
  width: number,
  page: { width: number; height: number },
): PageRect {
  const aspect = rect.width / rect.height;
  const minWidth = aspect >= 1 ? MIN_STAMP_SIZE * aspect : MIN_STAMP_SIZE;
  const maxWidth = Math.min(page.width - rect.left, (page.height - rect.top) * aspect);
  const w = Math.min(maxWidth, Math.max(minWidth, width));
  return { ...rect, width: w, height: w / aspect };
}

/** What a key does to a stamp being placed. */
export type PlacementKeyAction =
  | { type: "change"; rect: PageRect }
  | { type: "apply" }
  | { type: "cancel" }
  | null;

/**
 * The keyboard controls for a stamp being placed: arrows move it (Shift for 10-point steps),
 * + and − resize it, Enter applies and Escape cancels. Null for any other key.
 */
export function placementKey(
  key: string,
  shift: boolean,
  rect: PageRect,
  page: { width: number; height: number },
): PlacementKeyAction {
  const step = shift ? 10 : 1;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const move = moves[key];
  if (move) {
    const moved = { ...rect, left: rect.left + move[0], top: rect.top + move[1] };
    return { type: "change", rect: clampRect(moved, page) };
  }
  if (key === "+" || key === "=")
    return { type: "change", rect: resizeRect(rect, rect.width * 1.1, page) };
  if (key === "-") return { type: "change", rect: resizeRect(rect, rect.width / 1.1, page) };
  if (key === "Enter") return { type: "apply" };
  if (key === "Escape") return { type: "cancel" };
  return null;
}

/** Today's date as people write it here, e.g. "18 Nov 2026" or "Nov 18, 2026". */
export function formatToday(date = new Date(), locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}
