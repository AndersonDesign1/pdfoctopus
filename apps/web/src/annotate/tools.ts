// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The annotation tools and the pure geometry behind them (turning a drag into a rectangle,
// thinning a pen stroke, keeping things on the page). No DOM here, so it's unit-tested.

import type { AnnotationKind, PagePoint, RgbColor } from "@pdfoctopus/core";

export type ToolId = AnnotationKind;

/** How a tool is used on the page. */
export type Gesture =
  /** Drag across text, like selecting it. */
  | "text"
  /** Draw freehand. */
  | "ink"
  /** Drag out a box. */
  | "box"
  /** Drag from one point to another. */
  | "line"
  /** Click a spot, then type. */
  | "point";

export interface Tool {
  id: ToolId;
  label: string;
  /** How messages name what it adds, with its article: "a highlight", "an arrow". */
  noun: string;
  /** A short symbol for the toolbar button. */
  icon: string;
  gesture: Gesture;
  /** Whether the tool uses a line width. */
  hasWidth: boolean;
  /** Whether the tool asks for text after its gesture. */
  needsText: boolean;
  defaultColor: RgbColor;
  hint: string;
}

const YELLOW: RgbColor = [1, 0.85, 0.1];
const RED: RgbColor = [0.85, 0.1, 0.1];
const BLUE: RgbColor = [0.1, 0.3, 0.85];
const BLACK: RgbColor = [0, 0, 0];

export const TOOLS: Tool[] = [
  {
    id: "highlight",
    label: "Highlight",
    noun: "a highlight",
    icon: "▍",
    gesture: "text",
    hasWidth: false,
    needsText: false,
    defaultColor: YELLOW,
    hint: "Drag across the text to highlight",
  },
  {
    id: "underline",
    label: "Underline",
    noun: "an underline",
    icon: "U̲",
    gesture: "text",
    hasWidth: false,
    needsText: false,
    defaultColor: BLUE,
    hint: "Drag across the text to underline",
  },
  {
    id: "strikeout",
    label: "Strikethrough",
    noun: "a strikethrough",
    icon: "S̶",
    gesture: "text",
    hasWidth: false,
    needsText: false,
    defaultColor: RED,
    hint: "Drag across the text to strike it through",
  },
  {
    id: "ink",
    label: "Pen",
    noun: "a drawing",
    icon: "✎",
    gesture: "ink",
    hasWidth: true,
    needsText: false,
    defaultColor: BLUE,
    hint: "Draw on the page",
  },
  {
    id: "rectangle",
    label: "Rectangle",
    noun: "a rectangle",
    icon: "▭",
    gesture: "box",
    hasWidth: true,
    needsText: false,
    defaultColor: RED,
    hint: "Drag to draw a rectangle",
  },
  {
    id: "ellipse",
    label: "Ellipse",
    noun: "an ellipse",
    icon: "◯",
    gesture: "box",
    hasWidth: true,
    needsText: false,
    defaultColor: RED,
    hint: "Drag to draw an ellipse",
  },
  {
    id: "line",
    label: "Line",
    noun: "a line",
    icon: "╱",
    gesture: "line",
    hasWidth: true,
    needsText: false,
    defaultColor: RED,
    hint: "Drag to draw a line",
  },
  {
    id: "arrow",
    label: "Arrow",
    noun: "an arrow",
    icon: "↗",
    gesture: "line",
    hasWidth: true,
    needsText: false,
    defaultColor: RED,
    hint: "Drag to draw an arrow",
  },
  {
    id: "note",
    label: "Note",
    noun: "a note",
    icon: "🗨",
    gesture: "point",
    hasWidth: false,
    needsText: true,
    defaultColor: YELLOW,
    hint: "Click where the note should go",
  },
  {
    id: "text",
    label: "Text box",
    noun: "a text box",
    icon: "T",
    gesture: "box",
    hasWidth: false,
    needsText: true,
    defaultColor: BLACK,
    hint: "Drag out a box (or click) for the text",
  },
  {
    id: "whiteout",
    label: "White-out",
    noun: "a white-out box",
    icon: "▯",
    gesture: "box",
    hasWidth: false,
    needsText: false,
    defaultColor: [1, 1, 1],
    hint: "Drag over what to cover with white",
  },
  {
    id: "redact",
    label: "Redact",
    noun: "a redaction mark",
    icon: "▇",
    gesture: "box",
    hasWidth: false,
    needsText: false,
    defaultColor: [0, 0, 0],
    hint: "Drag over what to remove. Nothing is removed until you apply the redactions",
  },
];

/** Tools that don't take a colour. */
export function hasColor(id: ToolId): boolean {
  return id !== "whiteout" && id !== "redact";
}

export function toolById(id: ToolId): Tool {
  return TOOLS.find((t) => t.id === id) as Tool;
}

/** Colours offered for annotations. */
export const PALETTE: { label: string; value: RgbColor }[] = [
  { label: "Yellow", value: YELLOW },
  { label: "Red", value: RED },
  { label: "Blue", value: BLUE },
  { label: "Green", value: [0.1, 0.6, 0.25] },
  { label: "Black", value: BLACK },
];

/** Line widths offered, in points. */
export const WIDTHS: { label: string; value: number }[] = [
  { label: "Thin", value: 1 },
  { label: "Medium", value: 2 },
  { label: "Thick", value: 4 },
];

/** Font size for new text boxes, in points. */
export const TEXT_SIZE = 12;

/** `rgb(…)` for CSS from a 0-to-1 colour. */
export function cssColor([r, g, b]: RgbColor): string {
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

/** Keep a point on the page. */
export function clampPoint([x, y]: PagePoint, page: { width: number; height: number }): PagePoint {
  return [Math.min(Math.max(0, x), page.width), Math.min(Math.max(0, y), page.height)];
}

/** The box between two corners, as [left, top, right, bottom], kept on the page. */
export function dragRect(
  a: PagePoint,
  b: PagePoint,
  page: { width: number; height: number },
): [number, number, number, number] {
  const [ax, ay] = clampPoint(a, page);
  const [bx, by] = clampPoint(b, page);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/** A drag smaller than this (in points) each way counts as a click. */
export const CLICK_SLOP = 3;

/** True when a drag from `a` to `b` was really a click. */
export function isClick(a: PagePoint, b: PagePoint): boolean {
  return Math.abs(b[0] - a[0]) < CLICK_SLOP && Math.abs(b[1] - a[1]) < CLICK_SLOP;
}

/**
 * A text box for a click (no drag) at a point: a default size, starting at the point, moved
 * back onto the page if it would run off.
 */
export function defaultTextRect(
  at: PagePoint,
  page: { width: number; height: number },
): [number, number, number, number] {
  const width = Math.min(200, page.width);
  const height = Math.min(TEXT_SIZE * 2.5, page.height);
  const left = Math.min(Math.max(0, at[0]), page.width - width);
  const top = Math.min(Math.max(0, at[1]), page.height - height);
  return [left, top, left + width, top + height];
}

/**
 * Thin out a pen stroke: drop points closer than `minGap` points to the last one kept, so a
 * slow stroke doesn't store hundreds of nearly identical points. The last point is always kept.
 */
export function thinStroke(points: readonly PagePoint[], minGap = 0.75): PagePoint[] {
  const out: PagePoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minGap) out.push(p);
  }
  const end = points[points.length - 1];
  if (end && out[out.length - 1] !== end) out.push(end);
  return out;
}
