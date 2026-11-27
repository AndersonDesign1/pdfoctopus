// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Messages exchanged between the UI thread and the PDF worker.

import type { CompressPreset } from "./compress";
import type { CreateSpec } from "./create";
import type {
  AnnotationChange,
  AnnotationInfo,
  AnnotationSpec,
  CompressResult,
  DocumentInfo,
  EditResult,
  FormField,
  ImageStamp,
  OpenResult,
  PagePoint,
  PageSize,
  PageText,
  ParagraphEditResult,
  PdfSource,
  PreparedSignature,
  RedactionResult,
  RenderedPage,
  RotationDelta,
  SearchHit,
  SignatureSpec,
  SignedResult,
  TextEditResult,
  TextStamp,
} from "./engine";
import type { PdfErrorCode } from "./errors";
import type { ExportOptions } from "./exportFiles";
import type { FieldChanges, NewField } from "./formBuild";
import type { ParagraphEditCheck } from "./paragraphs";
import type { PasswordSpec } from "./security";
import type { SignatureInspection } from "./signatureCheck";
import type { SignatureFieldInfo } from "./signatureField";
import type { TextEditCheck } from "./textEdit";

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
  | { id: number; type: "addImageStamp"; stamp: ImageStamp }
  | { id: number; type: "addTextStamp"; stamp: TextStamp }
  | { id: number; type: "addAnnotation"; spec: AnnotationSpec }
  | { id: number; type: "selectText"; page: number; from: PagePoint; to: PagePoint }
  | { id: number; type: "listAnnotations"; page: number }
  | { id: number; type: "markForRedaction"; marks: { page: number; quads: number[][] }[] }
  | { id: number; type: "applyRedactions" }
  | { id: number; type: "listFields"; page: number }
  | { id: number; type: "setFieldValue"; page: number; field: number; value: string | boolean }
  | { id: number; type: "flattenForm" }
  | { id: number; type: "addField"; spec: NewField }
  | { id: number; type: "updateField"; page: number; field: number; changes: FieldChanges }
  | { id: number; type: "deleteField"; page: number; field: number }
  | { id: number; type: "listFieldNames" }
  | { id: number; type: "signatureFields" }
  | { id: number; type: "inspectSignatures" }
  | { id: number; type: "prepareSignature"; spec: SignatureSpec }
  | { id: number; type: "finishSignature"; signature: Uint8Array }
  | { id: number; type: "setPassword"; spec: PasswordSpec }
  | { id: number; type: "removePassword" }
  | { id: number; type: "unlockPermissions"; password: string }
  | { id: number; type: "compressedCopy"; preset: CompressPreset }
  | { id: number; type: "createPdf"; spec: CreateSpec }
  | { id: number; type: "exportPage"; page: number; options: ExportOptions }
  | { id: number; type: "deleteAnnotation"; page: number; annotation: number }
  | {
      id: number;
      type: "editAnnotation";
      page: number;
      annotation: number;
      change: AnnotationChange;
    }
  | { id: number; type: "listTextLines"; page: number }
  | {
      id: number;
      type: "checkTextEdit";
      page: number;
      line: number;
      expected: string;
      text: string;
    }
  | { id: number; type: "editTextLine"; page: number; line: number; expected: string; text: string }
  | {
      id: number;
      type: "checkParagraphEdit";
      page: number;
      paragraph: number;
      expected: string;
      text: string;
    }
  | {
      id: number;
      type: "editParagraph";
      page: number;
      paragraph: number;
      expected: string;
      text: string;
    }
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
  addImageStamp: EditResult;
  addTextStamp: EditResult;
  addAnnotation: EditResult;
  selectText: number[][];
  listAnnotations: AnnotationInfo[];
  markForRedaction: EditResult;
  applyRedactions: RedactionResult;
  listFields: FormField[];
  setFieldValue: EditResult;
  flattenForm: EditResult;
  addField: EditResult;
  updateField: EditResult;
  deleteField: EditResult;
  listFieldNames: string[];
  signatureFields: SignatureFieldInfo[];
  inspectSignatures: SignatureInspection;
  prepareSignature: PreparedSignature;
  finishSignature: SignedResult;
  setPassword: EditResult;
  removePassword: EditResult;
  unlockPermissions: DocumentInfo | null;
  compressedCopy: CompressResult;
  createPdf: Uint8Array;
  exportPage: Uint8Array;
  deleteAnnotation: EditResult;
  editAnnotation: EditResult;
  listTextLines: PageText;
  checkTextEdit: TextEditCheck;
  editTextLine: TextEditResult;
  checkParagraphEdit: ParagraphEditCheck;
  editParagraph: ParagraphEditResult;
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
export type WorkerEvent =
  | { event: "load-progress"; progress: LoadProgress }
  /** MuPDF reported trouble with a file: start a fresh worker before the next file. */
  | { event: "troubled" };

export type WorkerMessage = WorkerResponse | WorkerEvent;
