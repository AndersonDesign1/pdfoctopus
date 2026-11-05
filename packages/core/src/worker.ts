// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Web Worker that owns the MuPDF engine, so heavy PDF work never blocks the UI.
//
// The message handler is registered synchronously, and MuPDF is loaded lazily with a
// dynamic import. MuPDF initialises its WebAssembly with a top-level await, so a static
// import would delay the handler and messages sent in the meantime could be lost.

import type { PdfEngine } from "./engine";
import { errorCode } from "./errors";
import type { RequestType, WorkerRequest, WorkerResponse, WorkerSuccess } from "./protocol";

// The minimal worker-scope API we use. Typed here so the shared TypeScript config
// doesn't need to mix the DOM and WebWorker libraries.
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

let enginePromise: Promise<PdfEngine> | undefined;
function getEngine(): Promise<PdfEngine> {
  enginePromise ??= import("./engine").then(
    (m) => new m.PdfEngine(),
    (err) => {
      // Don't cache a failed load: let the next request try again.
      enginePromise = undefined;
      throw err;
    },
  );
  return enginePromise;
}

function success<K extends RequestType>(
  id: number,
  type: K,
  result: WorkerSuccess<K>["result"],
): WorkerSuccess<K> {
  return { id, ok: true, type, result } as WorkerSuccess<K>;
}

async function handle(req: WorkerRequest): Promise<WorkerSuccess> {
  const engine = await getEngine();
  switch (req.type) {
    case "open":
      return success(req.id, "open", engine.open(req.bytes));
    case "render":
      return success(req.id, "render", engine.renderPage(req.index, req.scale));
    case "save":
      return success(req.id, "save", engine.save({ incremental: req.incremental }));
    case "close":
      engine.close();
      return success(req.id, "close", null);
  }
}

/** Large binary results are transferred, not copied, back to the UI thread. */
function transferables(res: WorkerSuccess): Transferable[] {
  if (res.type === "render") return [res.result.png.buffer as ArrayBuffer];
  if (res.type === "save") return [res.result.buffer as ArrayBuffer];
  return [];
}

// Requests are processed one at a time, in order.
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event) => {
  const req = event.data;
  queue = queue.then(async () => {
    try {
      const res = await handle(req);
      scope.postMessage(res, transferables(res));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      scope.postMessage({ id: req.id, ok: false, code: errorCode(err), error }, []);
    }
  });
};
