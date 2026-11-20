// SPDX-License-Identifier: AGPL-3.0-or-later

export { PdfWorkerClient, type PdfWorkerClientOptions } from "./client";
export type { CompressPreset } from "./compress";
export type { CreateSpec, PaperSize, PictureLayout, PictureSpec, TextKind } from "./create";
export type {
  AnnotationChange,
  AnnotationInfo,
  AnnotationKind,
  AnnotationSpec,
  DocumentInfo,
  DocumentMetadata,
  EditResult,
  FormField,
  FormInfo,
  HistoryState,
  ImageStamp,
  OpenResult,
  PagePoint,
  PageSize,
  PdfSource,
  PreparedSignature,
  RedactionResult,
  RenderedPage,
  RgbColor,
  RotationDelta,
  SearchHit,
  SignatureSpec,
  SignedResult,
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
export type { FieldChanges, NewField, NewFieldKind } from "./formBuild";
export type { FieldKind } from "./forms";
export { describePages, parsePageRanges, splitEvery, splitSingle } from "./pageRanges";
export type {
  LoadProgress,
  WorkerEvent,
  WorkerMessage,
  WorkerRequest,
  WorkerResponse,
  WorkerResults,
} from "./protocol";
export type { PasswordSpec, Permissions, SecurityInfo } from "./security";
export {
  type ByteRange,
  DEFAULT_SIGNATURE_SIZE,
  MAX_SIGNATURE_SIZE,
} from "./signature";
export type { SignatureFieldInfo } from "./signatureField";
export {
  BORDER as STAMP_BORDER,
  cleanStampText,
  layoutStamp,
  MAX_STAMP_DETAIL,
  MAX_STAMP_TEXT,
  RADIUS as STAMP_RADIUS,
  type StampLayout,
  stampName,
} from "./stampRules";
