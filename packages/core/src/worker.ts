// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Web Worker that owns the MuPDF engine, so heavy PDF work never blocks the UI.
//
// The message handler is registered synchronously, and MuPDF is loaded lazily with a
// dynamic import. MuPDF initialises its WebAssembly with a top-level await, so a static
// import would delay the handler and messages sent in the meantime could be lost.

import type { PdfEngine } from "./engine";
import type { WorkerRequest, WorkerResponse } from "./protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;

let enginePromise: Promise<PdfEngine> | undefined;
function getEngine(): Promise<PdfEngine> {
  enginePromise ??= import("./engine").then((m) => new m.PdfEngine());
  return enginePromise;
}

async function handle(req: WorkerRequest): Promise<unknown> {
  const engine = await getEngine();
  switch (req.type) {
    case "open":
      return engine.open(req.bytes);
    case "render":
      return engine.renderPage(req.index, req.scale);
    case "save":
      return engine.save({ incremental: req.incremental });
    case "close":
      engine.close();
      return null;
  }
}

// Requests are processed one at a time, in order.
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  queue = queue.then(async () => {
    let response: WorkerResponse;
    try {
      response = { id: req.id, ok: true, result: await handle(req) };
    } catch (err) {
      response = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    scope.postMessage(response);
  });
};
