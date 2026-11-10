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

/** What undo and redo would do next, for the UI's buttons and tooltips. */
export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** E.g. "Rotate 2 pages", for "Undo Rotate 2 pages". */
  undoLabel: string | null;
  redoLabel: string | null;
}

/** Result of a page operation, undo or redo: the document as it is now. */
export interface EditResult {
  info: DocumentInfo;
  history: HistoryState;
}

/** Another PDF to insert pages from. */
export interface PdfSource {
  bytes: Uint8Array;
  /** Needed if the file is password-protected. */
  password?: string;
  /** 0-based pages to take, in order. All pages when omitted. */
  pages?: number[];
}

/** A clockwise rotation in degrees. */
export type RotationDelta = 90 | 180 | 270 | -90;

/** One undoable step. Each step knows how to reverse itself, so no copies are kept. */
interface Step {
  label: string;
  undo(): void;
  redo(): void;
}

/** Keys a page can inherit from its parents in the page tree (PDF 1.7, 7.7.3.4). */
const INHERITABLE_KEYS = ["Resources", "MediaBox", "CropBox", "Rotate"] as const;

/** Upper bound on undo steps kept. Old steps are dropped first. */
export const MAX_HISTORY = 200;

/** Upper bound on search hits returned at once, so a common word can't flood the UI. */
export const MAX_SEARCH_HITS = 5000;

export class PdfEngine {
  private doc: mupdf.Document | null = null;
  /** MuPDF's needsPassword() stays true after a successful unlock, so track it here. */
  private locked = false;
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];

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
          // Collect one hit past the limit, so exactly MAX_SEARCH_HITS isn't reported as more.
          if (hits.length === MAX_SEARCH_HITS) return { hits, truncated: true };
          hits.push({ page: i, quads });
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
    this.undoStack = [];
    this.redoStack = [];
  }

  // ---------------------------------------------------------------------------------------
  // Page operations. Each one is a single undoable step and returns the updated document.
  // Pages are 0-based. Page objects removed from the page tree are kept by the history (not
  // copied), so undo puts the very same objects back.

  /** Rotate pages clockwise by `degrees`, on top of any rotation they already have. */
  rotatePages(pages: readonly number[], degrees: RotationDelta): EditResult {
    const pdf = this.requirePdf();
    const indices = this.checkPages(pages);
    if (![90, 180, 270, -90].includes(degrees)) throw new Error("Rotate by 90, 180 or 270 degrees");
    const objects = indices.map((i) => pdf.findPage(i));
    const before = objects.map((obj) => readRotation(obj));
    const apply = (rotations: number[]) => {
      objects.forEach((obj, i) => {
        obj.put("Rotate", rotations[i] as number);
      });
    };
    const after = before.map((r) => normaliseRotation(r + degrees));
    return this.run({
      label: `Rotate ${countLabel(indices.length)}`,
      undo: () => apply(before),
      redo: () => apply(after),
    });
  }

  /** Delete pages. At least one page must be left. */
  deletePages(pages: readonly number[]): EditResult {
    const pdf = this.requirePdf();
    const indices = this.checkPages(pages);
    if (indices.length >= pdf.countPages()) {
      throw new Error("A PDF needs at least one page, so not every page can be deleted");
    }
    let removed: PageEntry[] = [];
    return this.run({
      label: `Delete ${countLabel(indices.length)}`,
      redo: () => {
        removed = this.removePages(indices);
      },
      undo: () => this.insertPages(removed),
    });
  }

  /**
   * Move pages, keeping their order, so the first one ends up at index `to` of the result.
   * `to` counts positions in the document after the moved pages are taken out, so it runs
   * from 0 to pageCount - pages.length.
   */
  movePages(pages: readonly number[], to: number): EditResult {
    const pdf = this.requirePdf();
    const indices = this.checkPages(pages);
    const maxTo = pdf.countPages() - indices.length;
    if (!Number.isInteger(to) || to < 0 || to > maxTo) {
      throw new Error(`Move target ${to} is out of range (0 to ${maxTo})`);
    }
    const unchanged = indices.every((p, i) => p === to + i);
    let original: PageEntry[] = [];
    return this.run(
      {
        label: `Move ${countLabel(indices.length)}`,
        redo: () => {
          original = this.removePages(indices);
          this.insertPages(original.map((e, i) => ({ index: to + i, object: e.object })));
        },
        undo: () => {
          const moved = this.removePages(original.map((_, i) => to + i));
          this.insertPages(
            original.map((e, i) => ({
              index: e.index,
              object: moved[i]?.object as mupdf.PDFObject,
            })),
          );
        },
      },
      unchanged,
    );
  }

  /**
   * Insert `count` blank pages before index `at` (pageCount appends). The size defaults to
   * that of the neighbouring page, or A4 in an empty document.
   */
  insertBlankPages(at: number, count = 1, size?: PageSize): EditResult {
    const pdf = this.requirePdf();
    const pageCount = pdf.countPages();
    this.checkInsertAt(at, pageCount);
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      throw new Error("Insert between 1 and 1000 blank pages");
    }
    const { width, height } = size ?? this.neighbourSize(at, pageCount);
    if (!(width > 0 && height > 0 && width <= 14400 && height <= 14400)) {
      throw new Error("Page size must be between 1 and 14400 points");
    }
    const objects: mupdf.PDFObject[] = [];
    for (let i = 0; i < count; i++) {
      objects.push(pdf.addPage([0, 0, width, height], 0, pdf.newDictionary(), ""));
    }
    return this.insertStep(`Insert ${countLabel(count, "blank page")}`, at, objects);
  }

  /** Insert pages from other PDFs before index `at` (pageCount appends, which is a merge). */
  insertPdfs(at: number, sources: readonly PdfSource[]): EditResult {
    const pdf = this.requirePdf();
    this.checkInsertAt(at, pdf.countPages());
    if (sources.length === 0) throw new Error("Choose at least one PDF to insert");
    // Graft every page first, at the end of the document, so a failure part-way through
    // (a bad file, a wrong password) can be cleaned up without touching existing pages.
    const start = pdf.countPages();
    const opened: mupdf.Document[] = [];
    try {
      for (const source of sources) {
        // A graft map shares resources (fonts, images) between pages of one source file.
        const graft = pdf.newGraftMap();
        const src = openSource(source);
        opened.push(src);
        const srcPdf = src.asPDF() as mupdf.PDFDocument;
        const srcCount = srcPdf.countPages();
        const wanted = source.pages ?? Array.from({ length: srcCount }, (_, i) => i);
        for (const p of wanted) {
          if (!Number.isInteger(p) || p < 0 || p >= srcCount) {
            throw new Error(`Page ${p + 1} doesn't exist in the file being inserted`);
          }
          graft.graftPage(-1, srcPdf, p);
        }
      }
    } catch (err) {
      while (pdf.countPages() > start) pdf.deletePage(pdf.countPages() - 1);
      throw err;
    } finally {
      for (const src of opened) src.destroy();
    }
    const added = pdf.countPages() - start;
    if (added === 0) throw new Error("There were no pages to insert");
    // Take the new pages back out, then insert them where they belong as one undoable step.
    const objects = this.removePages(Array.from({ length: added }, (_, i) => start + i)).map(
      (e) => e.object,
    );
    const what = sources.length === 1 ? countLabel(added) : `${sources.length} files`;
    return this.insertStep(at === start ? `Add ${what}` : `Insert ${what}`, at, objects);
  }

  /** Copy pages, in the order given, into a new PDF. The open document is unchanged. */
  extractPages(pages: readonly number[]): Uint8Array {
    const pdf = this.requirePdf();
    if (pages.length === 0) throw new Error("Select at least one page");
    const count = pdf.countPages();
    for (const p of pages) {
      if (!Number.isInteger(p) || p < 0 || p >= count)
        throw new Error(`Page ${p + 1} doesn't exist`);
    }
    const out = new mupdf.PDFDocument();
    try {
      const graft = out.newGraftMap();
      for (const p of pages) graft.graftPage(-1, pdf, p);
      const buffer = out.saveToBuffer("garbage");
      try {
        return buffer.asUint8Array().slice();
      } finally {
        buffer.destroy();
      }
    } finally {
      out.destroy();
    }
  }

  /** Split into one new PDF per group of pages. The open document is unchanged. */
  splitPages(groups: readonly (readonly number[])[]): Uint8Array[] {
    if (groups.length === 0) throw new Error("Choose at least one range to split into");
    return groups.map((group) => this.extractPages(group));
  }

  /** Undo the last page operation. Returns null when there is nothing to undo. */
  undo(): EditResult | null {
    this.requirePdf();
    const step = this.undoStack.pop();
    if (!step) return null;
    step.undo();
    this.redoStack.push(step);
    return this.editResult();
  }

  /** Redo the last undone page operation. Returns null when there is nothing to redo. */
  redo(): EditResult | null {
    this.requirePdf();
    const step = this.redoStack.pop();
    if (!step) return null;
    step.redo();
    this.undoStack.push(step);
    return this.editResult();
  }

  history(): HistoryState {
    const top = this.undoStack[this.undoStack.length - 1];
    const next = this.redoStack[this.redoStack.length - 1];
    return {
      canUndo: top !== undefined,
      canRedo: next !== undefined,
      undoLabel: top?.label ?? null,
      redoLabel: next?.label ?? null,
    };
  }

  /** Do a step for the first time and record it, unless it changes nothing. */
  private run(step: Step, noOp = false): EditResult {
    if (noOp) return this.editResult();
    step.redo();
    this.undoStack.push(step);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    return this.editResult();
  }

  private insertStep(label: string, at: number, objects: mupdf.PDFObject[]): EditResult {
    const entries = objects.map((object, i) => ({ index: at + i, object }));
    return this.run({
      label,
      redo: () => this.insertPages(entries),
      undo: () => this.removePages(entries.map((e) => e.index)),
    });
  }

  private editResult(): EditResult {
    return { info: this.info(), history: this.history() };
  }

  /**
   * Take pages out of the page tree (indices ascending) and return them with their old
   * indices. Inherited attributes are copied onto each page first, so it looks the same
   * wherever it is put back.
   */
  private removePages(indices: readonly number[]): PageEntry[] {
    const pdf = this.requirePdf();
    const entries = indices.map((index) => {
      const object = pdf.findPage(index);
      flattenInherited(object);
      return { index, object };
    });
    for (let i = entries.length - 1; i >= 0; i--) pdf.deletePage((entries[i] as PageEntry).index);
    return entries;
  }

  /** Put pages back into the page tree. Entries must be in ascending index order. */
  private insertPages(entries: readonly PageEntry[]): void {
    const pdf = this.requirePdf();
    for (const { index, object } of entries) {
      pdf.insertPage(index >= pdf.countPages() ? -1 : index, object);
    }
  }

  /** Validate page indices; returns them sorted and without duplicates. */
  private checkPages(pages: readonly number[]): number[] {
    const count = this.requirePdf().countPages();
    if (pages.length === 0) throw new Error("Select at least one page");
    for (const p of pages) {
      if (!Number.isInteger(p) || p < 0 || p >= count)
        throw new Error(`Page ${p + 1} doesn't exist`);
    }
    return [...new Set(pages)].sort((a, b) => a - b);
  }

  private checkInsertAt(at: number, pageCount: number): void {
    if (!Number.isInteger(at) || at < 0 || at > pageCount) {
      throw new Error(`Insert position ${at} is out of range (0 to ${pageCount})`);
    }
  }

  /** Size of the page before `at` (or after it, when inserting at the start). */
  private neighbourSize(at: number, pageCount: number): PageSize {
    if (pageCount === 0) return { width: 595, height: 842 };
    // The size as shown, after the neighbour's own rotation: the new page has no rotation, so
    // this makes it look the same way round as the page next to it.
    const page = this.requireDoc().loadPage(Math.min(Math.max(at - 1, 0), pageCount - 1));
    try {
      const [x0, y0, x1, y1] = page.getBounds();
      return { width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
    } finally {
      page.destroy();
    }
  }

  private requirePdf(): mupdf.PDFDocument {
    const pdf = this.requireDoc().asPDF();
    if (!pdf) throw new Error("Not a PDF document");
    return pdf;
  }

  /** The open document; by default it must also be unlocked. */
  private requireDoc(unlocked = true): mupdf.Document {
    if (!this.doc) throw new Error("No document is open");
    if (unlocked && this.locked) throw new PasswordRequiredError();
    return this.doc;
  }
}

interface PageEntry {
  index: number;
  object: mupdf.PDFObject;
}

/** Open another PDF to insert from, unlocking it if needed. */
function openSource(source: PdfSource): mupdf.Document {
  const doc = mupdf.Document.openDocument(source.bytes, "application/pdf");
  try {
    if (!doc.asPDF()) throw new Error("The file being inserted isn't a PDF");
    if (doc.needsPassword() && doc.authenticatePassword(source.password ?? "") === 0) {
      throw new PasswordRequiredError("The file being inserted is password-protected");
    }
    return doc;
  } catch (err) {
    doc.destroy();
    throw err;
  }
}

function readRotation(page: mupdf.PDFObject): number {
  const value = page.getInheritable("Rotate");
  return value.isNumber() ? normaliseRotation(value.asNumber()) : 0;
}

/** Bring any multiple of 90 into 0, 90, 180 or 270. Other values count as 0, like MuPDF. */
function normaliseRotation(degrees: number): number {
  const r = ((Math.round(degrees) % 360) + 360) % 360;
  return r % 90 === 0 ? r : 0;
}

/** Copy attributes the page inherits from its parents onto the page itself. */
function flattenInherited(page: mupdf.PDFObject): void {
  for (const key of INHERITABLE_KEYS) {
    if (!page.get(key).isNull()) continue;
    const inherited = page.getInheritable(key);
    if (!inherited.isNull()) page.put(key, inherited);
  }
}

/** "1 page", "3 pages". */
function countLabel(n: number, noun = "page"): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
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
