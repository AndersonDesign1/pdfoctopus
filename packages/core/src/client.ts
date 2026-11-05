// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Promise-based client for the PDF worker. Use this from the UI thread.

import type { RequestType, WorkerRequest, WorkerResponse, WorkerResults } from "./protocol";

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export class PdfWorkerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Set once the worker has crashed or been terminated; later calls fail fast. */
  private fatal: Error | null = null;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const res = event.data;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(new Error(res.error));
    };
    this.worker.onerror = (event) => {
      this.fail(new Error(event.message || "PDF worker crashed"));
    };
  }

  private fail(error: Error) {
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
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...req, id }, transfer);
    });
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

  save(incremental = true) {
    return this.call<"save">({ type: "save", incremental });
  }

  close() {
    return this.call<"close">({ type: "close" });
  }

  /** Stop the worker. Any calls still in flight are rejected. */
  terminate() {
    this.worker.terminate();
    this.fail(new Error("PDF worker was terminated"));
  }
}
