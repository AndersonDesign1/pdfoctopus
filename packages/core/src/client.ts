// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Promise-based client for the PDF worker. Use this from the UI thread.

import type { PageSize, PdfSource, RotationDelta } from "./engine";
import { EngineCrashedError, errorFromCode, isFatalEngineError } from "./errors";
import type {
  LoadProgress,
  RequestType,
  WorkerMessage,
  WorkerRequest,
  WorkerResults,
} from "./protocol";

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

  // Page operations. Each is one undoable step and resolves to the updated document info
  // and undo/redo state. Pages are 0-based.

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
