// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thin, synchronous wrapper around MuPDF (WebAssembly). It runs inside the Web Worker
// (see worker.ts) in the browser, and directly in Node for tests.

import * as mupdf from "mupdf";
import { IncrementalSaveError, PasswordRequiredError } from "./errors";

/** A rendered page as raw, non-premultiplied RGBA pixels (ready for `ImageData`). */
export interface RenderedPage {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

/** Size of a page in PDF points (1/72 inch), after the page's own rotation. */
export interface PageSize {
  width: number;
  height: number;
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
  /** E.g. "PDF 1.7". */
  format?: string;
  /** E.g. "Standard V5 R6 256-bit AES", or undefined when not encrypted. */
  encryption?: string;
}

export interface DocumentInfo {
  pageCount: number;
  pages: PageSize[];
  /** Page labels as shown in the document (e.g. "i", "ii", "1"), when it defines them. */
  labels: (string | null)[];
  metadata: DocumentMetadata;
}

/** A search hit: one or more quads (a hit can wrap across lines) on one page. */
export interface SearchHit {
  page: number;
  /** Each quad is [ulx, uly, urx, ury, llx, lly, lrx, lry] in page points, origin top-left. */
  quads: number[][];
}

export type OpenResult = { needsPassword: true } | ({ needsPassword: false } & DocumentInfo);

/** Upper bound on search hits returned at once, so a common word can't flood the UI. */
export const MAX_SEARCH_HITS = 5000;

export class PdfEngine {
  private doc: mupdf.Document | null = null;
  /** MuPDF's needsPassword() stays true after a successful unlock, so track it here. */
  private locked = false;

  /**
   * Open a PDF. If it needs a password, nothing else can be read until `authenticate`
   * succeeds.
   */
  open(bytes: Uint8Array): OpenResult {
    this.close();
    this.doc = mupdf.Document.openDocument(bytes, "application/pdf");
    this.locked = this.doc.needsPassword();
    if (this.locked) return { needsPassword: true };
    return { needsPassword: false, ...this.info() };
  }

  /** Try a password. Returns the document's info on success, or null if it was wrong. */
  authenticate(password: string): DocumentInfo | null {
    const doc = this.requireDoc(false);
    if (!this.locked) return this.info();
    if (doc.authenticatePassword(password) === 0) return null;
    this.locked = false;
    return this.info();
  }

  info(): DocumentInfo {
    const doc = this.requireDoc();
    const pageCount = doc.countPages();
    const pages: PageSize[] = [];
    const labels: (string | null)[] = [];
    let anyLabel = false;
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        pages.push({ width: x1 - x0, height: y1 - y0 });
        const label = page.getLabel();
        // MuPDF falls back to the page number when there's no label; only keep real ones.
        const real = label && label !== String(i + 1) ? label : null;
        if (real) anyLabel = true;
        labels.push(real);
      } finally {
        page.destroy();
      }
    }
    return {
      pageCount,
      pages,
      labels: anyLabel ? labels : labels.map(() => null),
      metadata: this.metadata(),
    };
  }

  private metadata(): DocumentMetadata {
    const doc = this.requireDoc();
    const get = (key: string) => {
      const value = doc.getMetaData(key)?.trim();
      return value ? value : undefined;
    };
    const encryption = get("encryption");
    return {
      title: get("info:Title"),
      author: get("info:Author"),
      subject: get("info:Subject"),
      keywords: get("info:Keywords"),
      creator: get("info:Creator"),
      producer: get("info:Producer"),
      creationDate: get("info:CreationDate"),
      modificationDate: get("info:ModDate"),
      format: get("format"),
      encryption: encryption && encryption !== "None" ? encryption : undefined,
    };
  }

  get pageCount(): number {
    return this.requireDoc().countPages();
  }

  /** Render a page (0-based) to RGBA pixels on white. `scale` 1 = 72 dpi. */
  renderPage(index: number, scale = 1.5): RenderedPage {
    const page = this.requireDoc().loadPage(index);
    try {
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );
      try {
        const width = pixmap.getWidth();
        const height = pixmap.getHeight();
        return { width, height, pixels: rgbToRgba(pixmap.getPixels(), width, height, pixmap) };
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  /** Render a page to PNG (for exports and tests). */
  renderPagePng(index: number, scale = 1.5): Uint8Array {
    const page = this.requireDoc().loadPage(index);
    try {
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );
      try {
        return pixmap.asPNG();
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  /** Find text (ignoring case and accents) on every page. Stops after MAX_SEARCH_HITS hits. */
  search(query: string): { hits: SearchHit[]; truncated: boolean } {
    const doc = this.requireDoc();
    const hits: SearchHit[] = [];
    if (!query.trim()) return { hits, truncated: false };
    const pageCount = doc.countPages();
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        const [x0, y0] = page.getBounds();
        for (const hit of page.search(query, "ignore-case,ignore-diacritics")) {
          // Make coordinates relative to the page's visible top-left corner.
          const quads = hit.map((q) => q.map((v, j) => v - (j % 2 === 0 ? x0 : y0)));
          hits.push({ page: i, quads });
          if (hits.length >= MAX_SEARCH_HITS) return { hits, truncated: true };
        }
      } finally {
        page.destroy();
      }
    }
    return { hits, truncated: false };
  }

  /**
   * Save the document. Incremental by default: the original bytes are kept as-is and
   * any changes are appended to the end of the file, so existing signatures stay valid.
   *
   * If the file can't be saved incrementally (for example, it was damaged and had to be
   * repaired), this throws. Callers must then ask the user and pass `incremental: false`
   * to rewrite the whole file; it is never done silently.
   */
  save({ incremental = true }: { incremental?: boolean } = {}): Uint8Array {
    const pdf = this.requireDoc().asPDF();
    if (!pdf) throw new Error("Not a PDF document");
    if (incremental && !pdf.canBeSavedIncrementally()) {
      throw new IncrementalSaveError();
    }
    const buffer = pdf.saveToBuffer(incremental ? "incremental" : "garbage");
    try {
      return buffer.asUint8Array().slice();
    } finally {
      buffer.destroy();
    }
  }

  close(): void {
    this.doc?.destroy();
    this.doc = null;
    this.locked = false;
  }

  /** The open document; by default it must also be unlocked. */
  private requireDoc(unlocked = true): mupdf.Document {
    if (!this.doc) throw new Error("No document is open");
    if (unlocked && this.locked) throw new PasswordRequiredError();
    return this.doc;
  }
}

/** Expand MuPDF's packed RGB samples (rows may be padded to `stride`) to RGBA. */
function rgbToRgba(
  rgb: Uint8ClampedArray,
  width: number,
  height: number,
  pixmap: mupdf.Pixmap,
): Uint8ClampedArray {
  const stride = pixmap.getStride();
  const n = pixmap.getNumberOfComponents();
  const out = new Uint8ClampedArray(width * height * 4);
  let o = 0;
  for (let y = 0; y < height; y++) {
    let i = y * stride;
    for (let x = 0; x < width; x++, i += n) {
      out[o++] = rgb[i] as number;
      out[o++] = rgb[i + 1] as number;
      out[o++] = rgb[i + 2] as number;
      out[o++] = 255;
    }
  }
  return out;
}

/** Create a simple blank PDF. Useful for tests and the "blank PDF" feature. */
export function createBlankPdf(pages = 1, width = 595, height = 842): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  try {
    for (let i = 0; i < pages; i++) {
      const page = pdf.addPage([0, 0, width, height], 0, {}, "");
      pdf.insertPage(-1, page);
    }
    const buffer = pdf.saveToBuffer("");
    try {
      return buffer.asUint8Array().slice();
    } finally {
      buffer.destroy();
    }
  } finally {
    pdf.destroy();
  }
}
