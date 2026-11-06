// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Promise-based client for the PDF worker. Use this from the UI thread.

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
}

export class PdfWorkerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Set once the worker has crashed or been terminated; later calls fail fast. */
  private fatal: Error | null = null;

  constructor(options: PdfWorkerClientOptions = {}) {
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
        this.terminateWith(error);
      }
      p.reject(error);
    };
    this.worker.onerror = (event) => {
      // An uncaught error or a worker that failed to start. Either way it can't be
      // trusted again: release it now. Callers should check `crashed` and create a new client.
      event.preventDefault();
      this.terminateWith(new EngineCrashedError(event.message || "The PDF engine crashed"));
    };
    this.worker.onmessageerror = () => {
      this.terminateWith(new EngineCrashedError("The PDF engine sent an unreadable message"));
    };
  }

  /** True once the worker has crashed or been terminated. Create a new client then. */
  get crashed(): boolean {
    return this.fatal !== null;
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

  renderPage(index: number, scale?: number) {
    return this.call<"render">({ type: "render", index, scale });
  }

  /**
   * Save the open document. Incremental by default; rejects with `IncrementalSaveError`
   * if the file needs a full rewrite, which the caller must confirm with the user first.
   */
  save(incremental = true) {
    return this.call<"save">({ type: "save", incremental });
  }

  close() {
    return this.call<"close">({ type: "close" });
  }

  /** Stop the worker. Any calls still in flight are rejected. */
  terminate() {
    this.terminateWith(new Error("PDF worker was terminated"));
  }
}
