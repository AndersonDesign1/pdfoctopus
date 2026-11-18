// SPDX-License-Identifier: AGPL-3.0-or-later

export { PdfWorkerClient, type PdfWorkerClientOptions } from "./client";
export type {
  AnnotationChange,
  AnnotationInfo,
  AnnotationKind,
  AnnotationSpec,
  DocumentInfo,
  DocumentMetadata,
  EditResult,
  HistoryState,
  ImageStamp,
  OpenResult,
  PagePoint,
  PageSize,
  PdfSource,
  RenderedPage,
  RgbColor,
  RotationDelta,
  SearchHit,
  StampKind,
  TextStamp,
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
export {
  BORDER as STAMP_BORDER,
  layoutStamp,
  MAX_STAMP_DETAIL,
  MAX_STAMP_TEXT,
  RADIUS as STAMP_RADIUS,
  type StampLayout,
  stampName,
} from "./stampRules";
