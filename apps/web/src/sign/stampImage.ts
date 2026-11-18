// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Turning drawn strokes, typed text and uploaded pictures into the transparent PNG that is
// stamped on the page. Everything happens on canvases in this browser; nothing is uploaded.

import "@fontsource/caveat/latin-400.css";
import "@fontsource/caveat/latin-ext-400.css";
import "@fontsource/dancing-script/latin-400.css";
import "@fontsource/dancing-script/latin-ext-400.css";
import "@fontsource/great-vibes/latin-400.css";
import "@fontsource/great-vibes/latin-ext-400.css";
import {
  contentBounds,
  fitWithin,
  type InkPoint,
  padBox,
  removeBackground,
  smoothStroke,
  strokeWidth,
  transparentShare,
} from "./ink";

/** A ready-to-stamp image. */
export interface StampImage {
  /** PNG bytes. */
  png: Uint8Array;
  /** The same PNG as a data: URL, for previews and for saving it for reuse. */
  dataUrl: string;
  /** Size in pixels. */
  width: number;
  height: number;
}

/** Handwriting fonts for typed signatures (all SIL Open Font Licence, bundled with the app). */
export const SIGNATURE_FONTS = [
  { family: "Dancing Script", label: "Flowing" },
  { family: "Great Vibes", label: "Formal" },
  { family: "Caveat", label: "Casual" },
] as const;

export type SignatureFont = (typeof SIGNATURE_FONTS)[number]["family"];

/** Ink colours offered: black, and the blue that shows a signature is an original. */
export const INK_COLOURS = [
  { value: "#111111", label: "Black" },
  { value: "#1a3fa8", label: "Blue" },
] as const;

/** Uploaded pictures are scaled down to this many pixels on their longer side. */
const MAX_UPLOAD_SIDE = 1600;
/**
 * Larger files aren't read at all: the browser decodes the whole picture before it can be
 * scaled down, and a phone photo is well under this.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser can't draw images");
  return ctx;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A StampImage from a saved data: URL. */
export function stampFromDataUrl(dataUrl: string, width: number, height: number): StampImage {
  return { png: dataUrlToBytes(dataUrl), dataUrl, width, height };
}

/**
 * Crop a canvas to what's drawn on it, plus a small margin, and encode it as a PNG.
 * Returns null when nothing is drawn.
 */
export function trimToStamp(canvas: HTMLCanvasElement, margin = 4): StampImage | null {
  const ctx = context(canvas);
  const { width, height } = canvas;
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const bounds = contentBounds(pixels, width, height);
  if (!bounds) return null;
  const box = padBox(bounds, margin, width, height);
  const out = newCanvas(box.width, box.height);
  context(out).drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  const dataUrl = out.toDataURL("image/png");
  return { png: dataUrlToBytes(dataUrl), dataUrl, width: out.width, height: out.height };
}

/**
 * Draw smoothed strokes in `colour`. Points are in the drawing pad's CSS pixels; the image
 * is drawn `scale` times larger, so it stays sharp when the stamp is printed.
 */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: readonly (readonly InkPoint[])[],
  colour: string,
  baseWidth: number,
  scale = 1,
): void {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.strokeStyle = colour;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    for (const seg of smoothStroke(stroke)) {
      ctx.lineWidth = strokeWidth(baseWidth, seg.pressure);
      ctx.beginPath();
      ctx.moveTo(seg.from.x, seg.from.y);
      ctx.quadraticCurveTo(seg.control.x, seg.control.y, seg.to.x, seg.to.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** A drawn signature as a stamp, at 3× the pad's size. Null if nothing was drawn. */
export function strokesToStamp(
  strokes: readonly (readonly InkPoint[])[],
  size: { width: number; height: number },
  colour: string,
  baseWidth: number,
): StampImage | null {
  const scale = 3;
  const canvas = newCanvas(size.width * scale, size.height * scale);
  drawStrokes(context(canvas), strokes, colour, baseWidth, scale);
  return trimToStamp(canvas, 2 * scale);
}

/**
 * Typed text in a font, as a stamp. Waits for the font to load first (it's bundled, but
 * only fetched the first time it's used). Null for empty text.
 */
export async function textToStamp(
  text: string,
  fontFamily: string,
  colour: string,
): Promise<StampImage | null> {
  const value = text.trim();
  if (!value) return null;
  const px = 120;
  const font = `${px}px "${fontFamily}"`;
  try {
    await document.fonts.load(font, value);
  } catch {
    // Draw with whatever font the browser falls back to rather than fail.
  }
  const measure = context(newCanvas(1, 1));
  measure.font = font;
  const width = measure.measureText(value).width;
  // Handwriting fonts have tall loops and long tails: leave room on every side, then trim.
  const canvas = newCanvas(width + px * 1.5, px * 2.2);
  const ctx = context(canvas);
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(value, px * 0.75, px * 1.45);
  return trimToStamp(canvas, 8);
}

/** A date (or other short text) in the app's plain font, as a stamp. */
export function dateToStamp(text: string, colour: string): StampImage | null {
  const px = 72;
  const font = `${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const measure = context(newCanvas(1, 1));
  measure.font = font;
  const width = measure.measureText(text).width;
  const canvas = newCanvas(width + px, px * 1.6);
  const ctx = context(canvas);
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.fillText(text, px / 2, px * 1.15);
  return trimToStamp(canvas, 6);
}

/**
 * A picture of a signature (a photo or scan) as a stamp. Large pictures are scaled down.
 * Unless the picture already has a transparent background, the paper is removed when
 * `removePaper` is set. Null if nothing is left (e.g. a blank page).
 */
export async function pictureToStamp(file: Blob, removePaper: boolean): Promise<StampImage | null> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("That picture is too large (25 MB at most). Try a smaller photo or scan.");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file couldn't be read as a picture. Try a PNG or JPEG.");
  }
  try {
    const size = fitWithin(bitmap.width, bitmap.height, MAX_UPLOAD_SIDE, MAX_UPLOAD_SIDE);
    const canvas = newCanvas(size.width, size.height);
    const ctx = context(canvas);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (removePaper) {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // A picture that's mostly see-through already has its background removed. A few
      // transparent pixels (padding around a scan) don't count.
      if (transparentShare(data.data) < 0.3) {
        removeBackground(data.data, canvas.width, canvas.height);
        ctx.putImageData(data, 0, 0);
      }
    }
    return trimToStamp(canvas, 4);
  } finally {
    bitmap.close();
  }
}
