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
import { HEADER_BYTES, readPictureHeader } from "./imageHeader";
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
  /** Encoded image bytes: PNG, or JPEG for a placed photo (see pictureToImage). */
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

/** Longest side a placed picture is kept at: sharp at any size it's likely to be printed. */
const MAX_PICTURE_SIDE = 2400;
/** The engine takes images up to 10 MB; stay a little under. */
const MAX_PICTURE_BYTES = 9.5 * 1024 * 1024;
/**
 * Pictures with more pixels than this aren't decoded at all: a small file can claim billions
 * of pixels, and decoding it would exhaust the browser's memory (100 megapixels already takes
 * 400 MB). That covers ordinary phone and camera photos; the largest (some phones' 200 MP mode,
 * medium-format cameras) are refused with a message asking for a smaller copy.
 */
const MAX_PICTURE_PIXELS = 100_000_000;

/**
 * A picture (a logo, a photo, a screenshot) to place on a page, as it is: no background
 * removal or trimming. Large pictures are scaled down. Photos become JPEG; pictures with
 * transparency, and PNG and GIF images (screenshots, drawings), stay PNG so they stay crisp.
 * The photo's own orientation (from the camera) is applied.
 */
export async function pictureToImage(file: Blob): Promise<StampImage> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("That picture is too large (25 MB at most).");
  }
  // Check the size in the file's header before decoding anything.
  const header = readPictureHeader(new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer()));
  if (header?.width && header.height && header.width * header.height > MAX_PICTURE_PIXELS) {
    throw new Error(
      `That picture is too big to place (${header.width} × ${header.height} pixels; ` +
        "100 megapixels at most). Try a smaller copy of it.",
    );
  }
  // PNG and GIF (screenshots, drawings) stay PNG, judged by the contents, since a dropped
  // file's type can be missing.
  const losslessSource = header
    ? header.format === "png" || header.format === "gif"
    : file.type === "image/png" || file.type === "image/gif";
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("That file couldn't be read as a picture. Try a PNG, JPEG or WebP image.");
  }
  try {
    let side = MAX_PICTURE_SIDE;
    for (;;) {
      const size = fitWithin(bitmap.width, bitmap.height, side, side);
      const canvas = newCanvas(size.width, size.height);
      const ctx = context(canvas);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let transparent = false;
      for (let i = 3; i < pixels.length; i += 4) {
        if ((pixels[i] as number) < 255) {
          transparent = true;
          break;
        }
      }
      const keepPng = transparent || losslessSource;
      let dataUrl = canvas.toDataURL(keepPng ? "image/png" : "image/jpeg", 0.9);
      // A big opaque PNG (a detailed screenshot) can be too large: a JPEG is far smaller.
      if (dataUrl.length * 0.75 > MAX_PICTURE_BYTES && !transparent) {
        dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      }
      if (dataUrl.length * 0.75 <= MAX_PICTURE_BYTES || side < 400) {
        return {
          png: dataUrlToBytes(dataUrl),
          dataUrl,
          width: canvas.width,
          height: canvas.height,
        };
      }
      side = Math.round(side * 0.75);
    }
  } finally {
    bitmap.close();
  }
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
