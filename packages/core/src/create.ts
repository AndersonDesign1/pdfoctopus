// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Making new PDFs: blank pages, pictures (one per page), and text, Markdown or HTML laid out
// on pages by MuPDF's HTML engine. HTML is laid out without fetching anything: links to
// pictures or style sheets elsewhere are ignored, and scripts never run.

import * as mupdf from "mupdf";
import { escapeHtml, markdownToHtml } from "./markdown";

export type PaperSize = "a4" | "letter" | "legal" | "a5" | "a3";

/** Paper sizes in points, portrait. */
export const PAPER_SIZES: Record<PaperSize, [number, number]> = {
  a4: [595, 842],
  letter: [612, 792],
  legal: [612, 1008],
  a5: [420, 595],
  a3: [842, 1191],
};

export interface PageFormat {
  paper: PaperSize;
  landscape?: boolean;
}

/** A picture to put on a page: PNG or JPEG bytes, and its size in pixels. */
export interface PictureSpec {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** How pictures go on pages: each page the picture's size, or on paper with a margin. */
export type PictureLayout = { fit: "picture" } | { fit: "paper"; paper: PaperSize };

export type TextKind = "text" | "markdown" | "html";

/** What `createPdf` makes. */
export type CreateSpec =
  | { kind: "blank"; format: PageFormat; pages: number }
  | { kind: "pictures"; pictures: PictureSpec[]; layout: PictureLayout }
  | { kind: "text"; source: string; textKind: TextKind; format: PageFormat };

export const MAX_BLANK_PAGES = 1000;
export const MAX_PICTURES = 500;
/** The most text, Markdown or HTML taken, in characters. */
export const MAX_TEXT = 5_000_000;
/** Page margin for pictures on paper, and for text, in points (3/4 inch). */
const MARGIN = 54;
/** A picture on a page of its own size is shown at 96 dpi, as on screen. */
const PICTURE_DPI = 96;
/** The largest page PDF allows, in points. */
const MAX_PAGE = 14_400;

/** A new PDF, as bytes. */
export function createPdf(spec: CreateSpec): Uint8Array {
  switch (spec.kind) {
    case "blank":
      return blankPdf(spec.format, spec.pages);
    case "pictures":
      return picturesPdf(spec.pictures, spec.layout);
    case "text":
      return textPdf(spec.source, spec.textKind, spec.format);
    default:
      throw new Error("Unknown kind of PDF");
  }
}

function pageSize(format: PageFormat): [number, number] {
  const size = PAPER_SIZES[format.paper];
  if (!size) throw new Error("Unknown paper size");
  const [w, h] = size;
  return format.landscape ? [h, w] : [w, h];
}

function save(pdf: mupdf.PDFDocument, options = "garbage,compress"): Uint8Array {
  const buffer = pdf.saveToBuffer(options);
  try {
    return buffer.asUint8Array().slice();
  } finally {
    buffer.destroy();
  }
}

function blankPdf(format: PageFormat, pages: number): Uint8Array {
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_BLANK_PAGES) {
    throw new Error(`Choose 1 to ${MAX_BLANK_PAGES} pages`);
  }
  const [w, h] = pageSize(format);
  const pdf = new mupdf.PDFDocument();
  try {
    for (let i = 0; i < pages; i++) {
      pdf.insertPage(-1, pdf.addPage([0, 0, w, h], 0, pdf.newDictionary(), ""));
    }
    return save(pdf);
  } finally {
    pdf.destroy();
  }
}

function picturesPdf(pictures: PictureSpec[], layout: PictureLayout): Uint8Array {
  if (pictures.length === 0) throw new Error("Choose at least one picture");
  if (pictures.length > MAX_PICTURES) throw new Error(`${MAX_PICTURES} pictures at most`);
  const pdf = new mupdf.PDFDocument();
  try {
    for (const picture of pictures) {
      if (!(picture.width > 0 && picture.height > 0)) throw new Error("A picture has no size");
      const image = new mupdf.Image(picture.bytes);
      let pageW: number;
      let pageH: number;
      let x: number;
      let y: number;
      let w: number;
      let h: number;
      if (layout.fit === "picture") {
        // The picture's own size, kept within what PDF allows.
        const scale = Math.min(
          72 / PICTURE_DPI,
          MAX_PAGE / Math.max(picture.width, picture.height),
        );
        pageW = w = picture.width * scale;
        pageH = h = picture.height * scale;
        x = y = 0;
      } else {
        // On paper, turned to suit the picture, scaled to fit within the margins and centred.
        const [pw, ph] = pageSize({
          paper: layout.paper,
          landscape: picture.width > picture.height,
        });
        pageW = pw;
        pageH = ph;
        const scale = Math.min(
          (pw - 2 * MARGIN) / picture.width,
          (ph - 2 * MARGIN) / picture.height,
        );
        w = picture.width * scale;
        h = picture.height * scale;
        x = (pw - w) / 2;
        y = (ph - h) / 2;
      }
      const resources = pdf.newDictionary();
      const xobjects = pdf.newDictionary();
      xobjects.put("Im0", pdf.addImage(image));
      resources.put("XObject", xobjects);
      const content = `q ${w.toFixed(3)} 0 0 ${h.toFixed(3)} ${x.toFixed(3)} ${y.toFixed(3)} cm /Im0 Do Q`;
      pdf.insertPage(-1, pdf.addPage([0, 0, pageW, pageH], 0, resources, content));
      image.destroy();
    }
    return save(pdf);
  } finally {
    pdf.destroy();
  }
}

/** The style text and Markdown are laid out with; HTML gets only the page margin. */
const TEXT_STYLE = `
@page { margin: ${MARGIN}pt }
body { margin: 0; font-family: sans-serif; font-size: 11pt; line-height: 1.4 }
h1, h2, h3, h4, h5, h6 { line-height: 1.2; margin: 1em 0 0.4em }
pre, code { font-family: monospace; font-size: 10pt }
pre { white-space: pre-wrap; background: #f4f4f4; padding: 6pt }
blockquote { margin: 0.6em 0; padding-left: 10pt; border-left: 3pt solid #ccc; color: #444 }
table { border-collapse: collapse; margin: 0.6em 0 }
th, td { border: 1px solid #999; padding: 3pt 6pt; text-align: left }
a { color: #1a55c4 }
`;

/** The HTML a text, Markdown or HTML source is laid out as. */
export function sourceToHtml(source: string, kind: TextKind): string {
  if (kind === "html") return `<style>@page { margin: ${MARGIN}pt }</style>\n${source}`;
  const body =
    kind === "markdown"
      ? markdownToHtml(source)
      : `<pre style="white-space: pre-wrap; background: none; padding: 0; font-size: 10.5pt">${escapeHtml(source)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${TEXT_STYLE}</style></head><body>${body}</body></html>`;
}

function textPdf(source: string, kind: TextKind, format: PageFormat): Uint8Array {
  if (source.trim().length === 0) throw new Error("There's no text to make a PDF from");
  if (source.length > MAX_TEXT)
    throw new Error("The text is too long (5 million characters at most)");
  const [w, h] = pageSize(format);
  const html = new TextEncoder().encode(sourceToHtml(source, kind));
  const doc = mupdf.Document.openDocument(html, "text/html");
  const buffer = new mupdf.Buffer();
  try {
    doc.layout(w, h, 11);
    const writer = new mupdf.DocumentWriter(buffer, "pdf", "");
    const count = doc.countPages();
    for (let i = 0; i < count; i++) {
      const page = doc.loadPage(i);
      try {
        const device = writer.beginPage(page.getBounds());
        page.run(device, mupdf.Matrix.identity);
        writer.endPage();
      } finally {
        page.destroy();
      }
    }
    writer.close();
    // MuPDF embeds whole fonts (a CJK font is megabytes); keep only the letters used.
    const written = mupdf.Document.openDocument(buffer.asUint8Array().slice(), "application/pdf");
    try {
      const pdf = written.asPDF() as mupdf.PDFDocument;
      pdf.subsetFonts();
      return save(pdf);
    } finally {
      written.destroy();
    }
  } finally {
    buffer.destroy();
    doc.destroy();
  }
}
