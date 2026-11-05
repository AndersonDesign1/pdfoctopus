// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Error types shared by the engine (in the worker) and the client (on the UI thread).
// Kept free of MuPDF imports so the UI can import them cheaply.

/** Machine-readable error codes sent across the worker boundary. */
export type PdfErrorCode = "incremental-save-unavailable" | "unknown";

/** Thrown when a file can't be saved incrementally and a full rewrite would be needed. */
export class IncrementalSaveError extends Error {
  readonly code = "incremental-save-unavailable" as const;
  constructor(message = "This PDF can't be saved incrementally; a full rewrite is required") {
    super(message);
    this.name = "IncrementalSaveError";
  }
}

export function errorCode(err: unknown): PdfErrorCode {
  return err instanceof IncrementalSaveError ? err.code : "unknown";
}

/** Rebuild the right error type on the UI thread from what the worker sent. */
export function errorFromCode(code: PdfErrorCode, message: string): Error {
  return code === "incremental-save-unavailable"
    ? new IncrementalSaveError(message)
    : new Error(message);
}
