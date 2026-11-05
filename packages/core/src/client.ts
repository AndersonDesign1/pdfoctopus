// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Promise-based client for the PDF worker. Use this from the UI thread.

import type { WorkerRequest, WorkerResponse, WorkerResults } from "./protocol";

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export class PdfWorkerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

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
      const error = new Error(event.message || "PDF worker crashed");
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
  }

  private call<T extends WorkerRequest["type"]>(
    req: DistributiveOmit<Extract<WorkerRequest, { type: T }>, "id">,
  ): Promise<WorkerResults[T]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...req, id });
    });
  }

  open(bytes: Uint8Array) {
    return this.call<"open">({ type: "open", bytes });
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

  terminate() {
    this.worker.terminate();
  }
}
