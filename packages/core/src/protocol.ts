// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Messages exchanged between the UI thread and the PDF worker.

import type {
  DocumentInfo,
  EditResult,
  OpenResult,
  PageSize,
  PdfSource,
  RenderedPage,
  RotationDelta,
  SearchHit,
} from "./engine";
import type { PdfErrorCode } from "./errors";

export type WorkerRequest =
  | { id: number; type: "init" }
  | { id: number; type: "open"; bytes: Uint8Array }
  | { id: number; type: "authenticate"; password: string }
  | { id: number; type: "render"; index: number; scale?: number }
  | { id: number; type: "search"; query: string }
  | { id: number; type: "save"; incremental?: boolean }
  | { id: number; type: "rotatePages"; pages: number[]; degrees: RotationDelta }
  | { id: number; type: "deletePages"; pages: number[] }
  | { id: number; type: "movePages"; pages: number[]; to: number }
  | { id: number; type: "insertBlankPages"; at: number; count?: number; size?: PageSize }
  | { id: number; type: "insertPdfs"; at: number; sources: PdfSource[] }
  | { id: number; type: "extractPages"; pages: number[] }
  | { id: number; type: "splitPages"; groups: number[][] }
  | { id: number; type: "undo" }
  | { id: number; type: "redo" }
  | { id: number; type: "close" };

export type RequestType = WorkerRequest["type"];

export interface WorkerResults {
  init: null;
  open: OpenResult;
  authenticate: DocumentInfo | null;
  render: RenderedPage;
  search: { hits: SearchHit[]; truncated: boolean };
  save: Uint8Array;
  rotatePages: EditResult;
  deletePages: EditResult;
  movePages: EditResult;
  insertBlankPages: EditResult;
  insertPdfs: EditResult;
  extractPages: Uint8Array;
  splitPages: Uint8Array[];
  undo: EditResult | null;
  redo: EditResult | null;
  close: null;
}

/** Successful response, typed by the request it answers. */
export type WorkerSuccess<K extends RequestType = RequestType> = K extends RequestType
  ? { id: number; ok: true; type: K; result: WorkerResults[K] }
  : never;

export type WorkerResponse =
  | WorkerSuccess
  | { id: number; ok: false; code: PdfErrorCode; error: string };

/** Progress of the one-off MuPDF WebAssembly download. */
export interface LoadProgress {
  /** Bytes received so far (uncompressed). */
  loaded: number;
  /** Expected total in bytes, or null when unknown. */
  total: number | null;
}

/** Unsolicited messages from the worker (not answers to a request). */
export type WorkerEvent = { event: "load-progress"; progress: LoadProgress };

export type WorkerMessage = WorkerResponse | WorkerEvent;
