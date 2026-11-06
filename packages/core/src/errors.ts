// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Error types shared by the engine (in the worker) and the client (on the UI thread).
// Kept free of MuPDF imports so the UI can import them cheaply.

/** Machine-readable error codes sent across the worker boundary. */
export type PdfErrorCode =
  | "incremental-save-unavailable"
  | "engine-crashed"
  | "engine-load-failed"
  | "unknown";

/** Thrown when a file can't be saved incrementally and a full rewrite would be needed. */
export class IncrementalSaveError extends Error {
  readonly code = "incremental-save-unavailable" as const;
  constructor(message = "This PDF can't be saved incrementally; a full rewrite is required") {
    super(message);
    this.name = "IncrementalSaveError";
  }
}

/**
 * The PDF engine crashed (a WebAssembly abort, out of memory, or the worker itself died).
 * The worker is discarded; the next call on a fresh client starts a new one.
 */
export class EngineCrashedError extends Error {
  readonly code = "engine-crashed" as const;
  constructor(message = "The PDF engine crashed") {
    super(message);
    this.name = "EngineCrashedError";
  }
}

/** The PDF engine (MuPDF WebAssembly) could not be downloaded or started. */
export class EngineLoadError extends Error {
  readonly code = "engine-load-failed" as const;
  constructor(message = "The PDF engine could not be loaded") {
    super(message);
    this.name = "EngineLoadError";
  }
}

/** Errors after which the worker can't be trusted again and must be replaced. */
export function isFatalEngineError(err: unknown): boolean {
  return err instanceof EngineCrashedError || err instanceof EngineLoadError;
}

export function errorCode(err: unknown): PdfErrorCode {
  if (
    err instanceof IncrementalSaveError ||
    err instanceof EngineCrashedError ||
    err instanceof EngineLoadError
  ) {
    return err.code;
  }
  // A WebAssembly trap (abort, out of memory, unreachable) can leave MuPDF's memory in a
  // broken state, so treat it as a crash rather than an ordinary error.
  if (typeof WebAssembly !== "undefined" && err instanceof WebAssembly.RuntimeError) {
    return "engine-crashed";
  }
  return "unknown";
}

/** Rebuild the right error type on the UI thread from what the worker sent. */
export function errorFromCode(code: PdfErrorCode, message: string): Error {
  switch (code) {
    case "incremental-save-unavailable":
      return new IncrementalSaveError(message);
    case "engine-crashed":
      return new EngineCrashedError(message);
    case "engine-load-failed":
      return new EngineLoadError(message);
    default:
      return new Error(message);
  }
}
