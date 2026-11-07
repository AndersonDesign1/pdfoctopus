// SPDX-License-Identifier: AGPL-3.0-or-later

export { PdfWorkerClient, type PdfWorkerClientOptions } from "./client";
export type {
  DocumentInfo,
  DocumentMetadata,
  OpenResult,
  PageSize,
  RenderedPage,
  SearchHit,
} from "./engine";
export {
  EngineCrashedError,
  EngineLoadError,
  IncrementalSaveError,
  isFatalEngineError,
  PasswordRequiredError,
  type PdfErrorCode,
} from "./errors";
export type {
  LoadProgress,
  WorkerEvent,
  WorkerMessage,
  WorkerRequest,
  WorkerResponse,
  WorkerResults,
} from "./protocol";
