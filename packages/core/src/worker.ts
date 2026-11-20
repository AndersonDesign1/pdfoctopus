// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Web Worker that owns the MuPDF engine, so heavy PDF work never blocks the UI.
//
// The message handler is registered synchronously, and MuPDF is loaded lazily with a
// dynamic import. MuPDF initialises its WebAssembly with a top-level await, so a static
// import would delay the handler and messages sent in the meantime could be lost.

import type { PdfEngine } from "./engine";
import { EngineLoadError, errorCode } from "./errors";
import { withWasmProgress } from "./loadProgress";
import type {
  LoadProgress,
  RequestType,
  WorkerMessage,
  WorkerRequest,
  WorkerSuccess,
} from "./protocol";

/**
 * Uncompressed size of MuPDF's .wasm file, injected by the app's bundler (see
 * apps/web/vite.config.ts). Used for the progress bar when the server compresses the file
 * and so doesn't send a usable Content-Length.
 */
declare const __MUPDF_WASM_SIZE__: number | undefined;
const WASM_SIZE = typeof __MUPDF_WASM_SIZE__ === "number" ? __MUPDF_WASM_SIZE__ : null;

// The minimal worker-scope API we use. Typed here so the shared TypeScript config
// doesn't need to mix the DOM and WebWorker libraries.
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerMessage, transfer: Transferable[]): void;
  fetch: typeof fetch;
}
const scope = self as unknown as WorkerScope;

let enginePromise: Promise<PdfEngine> | undefined;

/**
 * Load MuPDF once. A failed load is reported as fatal: the browser caches a module whose
 * top-level code failed, so retrying inside this worker would fail again. The client
 * replaces the worker instead.
 */
function getEngine(): Promise<PdfEngine> {
  enginePromise ??= (async () => {
    const originalFetch = scope.fetch;
    const report = (progress: LoadProgress) =>
      scope.postMessage({ event: "load-progress", progress }, []);
    scope.fetch = withWasmProgress(originalFetch.bind(scope), report, WASM_SIZE);
    try {
      const { PdfEngine } = await import("./engine");
      return new PdfEngine();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new EngineLoadError(`The PDF engine could not be loaded: ${reason}`);
    } finally {
      scope.fetch = originalFetch;
    }
  })();
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
    case "init":
      return success(req.id, "init", null);
    case "open":
      return success(req.id, "open", engine.open(req.bytes));
    case "authenticate":
      return success(req.id, "authenticate", engine.authenticate(req.password));
    case "render":
      return success(req.id, "render", engine.renderPage(req.index, req.scale));
    case "search":
      return success(req.id, "search", engine.search(req.query));
    case "save":
      return success(req.id, "save", engine.save({ incremental: req.incremental }));
    case "rotatePages":
      return success(req.id, "rotatePages", engine.rotatePages(req.pages, req.degrees));
    case "deletePages":
      return success(req.id, "deletePages", engine.deletePages(req.pages));
    case "movePages":
      return success(req.id, "movePages", engine.movePages(req.pages, req.to));
    case "insertBlankPages":
      return success(
        req.id,
        "insertBlankPages",
        engine.insertBlankPages(req.at, req.count, req.size),
      );
    case "insertPdfs":
      return success(req.id, "insertPdfs", engine.insertPdfs(req.at, req.sources));
    case "extractPages":
      return success(req.id, "extractPages", engine.extractPages(req.pages));
    case "splitPages":
      return success(req.id, "splitPages", engine.splitPages(req.groups));
    case "addImageStamp":
      return success(req.id, "addImageStamp", engine.addImageStamp(req.stamp));
    case "addTextStamp":
      return success(req.id, "addTextStamp", engine.addTextStamp(req.stamp));
    case "addAnnotation":
      return success(req.id, "addAnnotation", engine.addAnnotation(req.spec));
    case "selectText":
      return success(req.id, "selectText", engine.selectText(req.page, req.from, req.to));
    case "markForRedaction":
      return success(req.id, "markForRedaction", engine.markForRedaction(req.marks));
    case "applyRedactions":
      return success(req.id, "applyRedactions", engine.applyRedactions());
    case "listFields":
      return success(req.id, "listFields", engine.listFields(req.page));
    case "setFieldValue":
      return success(req.id, "setFieldValue", engine.setFieldValue(req.page, req.field, req.value));
    case "flattenForm":
      return success(req.id, "flattenForm", engine.flattenForm());
    case "addField":
      return success(req.id, "addField", engine.addField(req.spec));
    case "updateField":
      return success(req.id, "updateField", engine.updateField(req.page, req.field, req.changes));
    case "setPassword":
      return success(req.id, "setPassword", engine.setPassword(req.spec));
    case "removePassword":
      return success(req.id, "removePassword", engine.removePassword());
    case "createPdf": {
      // Loaded with the engine (after it), like everything that uses MuPDF.
      const { createPdf } = await import("./create");
      return success(req.id, "createPdf", createPdf(req.spec));
    }
    case "exportPage":
      return success(req.id, "exportPage", engine.exportPage(req.page, req.options));
    case "compressedCopy":
      return success(req.id, "compressedCopy", engine.compressedCopy(req.preset));
    case "unlockPermissions":
      return success(req.id, "unlockPermissions", engine.unlockPermissions(req.password));
    case "listFieldNames":
      return success(req.id, "listFieldNames", engine.listFieldNames());
    case "signatureFields":
      return success(req.id, "signatureFields", engine.signatureFields());
    case "prepareSignature":
      return success(req.id, "prepareSignature", engine.prepareSignature(req.spec));
    case "finishSignature":
      return success(req.id, "finishSignature", engine.finishSignature(req.signature));
    case "deleteField":
      return success(req.id, "deleteField", engine.deleteField(req.page, req.field));
    case "listAnnotations":
      return success(req.id, "listAnnotations", engine.listAnnotations(req.page));
    case "deleteAnnotation":
      return success(req.id, "deleteAnnotation", engine.deleteAnnotation(req.page, req.annotation));
    case "editAnnotation":
      return success(
        req.id,
        "editAnnotation",
        engine.editAnnotation(req.page, req.annotation, req.change),
      );
    case "undo":
      return success(req.id, "undo", engine.undo());
    case "redo":
      return success(req.id, "redo", engine.redo());
    case "close":
      engine.close();
      return success(req.id, "close", null);
  }
}

/** Large binary results are transferred, not copied, back to the UI thread. */
function transferables(res: WorkerSuccess): Transferable[] {
  if (res.type === "render") return [res.result.pixels.buffer as ArrayBuffer];
  if (
    res.type === "save" ||
    res.type === "extractPages" ||
    res.type === "createPdf" ||
    res.type === "exportPage"
  ) {
    return [res.result.buffer as ArrayBuffer];
  }
  if (res.type === "splitPages") return res.result.map((b) => b.buffer as ArrayBuffer);
  if (res.type === "compressedCopy") return [res.result.bytes.buffer as ArrayBuffer];
  if (res.type === "prepareSignature" || res.type === "finishSignature") {
    return [res.result.bytes.buffer as ArrayBuffer];
  }
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
