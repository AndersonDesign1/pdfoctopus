// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Exporting one page as a picture (PNG, JPEG), a drawing (SVG), plain text or HTML. Pages are
// exported one at a time, so a long document can show progress and be cancelled, and only
// one page's pixels are in memory at once. Annotations and form fields are included, as
// shown on screen.

import * as mupdf from "mupdf";
import {
  DEFAULT_EXPORT_DPI,
  DEFAULT_JPEG_QUALITY,
  type ExportOptions,
  MAX_EXPORT_DPI,
  MIN_EXPORT_DPI,
} from "./exportFiles";

/** A page picture is made smaller than asked if it would have more pixels than this. */
export const MAX_EXPORT_PIXELS = 60_000_000;

/** The scale a page is drawn at for a resolution, kept within MAX_EXPORT_PIXELS. */
export function exportScale(bounds: mupdf.Rect, dpi: number): number {
  const w = Math.abs(bounds[2] - bounds[0]);
  const h = Math.abs(bounds[3] - bounds[1]);
  const scale = dpi / 72;
  const pixels = w * scale * (h * scale);
  return pixels > MAX_EXPORT_PIXELS ? Math.sqrt(MAX_EXPORT_PIXELS / (w * h)) : scale;
}

function checkOptions(options: ExportOptions): { dpi: number; quality: number } {
  const dpi = options.dpi ?? DEFAULT_EXPORT_DPI;
  const quality = options.quality ?? DEFAULT_JPEG_QUALITY;
  if (!(dpi >= MIN_EXPORT_DPI && dpi <= MAX_EXPORT_DPI)) {
    throw new Error(`Choose a resolution from ${MIN_EXPORT_DPI} to ${MAX_EXPORT_DPI} dpi`);
  }
  if (!(Number.isInteger(quality) && quality >= 1 && quality <= 100)) {
    throw new Error("Choose a JPEG quality from 1 to 100");
  }
  return { dpi, quality };
}

/** Copy bytes out of MuPDF's memory, which moves when it grows. */
function copyOut(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

/** One page, exported as the options say. Text and HTML come back as UTF-8. */
export function exportPage(page: mupdf.Page, index: number, options: ExportOptions): Uint8Array {
  const { dpi, quality } = checkOptions(options);
  switch (options.format) {
    case "png":
    case "jpeg": {
      const scale = exportScale(page.getBounds(), dpi);
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );
      try {
        // Recorded in the file, so the picture prints at the page's size.
        const actual = Math.round(scale * 72);
        pixmap.setResolution(actual, actual);
        return copyOut(options.format === "png" ? pixmap.asPNG() : pixmap.asJPEG(quality));
      } finally {
        pixmap.destroy();
      }
    }
    case "svg": {
      const buffer = new mupdf.Buffer();
      try {
        const writer = new mupdf.DocumentWriter(buffer, "svg", "");
        const device = writer.beginPage(page.getBounds());
        page.run(device, mupdf.Matrix.identity);
        writer.endPage();
        writer.close();
        return copyOut(buffer.asUint8Array());
      } finally {
        buffer.destroy();
      }
    }
    case "text":
    case "html": {
      const html = options.format === "html";
      // Through a display list with annotations and form fields, so what's typed into a
      // form comes out too (the page's own text leaves out unflattened field values).
      const list = page.toDisplayList(true);
      try {
        const text = list.toStructuredText(
          html ? "preserve-whitespace,preserve-images" : "preserve-whitespace",
        );
        try {
          return new TextEncoder().encode(html ? text.asHTML(index) : text.asText());
        } finally {
          text.destroy();
        }
      } finally {
        list.destroy();
      }
    }
    default:
      throw new Error("Unknown export format");
  }
}
