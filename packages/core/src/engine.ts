// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thin, synchronous wrapper around MuPDF (WebAssembly). It runs inside the Web Worker
// (see worker.ts) in the browser, and directly in Node for tests.

import * as mupdf from "mupdf";
import { IncrementalSaveError } from "./errors";

export interface RenderedPage {
  width: number;
  height: number;
  /** PNG-encoded image bytes. */
  png: Uint8Array;
}

export class PdfEngine {
  private doc: mupdf.Document | null = null;

  open(bytes: Uint8Array): { pageCount: number } {
    this.close();
    this.doc = mupdf.Document.openDocument(bytes, "application/pdf");
    return { pageCount: this.doc.countPages() };
  }

  get pageCount(): number {
    return this.requireDoc().countPages();
  }

  /** Render a page (0-based) to PNG. `scale` 1 = 72 dpi. */
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
        return { width: pixmap.getWidth(), height: pixmap.getHeight(), png: pixmap.asPNG() };
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
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
  }

  private requireDoc(): mupdf.Document {
    if (!this.doc) throw new Error("No document is open");
    return this.doc;
  }
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
