// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Turning exported pages into files to save: pictures and SVG one file per page (in a ZIP
// when there are several), text and HTML one file for all the chosen pages. Nothing here
// uses MuPDF, so the UI can use it directly.

import { zipFiles } from "./zip";

export type ExportFormat = "png" | "jpeg" | "svg" | "text" | "html";

export interface ExportOptions {
  format: ExportFormat;
  /** For PNG and JPEG: pixels per inch (72 = the page's size in points). */
  dpi?: number;
  /** For JPEG: quality, 1–100. */
  quality?: number;
}

export const MIN_EXPORT_DPI = 36;
export const MAX_EXPORT_DPI = 600;
export const DEFAULT_EXPORT_DPI = 150;
export const DEFAULT_JPEG_QUALITY = 85;

/** What a format's files are called and their media type. */
export const EXPORT_TYPES: Record<
  ExportFormat,
  { label: string; extension: string; mime: string }
> = {
  png: { label: "PNG picture", extension: "png", mime: "image/png" },
  jpeg: { label: "JPEG picture", extension: "jpg", mime: "image/jpeg" },
  svg: { label: "SVG drawing", extension: "svg", mime: "image/svg+xml" },
  text: { label: "Plain text", extension: "txt", mime: "text/plain" },
  html: { label: "Web page", extension: "html", mime: "text/html" },
};

export const ZIP_TYPE = { label: "ZIP archive", extension: "zip", mime: "application/zip" };

export interface ExportedPage {
  /** 0-based page index. */
  page: number;
  bytes: Uint8Array;
}

export interface ExportFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
  extension: string;
  label: string;
}

/** Whether a format makes one file per page (so several pages make a ZIP). */
export function filePerPage(format: ExportFormat): boolean {
  return format === "png" || format === "jpeg" || format === "svg";
}

/** "report.pdf" → "report". Characters that aren't allowed in file names become "_". */
export function exportStem(fileName: string): string {
  const stem = Array.from(fileName.replace(/\.pdf$/i, ""), (c) =>
    c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? "_" : c,
  )
    .join("")
    .trim();
  return stem || "document";
}

/** The name of the file for one page, e.g. "report-page-03.png" (numbered to sort). */
export function pageFileName(
  stem: string,
  page: number,
  pageCount: number,
  extension: string,
): string {
  const digits = String(pageCount).length;
  return `${stem}-page-${String(page + 1).padStart(digits, "0")}.${extension}`;
}

/** The name the saved file is offered under, before the pages are exported. */
export function exportFileName(
  fileName: string,
  format: ExportFormat,
  pages: readonly number[],
  pageCount: number,
): string {
  const stem = exportStem(fileName);
  const type = EXPORT_TYPES[format];
  if (filePerPage(format)) {
    if (pages.length === 1) return pageFileName(stem, pages[0] ?? 0, pageCount, type.extension);
    return `${stem}-${type.extension}.zip`;
  }
  return `${stem}.${type.extension}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The HTML page wrapping exported pages: each page a white sheet with its text placed as on
 * the page. Scripts and anything from elsewhere are blocked, so the file can't do anything
 * when opened, whatever the PDF held.
 */
export function htmlDocument(title: string, pages: readonly Uint8Array[]): Uint8Array {
  const encoder = new TextEncoder();
  const head = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { background: #6b7280; margin: 0; padding: 1em 0 }
body > div { position: relative; background: #fff; margin: 0 auto 1em; box-shadow: 0 1px 6px rgba(0,0,0,.4); overflow: hidden }
p { position: absolute; white-space: pre; margin: 0 }
img { position: absolute }
</style>
</head>
<body>
`;
  return concat([encoder.encode(head), ...pages, encoder.encode("</body>\n</html>\n")]);
}

/** Text of several pages in one file, each page ending with a form feed (as pdftotext does). */
export function joinText(pages: readonly Uint8Array[]): Uint8Array {
  const feed = new TextEncoder().encode("\f");
  return concat(pages.flatMap((page) => [page, feed]));
}

/** The file to save from the exported pages (in the order given). */
export function assembleExport(
  fileName: string,
  format: ExportFormat,
  pages: readonly ExportedPage[],
  pageCount: number,
): ExportFile {
  if (pages.length === 0) throw new Error("Choose at least one page");
  const stem = exportStem(fileName);
  const type = EXPORT_TYPES[format];
  const name = exportFileName(
    fileName,
    format,
    pages.map((p) => p.page),
    pageCount,
  );
  const file = (bytes: Uint8Array, t: typeof type) => ({ name, bytes, ...t });
  if (filePerPage(format)) {
    if (pages.length === 1) return file((pages[0] as ExportedPage).bytes, type);
    const zip = zipFiles(
      pages.map((p) => ({
        name: pageFileName(stem, p.page, pageCount, type.extension),
        bytes: p.bytes,
      })),
    );
    return file(zip, ZIP_TYPE);
  }
  const bytes = pages.map((p) => p.bytes);
  return file(format === "html" ? htmlDocument(stem, bytes) : joinText(bytes), type);
}
