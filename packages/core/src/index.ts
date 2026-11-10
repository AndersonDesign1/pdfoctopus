// SPDX-License-Identifier: AGPL-3.0-or-later

export { PdfWorkerClient, type PdfWorkerClientOptions } from "./client";
export type {
  DocumentInfo,
  DocumentMetadata,
  EditResult,
  HistoryState,
  OpenResult,
  PageSize,
  PdfSource,
  RenderedPage,
  RotationDelta,
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
export { describePages, parsePageRanges, splitEvery, splitSingle } from "./pageRanges";
export type {
  LoadProgress,
  WorkerEvent,
  WorkerMessage,
  WorkerRequest,
  WorkerResponse,
  WorkerResults,
} from "./protocol";
