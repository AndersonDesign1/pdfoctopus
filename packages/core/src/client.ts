// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Promise-based client for the PDF worker. Use this from the UI thread.

import type { CompressPreset } from "./compress";
import type { CreateSpec } from "./create";
import type {
  AnnotationChange,
  AnnotationSpec,
  ImageStamp,
  PagePoint,
  PageSize,
  PdfSource,
  RotationDelta,
  TextStamp,
} from "./engine";
import { EngineCrashedError, errorFromCode, isFatalEngineError } from "./errors";
import type { ExportOptions } from "./exportFiles";
import type { FieldChanges, NewField } from "./formBuild";
import type {
  LoadProgress,
  RequestType,
  WorkerMessage,
  WorkerRequest,
  WorkerResults,
} from "./protocol";
import type { PasswordSpec } from "./security";

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export interface PdfWorkerClientOptions {
  /** Called while MuPDF's WebAssembly downloads (only on the first load). */
  onLoadProgress?: (progress: LoadProgress) => void;
  /**
   * Called once if the engine crashes or fails to load, including while no call is in
   * flight. Any open document is gone at that point. Not called for `terminate()`.
   */
  onFatalError?: (error: Error) => void;
}

/** Each buffer once: transferring the same buffer twice makes postMessage throw. */
function uniqueBuffers(arrays: Uint8Array[]): ArrayBuffer[] {
  return [...new Set(arrays.map((a) => a.buffer as ArrayBuffer))];
}

export class PdfWorkerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Set once the worker has crashed or been terminated; later calls fail fast. */
  private fatal: Error | null = null;

  private readonly onFatalError?: (error: Error) => void;

  constructor(options: PdfWorkerClientOptions = {}) {
    this.onFatalError = options.onFatalError;
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data;
      if ("event" in msg) {
        options.onLoadProgress?.(msg.progress);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        p.resolve(msg.result);
        return;
      }
      const error = errorFromCode(msg.code, msg.error);
      if (isFatalEngineError(error)) {
        // The engine's memory may be corrupt (or it never loaded): discard this worker so
        // the next attempt starts clean. Other calls in flight fail with the same error.
        // Settle this request first, so nothing the owner's callback does can leave it hanging.
        p.reject(error);
        this.fail(error);
        return;
      }
      p.reject(error);
    };
    this.worker.onerror = (event) => {
      // An uncaught error or a worker that failed to start. Either way it can't be
      // trusted again: release it now. Callers should check `crashed` and create a new client.
      event.preventDefault();
      this.fail(new EngineCrashedError(event.message || "The PDF engine crashed"));
    };
    this.worker.onmessageerror = () => {
      this.fail(new EngineCrashedError("The PDF engine sent an unreadable message"));
    };
  }

  /** True once the worker has crashed or been terminated. Create a new client then. */
  get crashed(): boolean {
    return this.fatal !== null;
  }

  /** Discard the worker after a crash or failed load, and tell the owner once. */
  private fail(error: Error) {
    const first = this.fatal === null;
    this.terminateWith(error);
    if (!first) return;
    try {
      this.onFatalError?.(error);
    } catch (callbackError) {
      // A bug in the owner's callback must not break the client's own error handling.
      console.error("onFatalError callback threw", callbackError);
    }
  }

  private terminateWith(error: Error) {
    this.worker.terminate();
    this.fatal ??= error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  private call<T extends RequestType>(
    req: DistributiveOmit<Extract<WorkerRequest, { type: T }>, "id">,
    transfer: Transferable[] = [],
  ): Promise<WorkerResults[T]> {
    if (this.fatal) return Promise.reject(this.fatal);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      try {
        // Responses always arrive asynchronously, so posting before registering is safe,
        // and nothing is left pending if postMessage throws (e.g. a non-transferable buffer).
        this.worker.postMessage({ ...req, id }, transfer);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
  }

  /**
   * Download and start MuPDF now instead of on the first real request. Safe to call more
   * than once; progress is reported through `onLoadProgress`.
   */
  init() {
    return this.call<"init">({ type: "init" });
  }

  /**
   * Open a PDF. The bytes are transferred to the worker, not copied, so `bytes` is
   * unusable (detached) afterwards. Pass a copy if you still need it.
   */
  open(bytes: Uint8Array) {
    return this.call<"open">({ type: "open", bytes }, [bytes.buffer as ArrayBuffer]);
  }

  /** Unlock a password-protected document. Resolves to null if the password is wrong. */
  authenticate(password: string) {
    return this.call<"authenticate">({ type: "authenticate", password });
  }

  /** Render a page to RGBA pixels. `scale` 1 = 72 dpi. */
  renderPage(index: number, scale?: number) {
    return this.call<"render">({ type: "render", index, scale });
  }

  /** Find text (ignoring case and accents) on every page. */
  search(query: string) {
    return this.call<"search">({ type: "search", query });
  }

  /**
   * Save the open document. Incremental by default; rejects with `IncrementalSaveError`
   * if the file needs a full rewrite, which the caller must confirm with the user first.
   */
  save(incremental = true) {
    return this.call<"save">({ type: "save", incremental });
  }

  // Page edits (rotate, delete, move, insert) are each one undoable step and resolve to the
  // updated document info and undo/redo state. Extract and split return new PDFs and leave
  // the document unchanged. Pages are 0-based.

  /** Rotate pages clockwise, on top of any rotation they already have. */
  rotatePages(pages: number[], degrees: RotationDelta) {
    return this.call<"rotatePages">({ type: "rotatePages", pages, degrees });
  }

  /** Delete pages. At least one page must be left. */
  deletePages(pages: number[]) {
    return this.call<"deletePages">({ type: "deletePages", pages });
  }

  /**
   * Move pages, keeping their order, so the first lands at index `to` of the result. `to`
   * counts positions after the moved pages are taken out (0 to pageCount - pages.length).
   */
  movePages(pages: number[], to: number) {
    return this.call<"movePages">({ type: "movePages", pages, to });
  }

  /** Insert blank pages before `at` (pageCount appends), sized like the neighbouring page. */
  insertBlankPages(at: number, count?: number, size?: PageSize) {
    return this.call<"insertBlankPages">({ type: "insertBlankPages", at, count, size });
  }

  /**
   * Insert pages from other PDFs before `at`; pageCount appends, which is a merge. The
   * sources' bytes are transferred to the worker, so they're unusable afterwards.
   */
  insertPdfs(at: number, sources: PdfSource[]) {
    const transfer = uniqueBuffers(sources.map((s) => s.bytes));
    return this.call<"insertPdfs">({ type: "insertPdfs", at, sources }, transfer);
  }

  /** Copy pages, in the order given, into a new PDF. The open document is unchanged. */
  extractPages(pages: number[]) {
    return this.call<"extractPages">({ type: "extractPages", pages });
  }

  /** Split into one new PDF per group of pages. The open document is unchanged. */
  splitPages(groups: number[][]) {
    return this.call<"splitPages">({ type: "splitPages", groups });
  }

  /**
   * Put an image (a signature, initials, a date) on a page, as one undoable step. The image
   * bytes are transferred to the worker, so `stamp.image` is unusable afterwards (unless it
   * was a view on part of a larger buffer, in which case a copy is sent).
   */
  addImageStamp(stamp: ImageStamp) {
    // Transferring detaches the whole underlying buffer. If `image` is only part of it,
    // send a copy, so other views on that buffer keep working.
    const { image } = stamp;
    const whole = image.byteOffset === 0 && image.byteLength === image.buffer.byteLength;
    const bytes = whole ? image : image.slice();
    return this.call<"addImageStamp">(
      { type: "addImageStamp", stamp: { ...stamp, image: bytes } },
      [bytes.buffer as ArrayBuffer],
    );
  }

  /** Add a text stamp ("APPROVED", …) as one undoable step. */
  addTextStamp(stamp: TextStamp) {
    return this.call<"addTextStamp">({ type: "addTextStamp", stamp });
  }

  /** Add a highlight, drawing, shape, note, text box or white-out, as one undoable step. */
  addAnnotation(spec: AnnotationSpec) {
    return this.call<"addAnnotation">({ type: "addAnnotation", spec });
  }

  /** The text a highlight from `from` to `to` would cover, as quads in page points. */
  selectText(page: number, from: PagePoint, to: PagePoint) {
    return this.call<"selectText">({ type: "selectText", page, from, to });
  }

  /** Mark text (such as every search result) for redaction, as one undoable step. */
  markForRedaction(marks: { page: number; quads: number[][] }[]) {
    return this.call<"markForRedaction">({ type: "markForRedaction", marks });
  }

  /**
   * Apply every redaction mark: what's under them is removed for good, and every later save
   * rewrites the whole file. One undoable step until saved.
   */
  applyRedactions() {
    return this.call<"applyRedactions">({ type: "applyRedactions" });
  }

  /** The form field boxes on a page. */
  listFields(page: number) {
    return this.call<"listFields">({ type: "listFields", page });
  }

  /** Fill in a form field (by its id from listFields), as one undoable step. */
  setFieldValue(page: number, field: number, value: string | boolean) {
    return this.call<"setFieldValue">({ type: "setFieldValue", page, field, value });
  }

  /** Turn the form into ordinary page content, as one undoable step. */
  flattenForm() {
    return this.call<"flattenForm">({ type: "flattenForm" });
  }

  /** Add a form field (a box on a page), as one undoable step. */
  addField(spec: NewField) {
    return this.call<"addField">({ type: "addField", spec });
  }

  /** Change a field's name, whether it's required, its default value or its options. */
  updateField(page: number, field: number, changes: FieldChanges) {
    return this.call<"updateField">({ type: "updateField", page, field, changes });
  }

  /** Protect the file with a password when it's next saved, as one undoable step. */
  setPassword(spec: PasswordSpec) {
    return this.call<"setPassword">({ type: "setPassword", spec });
  }

  /** Save the file without its password, as one undoable step. */
  removePassword() {
    return this.call<"removePassword">({ type: "removePassword" });
  }

  /** A new PDF (blank pages, pictures, or text laid out on pages), as bytes. */
  createPdf(spec: CreateSpec) {
    return this.call<"createPdf">({ type: "createPdf", spec });
  }

  /** One page (0-based) as a picture, SVG, text or HTML (UTF-8), with unsaved changes. */
  exportPage(page: number, options: ExportOptions) {
    return this.call<"exportPage">({ type: "exportPage", page, options });
  }

  /** A smaller copy of the document; the open document isn't changed. */
  compressedCopy(preset: CompressPreset) {
    return this.call<"compressedCopy">({ type: "compressedCopy", preset });
  }

  /** Unlock the file's permissions with its permissions password (null if it's wrong). */
  unlockPermissions(password: string) {
    return this.call<"unlockPermissions">({ type: "unlockPermissions", password });
  }

  /** The full names of every field in the form. */
  listFieldNames() {
    return this.call<"listFieldNames">({ type: "listFieldNames" });
  }

  /** Delete a form field's box, as one undoable step. */
  deleteField(page: number, field: number) {
    return this.call<"deleteField">({ type: "deleteField", page, field });
  }

  /** The annotations on a page that can be selected, bottom first. */
  listAnnotations(page: number) {
    return this.call<"listAnnotations">({ type: "listAnnotations", page });
  }

  /** Delete an annotation (by its `id` from listAnnotations) as one undoable step. */
  deleteAnnotation(page: number, annotation: number) {
    return this.call<"deleteAnnotation">({ type: "deleteAnnotation", page, annotation });
  }

  /** Move, resize, recolour or change the text of an annotation, as one undoable step. */
  editAnnotation(page: number, annotation: number, change: AnnotationChange) {
    return this.call<"editAnnotation">({ type: "editAnnotation", page, annotation, change });
  }

  /** Undo the last page operation. Resolves to null when there was nothing to undo. */
  undo() {
    return this.call<"undo">({ type: "undo" });
  }

  /** Redo the last undone page operation. Resolves to null when there was nothing to redo. */
  redo() {
    return this.call<"redo">({ type: "redo" });
  }

  close() {
    return this.call<"close">({ type: "close" });
  }

  /** Stop the worker. Any calls still in flight are rejected. */
  terminate() {
    this.terminateWith(new Error("PDF worker was terminated"));
  }
}
