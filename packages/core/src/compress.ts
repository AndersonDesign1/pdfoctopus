// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Making a smaller copy of a PDF: pictures larger than the pages need are scaled down and
// saved as JPEG, and the file is rebuilt (unused objects dropped, duplicates merged, streams
// and fonts compressed, objects packed into object streams). MuPDF's own image rewriting isn't
// in its JavaScript build, so pictures are re-encoded here, one at a time.

import * as mupdf from "mupdf";

/** How hard to try. "high" only rebuilds the file; the others also shrink pictures. */
export type CompressPreset = "high" | "balanced" | "smallest";

interface ImagePolicy {
  /** Pictures are scaled to at most this many pixels per inch of the largest page. */
  dpi: number;
  /** JPEG quality, 1–100. */
  quality: number;
  /** Re-encode pictures stored losslessly (Flate) as JPEG even when they aren't scaled down. */
  photosToJpeg: boolean;
}

const PRESETS: Record<CompressPreset, ImagePolicy | null> = {
  high: null,
  balanced: { dpi: 200, quality: 80, photosToJpeg: false },
  smallest: { dpi: 120, quality: 60, photosToJpeg: true },
};

/** MuPDF writer options for a rebuilt, compressed file. */
export const REBUILD_OPTIONS =
  "garbage=deduplicate,compress,compress-fonts,compress-images,objstms";

/** Pictures bigger than this (in pixels) are left alone: decoding them could exhaust memory. */
const MAX_PIXELS = 100_000_000;

/**
 * A JPEG of a scaled picture rarely takes under this many bytes per pixel; a picture already
 * stored in fewer isn't worth decoding.
 */
const MIN_BYTES_PER_PIXEL = 0.03;

/** A re-encoded picture replaces the original only if it's at least this much smaller. */
const WORTH_IT = 0.9;

export interface ShrinkResult {
  /** How many pictures were made smaller. */
  images: number;
}

/** Whether a preset changes pictures (and so is lossy). */
export function shrinksImages(preset: CompressPreset): boolean {
  return PRESETS[preset] !== null;
}

/**
 * Shrink the pictures in a document (in place) as a preset says. Pictures that can't be
 * re-encoded safely, or well, are left as they are: masks and pictures used as masks, 1-bit
 * pictures (scans, which are better compressed as they are), JPEG 2000 pictures, and pictures
 * with decode arrays or colour key masks, which JPEG would break.
 */
export function shrinkImages(pdf: mupdf.PDFDocument, preset: CompressPreset): ShrinkResult {
  const policy = PRESETS[preset];
  if (!policy) return { images: 0 };
  const maxEdge = Math.round(largestPageEdgeInches(pdf) * policy.dpi);

  // Pictures other pictures use as masks keep their exact pixels.
  const masks = new Set<number>();
  const images: mupdf.PDFObject[] = [];
  for (let i = 1; i < pdf.countObjects(); i++) {
    const object = pdf.newIndirect(i);
    if (!isImage(object)) continue;
    images.push(object);
    for (const key of ["SMask", "Mask"]) {
      const mask = object.get(key);
      if (mask.isIndirect()) masks.add(mask.asIndirect());
    }
  }

  let shrunk = 0;
  for (const object of images) {
    if (masks.has(object.asIndirect())) continue;
    try {
      if (shrinkImage(pdf, object, policy, maxEdge)) shrunk++;
    } catch {
      // A picture MuPDF can't decode is left as it is.
    }
  }
  return { images: shrunk };
}

function isImage(object: mupdf.PDFObject): boolean {
  if (!object.isStream()) return false;
  const subtype = object.get("Subtype");
  return subtype.isName() && subtype.asName() === "Image";
}

function shrinkImage(
  pdf: mupdf.PDFDocument,
  object: mupdf.PDFObject,
  policy: ImagePolicy,
  maxEdge: number,
): boolean {
  if (object.get("ImageMask").isBoolean() && object.get("ImageMask").asBoolean()) return false;
  if (!object.get("Decode").isNull()) return false;
  if (object.get("Mask").isArray()) return false;
  const width = object.get("Width");
  const height = object.get("Height");
  if (!width.isNumber() || !height.isNumber()) return false;
  const w = width.asNumber();
  const h = height.asNumber();
  if (w * h > MAX_PIXELS || w < 16 || h < 16) return false;

  const filter = filterName(object);
  // Scans' formats (1-bit), and JPEG 2000, which already compresses better than JPEG and is
  // slow to decode.
  if (filter === "JBIG2Decode" || filter === "CCITTFaxDecode" || filter === "JPXDecode") {
    return false;
  }
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const isJpeg = filter === "DCTDecode";
  // Nothing to gain: already the right size, and either already JPEG or not to be made JPEG.
  if (scale > 0.95 && (isJpeg || !policy.photosToJpeg)) return false;

  // Already stored in very few bytes per pixel (JPEG 2000 scans often are): JPEG won't beat
  // it, so don't spend time decoding it.
  const raw = object.readRawStream();
  const before = raw.getLength();
  raw.destroy();
  const scaledPixels = Math.round(w * scale) * Math.round(h * scale);
  if (before < scaledPixels * MIN_BYTES_PER_PIXEL) return false;

  const image = pdf.loadImage(object);
  if (image.getBitsPerComponent() !== 8 || image.getImageMask()) return false;
  const colorspace = image.getColorSpace();
  if (!colorspace || colorspace.isDeviceN() || colorspace.isLab()) return false;

  // Every pixmap made along the way is freed as soon as it's done with.
  const made: mupdf.Pixmap[] = [];
  let jpeg: Uint8Array;
  let newW: number;
  let newH: number;
  let gray: boolean;
  try {
    let pixmap = image.toPixmap();
    made.push(pixmap);
    gray = pixmap.getNumberOfComponents() - pixmap.getAlpha() === 1;
    const target = gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
    const space = pixmap.getColorSpace();
    if (pixmap.getAlpha() || !(gray ? space?.isGray() : space?.isRGB())) {
      pixmap = pixmap.convertToColorSpace(target, false);
      made.push(pixmap);
    }
    const W = pixmap.getWidth();
    const H = pixmap.getHeight();
    newW = Math.max(1, Math.round(W * scale));
    newH = Math.max(1, Math.round(H * scale));
    if (newW !== W || newH !== H) {
      // Corners in MuPDF's quad order: top left, top right, bottom left, bottom right.
      pixmap = pixmap.warp(
        [
          [0, 0],
          [W, 0],
          [0, H],
          [W, H],
        ],
        newW,
        newH,
      );
      made.push(pixmap);
    }
    // A copy: the bytes MuPDF returns are a view of its memory, which moves when it grows.
    jpeg = pixmap.asJPEG(policy.quality).slice();
  } finally {
    for (const p of made) p.destroy();
    image.destroy();
  }
  if (jpeg.length >= before * WORTH_IT) return false;

  object.writeRawStream(jpeg);
  object.put("Filter", pdf.newName("DCTDecode"));
  object.put("Width", newW);
  object.put("Height", newH);
  object.put("BitsPerComponent", 8);
  object.put("ColorSpace", pdf.newName(gray ? "DeviceGray" : "DeviceRGB"));
  object.delete("DecodeParms");
  object.delete("Length1");
  return true;
}

function filterName(object: mupdf.PDFObject): string {
  let filter = object.get("Filter");
  // With a chain of filters, the last one says how the picture itself is encoded.
  if (filter.isArray()) filter = filter.length ? filter.get(filter.length - 1) : filter;
  return filter.isName() ? filter.asName() : "";
}

/** The largest page's longer side, in inches. */
function largestPageEdgeInches(pdf: mupdf.PDFDocument): number {
  let largest = 0;
  for (let i = 0; i < pdf.countPages(); i++) {
    const page = pdf.loadPage(i);
    try {
      const [x0, y0, x1, y1] = page.getBounds();
      largest = Math.max(largest, x1 - x0, y1 - y0);
    } finally {
      page.destroy();
    }
  }
  // An empty document, or one with tiny pages: assume a letter page.
  return Math.max(largest, 792) / 72;
}
