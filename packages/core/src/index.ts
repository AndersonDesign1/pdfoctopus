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
  PageText,
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
  TextEditResult,
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
export {
  assembleExport,
  DEFAULT_EXPORT_DPI,
  DEFAULT_JPEG_QUALITY,
  EXPORT_TYPES,
  type ExportedPage,
  type ExportFile,
  type ExportFormat,
  type ExportOptions,
  exportFileName,
  filePerPage,
  MAX_EXPORT_DPI,
  MIN_EXPORT_DPI,
  ZIP_TYPE,
} from "./exportFiles";
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
export type { ChangeLevel, SignatureInspection, SignatureReport } from "./signatureCheck";
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
export { MAX_LINE_TEXT, type TextEditCheck, type TextLineInfo } from "./textEdit";
export { crc32 } from "./zip";
