// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thin, synchronous wrapper around MuPDF (WebAssembly). It runs inside the Web Worker
// (see worker.ts) in the browser, and directly in Node for tests.

import * as mupdf from "mupdf";
import {
  canEditText,
  canRecolor,
  canResize,
  copyContainer,
  copyDirect,
  describe,
  insertAt,
  invert,
  isListed,
  type Matrix6,
  putRect,
  readColor,
  readRect,
  restore,
  shiftAnnotation,
  snapshot,
  subtype,
  transformRect,
} from "./annotationObjects";
import { type CompressPreset, REBUILD_OPTIONS, shrinkImages } from "./compress";
import { exportPage } from "./convert";
import { IncrementalSaveError, PasswordRequiredError } from "./errors";
import type { ExportOptions } from "./exportFiles";
import {
  buildField,
  checkFieldName,
  checkOptions,
  checkRadioValue,
  ensureForm,
  entriesForAdd,
  FIELD_FLAGS,
  type FieldChanges,
  fieldNames,
  MIN_FIELD_SIZE,
  type NewField,
  radioGroup,
  radioValues,
  removeFrom,
  renamed,
  restoreEntries,
  snapshotEntries,
} from "./formBuild";
import {
  acroForm,
  type FieldKind,
  type FieldSnapshot,
  fieldKind,
  fieldObjects,
  fieldOf,
  isFillable,
  isOn,
  restoreField,
  snapshotField,
} from "./forms";
import {
  applyLabels,
  planLabels,
  readPageLabels,
  removeLabels,
  restoreLabels,
  simplifyLabelTree,
} from "./pageLabels";
import {
  ALL_PERMISSIONS,
  checkPasswordSpec,
  encryptOptions,
  filePermissions,
  fileRestricts,
  type PasswordSpec,
  type SecurityInfo,
} from "./security";
import {
  type ByteRange,
  DEFAULT_SIGNATURE_SIZE,
  findPlaceholders,
  MAX_SIGNATURE_SIZE,
  type SignaturePlaceholders,
  writeByteRange,
  writeSignature,
} from "./signature";
import { inspectSignatures, type SignatureInspection, signedFields } from "./signatureCheck";
import {
  listSignatureFields,
  MAX_SIGNATURE_TEXT,
  placeSignature,
  type SignatureFieldInfo,
} from "./signatureField";
import { checkStampText, MAX_STAMP_DETAIL, MAX_STAMP_TEXT, stampName } from "./stampRules";
import {
  analysePage,
  contentLines,
  editLooksRight,
  makeEdit,
  type PageAnalysis,
  planLineEdit,
  type TextEditCheck,
  type TextLineInfo,
} from "./textEdit";
import { stampAppearance } from "./textStamp";

/** A rendered page as raw, non-premultiplied RGBA pixels (ready for `ImageData`). */
export interface RenderedPage {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

/** Size of a page in PDF points (1/72 inch), after the page's own rotation. */
export interface PageSize {
  width: number;
  height: number;
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
  /** E.g. "PDF 1.7". */
  format?: string;
  /** E.g. "Standard V5 R6 256-bit AES", or undefined when not encrypted. */
  encryption?: string;
}

export interface DocumentInfo {
  pageCount: number;
  pages: PageSize[];
  /** Page labels as shown in the document (e.g. "i", "ii", "1"), when it defines them. */
  labels: (string | null)[];
  metadata: DocumentMetadata;
  /** Areas marked for redaction and not yet applied, on all pages. */
  redactionMarks: number;
  /** The document's form, if it has one. */
  form: FormInfo;
  /**
   * True once redactions have been applied: from then on every save rewrites the whole file,
   * because appending would keep the removed content in the original bytes.
   */
  redacted: boolean;
  /** Whether the file has a password, what it allows, and what saving will do to that. */
  security: SecurityInfo;
}

/** A search hit: one or more quads (a hit can wrap across lines) on one page. */
export interface SearchHit {
  page: number;
  /** Each quad is [ulx, uly, urx, ury, llx, lly, lrx, lry] in page points, origin top-left. */
  quads: number[][];
}

export type OpenResult = { needsPassword: true } | ({ needsPassword: false } & DocumentInfo);

/** What undo and redo would do next, for the UI's buttons and tooltips. */
export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** E.g. "Rotate 2 pages", for "Undo Rotate 2 pages". */
  undoLabel: string | null;
  redoLabel: string | null;
}

/** Result of a page operation, undo or redo: the document as it is now. */
export interface EditResult {
  info: DocumentInfo;
  history: HistoryState;
}

/** Another PDF to insert pages from. */
export interface PdfSource {
  bytes: Uint8Array;
  /** Needed if the file is password-protected. */
  password?: string;
  /** 0-based pages to take, in order. All pages when omitted. */
  pages?: number[];
}

/** A clockwise rotation in degrees. */
export type RotationDelta = 90 | 180 | 270 | -90;

/** What an image stamp is, for its undo label and the text that describes it to readers. */
export type StampKind = "signature" | "initials" | "date" | "image";

/** A point on a page, in points from its top-left corner as shown. */
export type PagePoint = [number, number];
/** A colour as red, green and blue from 0 to 1. */
export type RgbColor = [number, number, number];

/**
 * A markup annotation to add. Positions are in points from the page's top-left corner as it
 * is shown (after its own rotation), like ImageStamp.rect.
 */
export type AnnotationSpec =
  | {
      /** Text markup over the text between two points, like selecting it. */
      kind: "highlight" | "underline" | "strikeout";
      page: number;
      from: PagePoint;
      to: PagePoint;
      color: RgbColor;
    }
  | { kind: "ink"; page: number; strokes: PagePoint[][]; color: RgbColor; width: number }
  | {
      kind: "rectangle" | "ellipse";
      page: number;
      rect: [number, number, number, number];
      color: RgbColor;
      width: number;
    }
  | {
      kind: "line" | "arrow";
      page: number;
      from: PagePoint;
      to: PagePoint;
      color: RgbColor;
      width: number;
    }
  | { kind: "note"; page: number; at: PagePoint; text: string; color: RgbColor }
  | {
      kind: "text";
      page: number;
      rect: [number, number, number, number];
      text: string;
      color: RgbColor;
      size: number;
    }
  /** A white box over part of the page. It covers, but doesn't remove (see redaction). */
  | { kind: "whiteout"; page: number; rect: [number, number, number, number] }
  /** An area marked for redaction: nothing is removed until applyRedactions. */
  | { kind: "redact"; page: number; rect: [number, number, number, number] };

export type AnnotationKind = AnnotationSpec["kind"];

/** An annotation already on a page, as `listAnnotations` reports it. */
export interface AnnotationInfo {
  /** Identifies it on its page (its PDF object number). */
  id: number;
  /** What people would call it: "highlight", "signature", "white-out box". */
  label: string;
  /** Its box: [left, top, right, bottom] in points from the page's top-left corner as shown. */
  rect: [number, number, number, number];
  color: RgbColor | null;
  /** The text of a note or text box; null for other annotations. */
  text: string | null;
  canResize: boolean;
  canRecolor: boolean;
  canEditText: boolean;
}

/** Changes to an annotation. A new rect the same size as the old one moves it. */
export interface AnnotationChange {
  rect?: [number, number, number, number];
  color?: RgbColor;
  text?: string;
}

/** An image to put on a page, such as a signature. */
export interface ImageStamp {
  /** 0-based page. */
  page: number;
  /**
   * Where to put it: [left, top, right, bottom] in points, measured from the top-left corner
   * of the page as it is shown (after the page's own rotation).
   */
  rect: [number, number, number, number];
  /** PNG or JPEG bytes. Transparency in a PNG is kept. */
  image: Uint8Array;
  kind: StampKind;
  /** Text describing the stamp (e.g. the date written in it), stored as its description. */
  text?: string;
}

/** A document's form. */
export interface FormInfo {
  /** Form field boxes (widgets) on all pages. */
  fields: number;
  /**
   * "none": an ordinary form, or no form. "hybrid": an ordinary form with an XFA copy (common in
   * government forms); it can be filled in, and the XFA copy is removed when it is, so every app
   * shows what was typed. "dynamic": only XFA, which PDFoctopus can't show or fill in.
   */
  xfa: "none" | "hybrid" | "dynamic";
}

/** A form field box on a page, as listFields reports it. */
export interface FormField {
  /** Identifies the box on its page (its PDF object number). */
  id: number;
  /** The field's full name. Several boxes can share one field (radio buttons). */
  name: string;
  /** What the form calls it for people (its tooltip), or its short name. */
  label: string;
  kind: FieldKind;
  /** [left, top, right, bottom] in points from the page's top-left corner as shown. */
  rect: [number, number, number, number];
  /** Text, or the chosen option's value. For a checkbox or radio button, its "on" name. */
  value: string;
  /** For a checkbox or radio button: whether this box is on. */
  checked: boolean;
  /** For a dropdown or list: the options, as shown and as stored. */
  options: { label: string; value: string }[];
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  /** For a dropdown: whether it also takes an answer that isn't one of its options. */
  editable: boolean;
  /** Most characters a text field takes, if it has a limit. */
  maxLength: number | null;
  /** The field's own name (the last part of its full name), which renaming changes. */
  partialName: string;
  /** What the field starts with and resets to (its /DV), as text. */
  defaultValue: string;
  /** A text field formatted as a date (by Acrobat's date scripts). */
  date: boolean;
}

/** A compressed copy of the document. */
export interface CompressResult {
  bytes: Uint8Array;
  /** How many pictures were made smaller. */
  images: number;
}

/** What applyRedactions did, with the document as it is now. */
export interface RedactionResult extends EditResult {
  /** How many pages had marks. */
  pages: number;
  /** How many annotations under the marks (comments, highlights, links) were deleted. */
  annotationsRemoved: number;
}

/** A text stamp to put on a page, such as "APPROVED", with an optional second line. */
export interface TextStamp {
  /** 0-based page. */
  page: number;
  /** Where to put it: [left, top, right, bottom] in points from the page's top-left corner as shown. */
  rect: [number, number, number, number];
  /** What it says, in large bold letters (up to 40 characters). */
  text: string;
  /** A smaller second line, such as a date or a name (up to 60 characters). */
  detail?: string;
  color: RgbColor;
}

/** A certificate signature to prepare: where it goes and what its box says. */
export interface SignatureSpec {
  /** 0-based page. */
  page: number;
  /** An empty signature field on that page to sign, by its full name… */
  field?: string;
  /** …or where to put a new one: [left, top, right, bottom] in points as shown. */
  rect?: [number, number, number, number];
  /** The signer's name (from their certificate), shown in the box. */
  signer: string;
  /** The date and time shown in the box. */
  dateText: string;
  /** When it's signed, in milliseconds since 1970 (for the signature dictionary's /M). */
  signingTime: number;
  reason?: string;
  location?: string;
  /** Bytes to set aside for the signature (CMS); DEFAULT_SIGNATURE_SIZE if not given. */
  signatureSize?: number;
}

/** A file with a signature dictionary waiting for its signature, and what to sign. */
export interface PreparedSignature {
  /** The whole file, with the real /ByteRange and zeros where the signature goes. */
  bytes: Uint8Array;
  /** The stretches of `bytes` to hash and sign. */
  byteRange: ByteRange;
  /** The new (or signed) field's name. */
  field: string;
}

/** The signed file, now the open document. */
export interface SignedResult {
  bytes: Uint8Array;
  info: DocumentInfo;
}

/** The lines of text on a page, for the Edit text tool. */
export interface PageText {
  lines: TextLineInfo[];
  /** The file has signatures: editing text will show as a change made after signing. */
  signed: boolean;
}

/** A line edited: the document as it is now, and what the edit did (a fallback font, say). */
export interface TextEditResult extends EditResult {
  check: TextEditCheck;
}

/** One undoable step. Each step knows how to reverse itself, so no copies are kept. */
interface Step {
  label: string;
  undo(): void;
  redo(): void;
}

/** Keys a page can inherit from its parents in the page tree (PDF 1.7, 7.7.3.4). */
const INHERITABLE_KEYS = ["Resources", "MediaBox", "CropBox", "Rotate"] as const;

/** Upper bound on undo steps kept. Old steps are dropped first. */
export const MAX_HISTORY = 200;

/** Upper bound on search hits returned at once, so a common word can't flood the UI. */
export const MAX_SEARCH_HITS = 5000;

/** Upper bound on a stamp image's size, so a huge photo can't bloat the PDF. */
export const MAX_STAMP_IMAGE_BYTES = 10 * 1024 * 1024;
/**
 * Upper bound on a stamp image's pixels. A small file can still decode to an enormous image
 * (it compresses well), which would use a lot of memory and make the PDF much bigger.
 */
export const MAX_STAMP_IMAGE_PIXELS = 4096 * 4096;

/** Annotation flags (PDF 1.7, 12.5.3): shown when printed, and can't be moved or changed. */
const ANNOT_FLAG_PRINT = 4;
const ANNOT_FLAG_LOCKED = 128;

/** Undo labels for annotations, e.g. "Add highlight". */
const ANNOTATION_LABELS: Record<AnnotationKind, string> = {
  highlight: "Add highlight",
  underline: "Add underline",
  strikeout: "Add strikethrough",
  ink: "Add drawing",
  rectangle: "Add rectangle",
  ellipse: "Add ellipse",
  line: "Add line",
  arrow: "Add arrow",
  note: "Add note",
  text: "Add text box",
  whiteout: "Add white-out",
  redact: "Mark for redaction",
};

/** How many pages' text layouts are kept for selecting text. */
const TEXT_CACHE_PAGES = 8;

/** At most this many quads (word boxes) in one markForRedaction call. */
const MAX_REDACTION_QUADS = 20_000;

/** Upper bounds that keep a single annotation reasonable. */
const MAX_INK_POINTS = 20_000;
const MAX_ANNOTATION_TEXT = 10_000;

const STAMP_LABELS: Record<StampKind, { undo: string; contents: string }> = {
  signature: { undo: "Add signature", contents: "Signature" },
  initials: { undo: "Add initials", contents: "Initials" },
  date: { undo: "Add date", contents: "Date" },
  image: { undo: "Add image", contents: "Image" },
};

export class PdfEngine {
  private doc: mupdf.Document | null = null;
  /** MuPDF's needsPassword() stays true after a successful unlock, so track it here. */
  private locked = false;
  /** Whether the file was unlocked with its permissions (owner) password. */
  private ownerUnlocked = false;
  /** A password to add, or the file's to remove, when it's next saved (null: keep as is). */
  private securityChange: { kind: "protect"; spec: PasswordSpec } | { kind: "remove" } | null =
    null;
  /**
   * The opened file's size and where its last cross-reference section starts. Every
   * incremental save is these bytes plus one update, whose trailer must point back here.
   */
  private base: { length: number; startxref: number | null } | null = null;
  private undoStack: Step[] = [];
  /** Set once redactions are applied; never cleared (see DocumentInfo.redacted). */
  private redacted = false;
  private redoStack: Step[] = [];
  /**
   * How many changes the document has had since it was opened: up one for each step done or
   * redone, down one for each undone. Zero means it's as it was opened.
   */
  private changes = 0;
  /** After signing: the signed file, which saving gives back as it is until something changes. */
  private signedFile: Uint8Array | null = null;
  /** A file prepared for signing, waiting for its signature (see prepareSignature). */
  private prepared: { bytes: Uint8Array; at: SignaturePlaceholders; field: string } | null = null;
  /**
   * The file as opened, kept only when it has signatures, so they can be checked against the
   * bytes they cover (see inspectSignatures).
   */
  private signedBytes: Uint8Array | null = null;
  /** The password the file was opened with, to open its signed versions the same way. */
  private password: string | null = null;
  /**
   * Text layout of recently used pages, for selecting text; dropped whenever the document
   * changes. Only a few pages are kept, least recently used dropped first.
   */
  private textCache = new Map<number, mupdf.StructuredText>();
  /** Text lines of recently listed pages, for editing them; dropped whenever the document changes. */
  private lineCache = new Map<number, PageAnalysis>();

  /**
   * Open a PDF. If it needs a password, nothing else can be read until `authenticate`
   * succeeds.
   */
  open(bytes: Uint8Array): OpenResult {
    this.close();
    this.doc = mupdf.Document.openDocument(bytes, "application/pdf");
    this.base = { length: bytes.byteLength, startxref: lastStartxref(bytes) };
    this.locked = this.doc.needsPassword();
    this.signedBytes = bytes;
    if (this.locked) return { needsPassword: true };
    this.keepBytesIfSigned();
    return { needsPassword: false, ...this.info() };
  }

  /** Keep the opened file's bytes only if it has signatures (they can be large). */
  private keepBytesIfSigned(): void {
    const pdf = this.doc?.asPDF();
    try {
      if (!pdf || signedFields(pdf).length === 0) this.signedBytes = null;
    } catch {
      this.signedBytes = null;
    }
  }

  /** Try a password. Returns the document's info on success, or null if it was wrong. */
  authenticate(password: string): DocumentInfo | null {
    const doc = this.requireDoc(false);
    if (!this.locked) return this.info();
    const result = doc.authenticatePassword(password);
    if (result === 0) return null;
    this.locked = false;
    this.ownerUnlocked = (result & 4) !== 0;
    this.password = password;
    this.keepBytesIfSigned();
    return this.info();
  }

  /**
   * Unlock a file's permissions with its permissions (owner) password, so its password and
   * permissions can be changed. Returns the document's info, or null if the password is wrong.
   */
  unlockPermissions(password: string): DocumentInfo | null {
    const doc = this.requireDoc();
    if ((doc.authenticatePassword(password) & 4) === 0) return null;
    this.ownerUnlocked = true;
    return this.info();
  }

  // ---------------------------------------------------------------------------------------
  // Passwords and permissions. They take effect when the file is saved, which then rewrites
  // the whole file: an incremental save can't change how a file is encrypted.

  /** The file's security, and what the next save will do to it. */
  private securityInfo(): SecurityInfo {
    const doc = this.doc;
    const pdf = doc?.asPDF();
    const method = doc?.getMetaData("encryption");
    const encrypted = !!method && method !== "None";
    const permissions = pdf ? filePermissions(pdf) : { ...ALL_PERMISSIONS };
    const change = this.securityChange;
    return {
      encrypted,
      method: encrypted ? method : undefined,
      permissions,
      canChange: !encrypted || this.ownerUnlocked || !(pdf && fileRestricts(pdf)),
      pending: change ? change.kind : "none",
      pendingOpenPassword: change?.kind === "protect" ? !!change.spec.openPassword : undefined,
      pendingPermissions: change?.kind === "protect" ? { ...change.spec.permissions } : undefined,
    };
  }

  /**
   * Protect the file with a password (to open it, to change its permissions, or both) when
   * it's next saved, as one undoable step.
   */
  setPassword(spec: PasswordSpec): EditResult {
    this.requirePdf();
    if (!this.securityInfo().canChange) {
      throw new Error("Unlock the permissions with the permissions password first");
    }
    checkPasswordSpec(spec);
    const copy: PasswordSpec = {
      openPassword: spec.openPassword ?? "",
      permissionsPassword: spec.permissionsPassword ?? "",
      permissions: { ...spec.permissions },
    };
    return this.securityStep(copy.openPassword ? "Add password" : "Restrict permissions", {
      kind: "protect",
      spec: copy,
    });
  }

  /** Save the file without a password (and without restrictions), as one undoable step. */
  removePassword(): EditResult {
    this.requirePdf();
    const security = this.securityInfo();
    if (!security.canChange) {
      throw new Error("Unlock the permissions with the permissions password first");
    }
    if (!security.encrypted && security.pending !== "protect") {
      throw new Error("This file has no password");
    }
    return this.securityStep("Remove password", security.encrypted ? { kind: "remove" } : null);
  }

  // ---------------------------------------------------------------------------------------
  // Compress: a smaller copy of the document, which is left as it is.

  /**
   * A smaller copy of the document as it is now (with any edits): rebuilt, and with "balanced"
   * or "smallest", its pictures scaled down and saved as JPEG. The open document isn't
   * changed. A password set or removed in the Password dialog applies to the copy too. A file
   * with a password that isn't being changed can't be compressed: its passwords aren't known,
   * so the copy couldn't be protected the same way.
   */
  /**
   * One page (0-based) as a picture, SVG drawing, text or HTML, with unsaved changes. Refused
   * when the file doesn't allow copying its content, unless its permissions were unlocked.
   */
  exportPage(index: number, options: ExportOptions): Uint8Array {
    const doc = this.requireDoc();
    if (!Number.isInteger(index) || index < 0 || index >= doc.countPages()) {
      throw new Error("There's no such page");
    }
    const security = this.securityInfo();
    if (security.encrypted && !security.permissions.copy && !this.ownerUnlocked) {
      throw new Error(
        "This file doesn't allow copying its content. To export it, unlock its permissions " +
          "with the permissions password first (Password).",
      );
    }
    const page = doc.loadPage(index);
    try {
      return exportPage(page, index, options);
    } finally {
      page.destroy();
    }
  }

  compressedCopy(preset: CompressPreset): CompressResult {
    const pdf = this.requirePdf();
    if (!["high", "balanced", "smallest"].includes(preset)) throw new Error("Unknown preset");
    const security = this.securityInfo();
    if (security.encrypted && security.pending === "none") {
      throw new Error(
        "This file has a password. To compress it, remove its password or set a new one first " +
          "(Password).",
      );
    }
    if (!security.canChange) {
      throw new Error("Unlock the permissions with the permissions password first");
    }
    // A plain, unencrypted copy to work on, so the open document isn't touched. Its bytes are
    // copied out of MuPDF's memory, which moves as it grows (opening the copy grows it).
    const plain = pdf.saveToBuffer("encrypt=none");
    let copy: mupdf.Document | null = null;
    try {
      const bytes = plain.asUint8Array().slice();
      plain.destroy();
      copy = mupdf.Document.openDocument(bytes, "application/pdf");
      const copyPdf = copy.asPDF() as mupdf.PDFDocument;
      const { images } = shrinkImages(copyPdf, preset);
      const change = this.securityChange;
      const protect = change?.kind === "protect" ? `,${encryptOptions(change.spec)}` : "";
      const out = copyPdf.saveToBuffer(`${REBUILD_OPTIONS}${protect}`);
      try {
        return { bytes: out.asUint8Array().slice(), images };
      } finally {
        out.destroy();
      }
    } finally {
      copy?.destroy();
    }
  }

  // ---------------------------------------------------------------------------------------
  // Certificate signatures (PAdES). Signing happens in two steps, because the signature itself
  // is made outside the engine (with the user's key, in packages/sign): prepareSignature saves
  // the file with a signature dictionary and room for the signature, and finishSignature
  // writes the signature in. The signed file then becomes the open document, so later changes
  // are added after the signature and leave it valid.

  /** Every signature field in the document, signed or not. */
  signatureFields(): SignatureFieldInfo[] {
    return listSignatureFields(this.requirePdf());
  }

  /**
   * The signatures in the file as it was opened (or as last signed), with what was changed
   * after each one. Unsaved changes aren't included: they aren't signed or saved yet. The
   * file comes back too, for the cryptographic check (packages/sign).
   */
  inspectSignatures(): SignatureInspection {
    // Not a PDF (an HTML file, say): no signatures, rather than an error.
    this.requireDoc();
    const bytes = this.signedBytes;
    if (!bytes) return { file: null, signatures: [], truncated: false, skipped: 0 };
    // A separate copy of the file, so unsaved changes in the open document don't count.
    const current = mupdf.Document.openDocument(bytes, "application/pdf");
    try {
      const pdf = current.asPDF();
      const unlocked =
        !current.needsPassword() || current.authenticatePassword(this.password ?? "") !== 0;
      if (!pdf || !unlocked) return { file: null, signatures: [], truncated: false, skipped: 0 };
      return inspectSignatures(bytes, pdf);
    } finally {
      current.destroy();
    }
  }

  /**
   * Why the document can't be signed as it is, or null if it can. Signing always appends to
   * the file, so anything that makes the next save rewrite it rules signing out.
   */
  private signingBlocker(pdf: mupdf.PDFDocument): string | null {
    if (this.redacted) {
      return "Redactions were applied, so the whole file has to be rewritten first. Save it, open the saved file and sign that.";
    }
    if (this.securityChange) {
      return "A password change is waiting to be saved, which rewrites the whole file. Save it (or undo the change) first, then sign.";
    }
    if (this.securityInfo().encrypted) {
      return "Signing a file that has a password isn't supported yet. Remove the password, save, and sign the saved file.";
    }
    if (!pdf.canBeSavedIncrementally()) {
      return "This PDF was damaged and had to be repaired, so a signature can't be added to it safely. Save a rebuilt copy, open it and sign that.";
    }
    return null;
  }

  /**
   * Save the document (with any changes) plus a signature field and signature dictionary,
   * with room for the signature. The open document isn't changed: the work is done on a copy.
   * Returns the file and the byte range to sign; pass the signature to finishSignature.
   */
  prepareSignature(spec: SignatureSpec): PreparedSignature {
    const pdf = this.requirePdf();
    const blocker = this.signingBlocker(pdf);
    if (blocker) throw new Error(blocker);
    const [index] = this.checkPages([spec.page]) as [number];
    const size = spec.signatureSize ?? DEFAULT_SIGNATURE_SIZE;
    if (!Number.isInteger(size) || size < 1024 || size > MAX_SIGNATURE_SIZE) {
      throw new Error("The space set aside for the signature isn't valid");
    }
    const time = new Date(spec.signingTime);
    if (Number.isNaN(time.getTime())) throw new Error("The signing time isn't valid");
    const text = (value: string | undefined, what: string) => {
      const t = (value ?? "").trim();
      if (t.length > MAX_SIGNATURE_TEXT) {
        throw new Error(`The ${what} can be ${MAX_SIGNATURE_TEXT} characters at most`);
      }
      return t || undefined;
    };
    const details = {
      signer: text(spec.signer, "name") ?? "",
      dateText: text(spec.dateText, "date") ?? "",
      signingTime: time,
      reason: text(spec.reason, "reason"),
      location: text(spec.location, "location"),
    };
    let target: { field: string } | { rect: readonly number[] };
    if (spec.field !== undefined) {
      target = { field: spec.field };
    } else if (spec.rect) {
      const [x0, y0, x1, y1] = checkRect(spec.rect);
      if (x1 - x0 < MIN_FIELD_SIZE || y1 - y0 < MIN_FIELD_SIZE) {
        throw new Error("The signature box is too small");
      }
      this.checkOnPage(index, [x0, y0, x1, y1], "The signature must be inside the page");
      target = { rect: [x0, y0, x1, y1] };
    } else {
      throw new Error("Say where the signature goes");
    }

    // The file as it would be saved now: the original, or the original plus the changes.
    const unsigned = this.changes === 0 && this.signedFile ? this.signedFile : this.save();
    this.prepared = null;
    const copy = mupdf.Document.openDocument(unsigned, "application/pdf");
    let bytes: Uint8Array;
    let field: string;
    try {
      const copyPdf = copy.asPDF() as mupdf.PDFDocument;
      field = placeSignature(copyPdf, index, target, details, size);
      // Only the signature's objects are written, after the file as it was.
      const buffer = copyPdf.saveToBuffer("incremental,compress");
      try {
        bytes = buffer.asUint8Array().slice();
      } finally {
        buffer.destroy();
      }
    } finally {
      copy.destroy();
    }
    if (bytes.length <= unsigned.length) throw new Error("The signature couldn't be added");
    for (let i = 0; i < unsigned.length; i++) {
      if (bytes[i] !== unsigned[i]) throw new Error("Saving the signature changed the file");
    }
    const at = findPlaceholders(bytes, unsigned.length, size);
    const byteRange = writeByteRange(bytes, at);
    this.prepared = { bytes, at, field };
    return { bytes: bytes.slice(), byteRange, field };
  }

  /**
   * Write the signature (a DER-encoded CMS SignedData) into the file prepared by
   * prepareSignature, and make the signed file the open document. Signing can't be undone:
   * the history is cleared, and saving gives back the signed file until something changes.
   */
  finishSignature(signature: Uint8Array): SignedResult {
    const prepared = this.prepared;
    if (!prepared) throw new Error("Nothing is waiting to be signed");
    const bytes = prepared.bytes.slice();
    writeSignature(bytes, prepared.at, signature);
    this.prepared = null;
    const opened = this.open(bytes);
    if (opened.needsPassword) throw new Error("The signed file couldn't be opened");
    this.signedFile = bytes;
    return { bytes: bytes.slice(), info: this.info() };
  }

  private securityStep(label: string, next: PdfEngine["securityChange"]): EditResult {
    const before = this.securityChange;
    let applied = true;
    this.securityChange = next;
    return this.run({
      label,
      redo: () => {
        if (applied) return;
        this.securityChange = next;
        applied = true;
      },
      undo: () => {
        this.securityChange = before;
        applied = false;
      },
    });
  }

  info(): DocumentInfo {
    const doc = this.requireDoc();
    const pageCount = doc.countPages();
    const pages: PageSize[] = [];
    const labels: (string | null)[] = [];
    let anyLabel = false;
    // Read here rather than with page.getLabel(), whose lookup a crafted file can make hang.
    const pdf = doc.asPDF();
    const read = pdf ? readPageLabels(pdf) : null;
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        pages.push({ width: x1 - x0, height: y1 - y0 });
        const label = read?.[i];
        // Only labels that differ from the page number count.
        const real = label && label !== String(i + 1) ? label : null;
        if (real) anyLabel = true;
        labels.push(real);
      } finally {
        page.destroy();
      }
    }
    return {
      pageCount,
      pages,
      labels: anyLabel ? labels : labels.map(() => null),
      metadata: this.metadata(),
      redactionMarks: this.countRedactionMarks(),
      form: this.formInfo(),
      redacted: this.redacted,
      security: this.securityInfo(),
    };
  }

  private metadata(): DocumentMetadata {
    const doc = this.requireDoc();
    const get = (key: string) => {
      const value = doc.getMetaData(key)?.trim();
      return value ? value : undefined;
    };
    const encryption = get("encryption");
    return {
      title: get("info:Title"),
      author: get("info:Author"),
      subject: get("info:Subject"),
      keywords: get("info:Keywords"),
      creator: get("info:Creator"),
      producer: get("info:Producer"),
      creationDate: get("info:CreationDate"),
      modificationDate: get("info:ModDate"),
      format: get("format"),
      encryption: encryption && encryption !== "None" ? encryption : undefined,
    };
  }

  get pageCount(): number {
    return this.requireDoc().countPages();
  }

  /** Render a page (0-based) to RGBA pixels on white. `scale` 1 = 72 dpi. */
  renderPage(index: number, scale = 1.5): RenderedPage {
    const page = this.requireDoc().loadPage(index);
    try {
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );
      try {
        const width = pixmap.getWidth();
        const height = pixmap.getHeight();
        return { width, height, pixels: rgbToRgba(pixmap.getPixels(), width, height, pixmap) };
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  /** Render a page to PNG (for exports and tests). */
  renderPagePng(index: number, scale = 1.5): Uint8Array {
    const page = this.requireDoc().loadPage(index);
    try {
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );
      try {
        return pixmap.asPNG();
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  /** Find text (ignoring case and accents) on every page. Stops after MAX_SEARCH_HITS hits. */
  search(query: string): { hits: SearchHit[]; truncated: boolean } {
    const doc = this.requireDoc();
    const hits: SearchHit[] = [];
    if (!query.trim()) return { hits, truncated: false };
    const pageCount = doc.countPages();
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        const [x0, y0] = page.getBounds();
        for (const hit of page.search(query, "ignore-case,ignore-diacritics")) {
          // Make coordinates relative to the page's visible top-left corner.
          const quads = hit.map((q) => q.map((v, j) => v - (j % 2 === 0 ? x0 : y0)));
          // Collect one hit past the limit, so exactly MAX_SEARCH_HITS isn't reported as more.
          if (hits.length === MAX_SEARCH_HITS) return { hits, truncated: true };
          hits.push({ page: i, quads });
        }
      } finally {
        page.destroy();
      }
    }
    return { hits, truncated: false };
  }

  /**
   * Save the document. Incremental by default: the original bytes are kept as-is and
   * any changes are appended to the end of the file, so existing signatures stay valid.
   *
   * If the file can't be saved incrementally (for example, it was damaged and had to be
   * repaired), this throws. Callers must then ask the user and pass `incremental: false`
   * to rewrite the whole file; it is never done silently.
   */
  save({ incremental = true }: { incremental?: boolean } = {}): Uint8Array {
    const pdf = this.requireDoc().asPDF();
    if (!pdf) throw new Error("Not a PDF document");
    // After a redaction an incremental save would keep the removed content in the original
    // bytes at the start of the file, so the whole file is always rewritten. (The user agreed
    // to that when applying the redactions.)
    if (this.redacted) incremental = false;
    // Adding or removing a password rewrites the whole file too (agreed to when setting it).
    const change = this.securityChange;
    if (change) incremental = false;
    // Just signed, and not changed since: the signed file is the file. (An update with nothing
    // in it would be harmless, but there's no reason to add one.)
    if (incremental && this.signedFile && this.changes === 0) return this.signedFile.slice();
    if (incremental && !pdf.canBeSavedIncrementally()) {
      throw new IncrementalSaveError();
    }
    // "compress" deflates streams that are written uncompressed. MuPDF stores a stamp's image
    // as raw pixels, which would make a signed file several megabytes bigger. In an
    // incremental save it only applies to the objects being appended, never to the original.
    const security =
      change?.kind === "protect"
        ? `,${encryptOptions(change.spec)}`
        : change?.kind === "remove"
          ? ",encrypt=none"
          : "";
    const buffer = pdf.saveToBuffer(
      incremental ? "incremental,compress" : `garbage,compress${security}`,
    );
    let bytes: Uint8Array;
    try {
      bytes = buffer.asUint8Array().slice();
    } finally {
      buffer.destroy();
    }
    if (this.redacted) {
      // A redacted file has been written out: the redaction is final now. Undo would bring the
      // removed content back into the document, and the next save would write it out again.
      this.undoStack = [];
      this.redoStack = [];
    }
    if (incremental && this.base?.startxref != null) {
      // After a first save, MuPDF writes later updates as if the earlier one had been appended
      // to the original file, so their trailer points (/Prev) at a section that isn't there.
      // Each save is the original bytes plus one update, so point it back at the original's.
      bytes = fixUpdatePrev(bytes, this.base.length, this.base.startxref);
    }
    return bytes;
  }

  close(): void {
    this.clearTextCache();
    this.doc?.destroy();
    this.doc = null;
    this.base = null;
    this.locked = false;
    this.ownerUnlocked = false;
    this.securityChange = null;
    this.undoStack = [];
    this.redoStack = [];
    this.redacted = false;
    this.changes = 0;
    this.signedFile = null;
    this.prepared = null;
    this.signedBytes = null;
    this.password = null;
  }

  // ---------------------------------------------------------------------------------------
  // Page operations. Each one is a single undoable step and returns the updated document.
  // Pages are 0-based. Page objects removed from the page tree are kept by the history (not
  // copied), so undo puts the very same objects back.

  /** Rotate pages clockwise by `degrees`, on top of any rotation they already have. */
  rotatePages(pages: readonly number[], degrees: RotationDelta): EditResult {
    const pdf = this.requirePdf();
    const indices = this.checkPages(pages);
    if (![90, 180, 270, -90].includes(degrees)) throw new Error("Rotate by 90, 180 or 270 degrees");
    const objects = indices.map((i) => pdf.findPage(i));
    const before = objects.map((obj) => readRotation(obj));
    const apply = (rotations: number[]) => {
      objects.forEach((obj, i) => {
        obj.put("Rotate", rotations[i] as number);
      });
    };
    const after = before.map((r) => normaliseRotation(r + degrees));
    return this.run({
      label: `Rotate ${countLabel(indices.length)}`,
      undo: () => apply(before),
      redo: () => apply(after),
    });
  }

  /** Delete pages. At least one page must be left. */
  deletePages(pages: readonly number[]): EditResult {
    const pdf = this.requirePdf();
    simplifyLabelTree(pdf);
    const indices = this.checkPages(pages);
    if (indices.length >= pdf.countPages()) {
      throw new Error("A PDF needs at least one page, so not every page can be deleted");
    }
    let removed: PageEntry[] = [];
    return this.run(
      this.labelled({
        label: `Delete ${countLabel(indices.length)}`,
        redo: () => {
          removed = this.removePages(indices);
        },
        undo: () => this.insertPages(removed),
      }),
    );
  }

  /**
   * Move pages, keeping their order, so the first one ends up at index `to` of the result.
   * `to` counts positions in the document after the moved pages are taken out, so it runs
   * from 0 to pageCount - pages.length.
   */
  movePages(pages: readonly number[], to: number): EditResult {
    const pdf = this.requirePdf();
    simplifyLabelTree(pdf);
    const indices = this.checkPages(pages);
    const maxTo = pdf.countPages() - indices.length;
    if (!Number.isInteger(to) || to < 0 || to > maxTo) {
      throw new Error(`Move target ${to} is out of range (0 to ${maxTo})`);
    }
    const unchanged = indices.every((p, i) => p === to + i);
    let original: PageEntry[] = [];
    return this.run(
      this.labelled({
        label: `Move ${countLabel(indices.length)}`,
        redo: () => {
          original = this.removePages(indices);
          this.insertPages(original.map((e, i) => ({ index: to + i, object: e.object })));
        },
        undo: () => {
          const moved = this.removePages(original.map((_, i) => to + i));
          this.insertPages(
            original.map((e, i) => ({
              index: e.index,
              object: moved[i]?.object as mupdf.PDFObject,
            })),
          );
        },
      }),
      unchanged,
    );
  }

  /**
   * Insert `count` blank pages before index `at` (pageCount appends). The size defaults to
   * that of the neighbouring page, or A4 in an empty document.
   */
  insertBlankPages(at: number, count = 1, size?: PageSize): EditResult {
    const pdf = this.requirePdf();
    simplifyLabelTree(pdf);
    const pageCount = pdf.countPages();
    this.checkInsertAt(at, pageCount);
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      throw new Error("Insert between 1 and 1000 blank pages");
    }
    const { width, height } = size ?? this.neighbourSize(at, pageCount);
    if (!(width > 0 && height > 0 && width <= 14400 && height <= 14400)) {
      throw new Error("Page size must be between 1 and 14400 points");
    }
    const objects: mupdf.PDFObject[] = [];
    for (let i = 0; i < count; i++) {
      objects.push(pdf.addPage([0, 0, width, height], 0, pdf.newDictionary(), ""));
    }
    return this.insertStep(`Insert ${countLabel(count, "blank page")}`, at, objects);
  }

  /** Insert pages from other PDFs before index `at` (pageCount appends, which is a merge). */
  insertPdfs(at: number, sources: readonly PdfSource[]): EditResult {
    const pdf = this.requirePdf();
    simplifyLabelTree(pdf);
    this.checkInsertAt(at, pdf.countPages());
    if (sources.length === 0) throw new Error("Choose at least one PDF to insert");
    // Graft every page first, at the end of the document, so a failure part-way through
    // (a bad file, a wrong password) can be cleaned up without touching existing pages.
    const start = pdf.countPages();
    const opened: mupdf.Document[] = [];
    try {
      for (const source of sources) {
        // A graft map shares resources (fonts, images) between pages of one source file.
        const graft = pdf.newGraftMap();
        const src = openSource(source);
        opened.push(src);
        const srcPdf = src.asPDF() as mupdf.PDFDocument;
        const srcCount = srcPdf.countPages();
        const wanted = source.pages ?? Array.from({ length: srcCount }, (_, i) => i);
        for (const p of wanted) {
          if (!Number.isInteger(p) || p < 0 || p >= srcCount) {
            throw new Error(`Page ${p + 1} doesn't exist in the file being inserted`);
          }
          graft.graftPage(-1, srcPdf, p);
        }
      }
    } catch (err) {
      while (pdf.countPages() > start) pdf.deletePage(pdf.countPages() - 1);
      throw err;
    } finally {
      for (const src of opened) src.destroy();
    }
    const added = pdf.countPages() - start;
    if (added === 0) throw new Error("There were no pages to insert");
    // Take the new pages back out, then insert them where they belong as one undoable step.
    const objects = this.removePages(Array.from({ length: added }, (_, i) => start + i)).map(
      (e) => e.object,
    );
    const what = sources.length === 1 ? countLabel(added) : `${sources.length} files`;
    return this.insertStep(at === start ? `Add ${what}` : `Insert ${what}`, at, objects);
  }

  /** Copy pages, in the order given, into a new PDF. The open document is unchanged. */
  extractPages(pages: readonly number[]): Uint8Array {
    const pdf = this.requirePdf();
    if (pages.length === 0) throw new Error("Select at least one page");
    const count = pdf.countPages();
    for (const p of pages) {
      if (!Number.isInteger(p) || p < 0 || p >= count)
        throw new Error(`Page ${p + 1} doesn't exist`);
    }
    const out = new mupdf.PDFDocument();
    try {
      const graft = out.newGraftMap();
      for (const p of pages) graft.graftPage(-1, pdf, p);
      const buffer = out.saveToBuffer("garbage");
      try {
        return buffer.asUint8Array().slice();
      } finally {
        buffer.destroy();
      }
    } finally {
      out.destroy();
    }
  }

  /** Split into one new PDF per group of pages. The open document is unchanged. */
  splitPages(groups: readonly (readonly number[])[]): Uint8Array[] {
    if (groups.length === 0) throw new Error("Choose at least one range to split into");
    return groups.map((group) => this.extractPages(group));
  }

  // ---------------------------------------------------------------------------------------
  // Stamps (signatures, initials, dates). Each is added as a stamp annotation on top of the
  // page, so the page's own content is never touched and saving only appends to the file.

  /**
   * Put an image (a signature, initials, a date) on a page as one undoable step. The image
   * is shown upright as the page is displayed, even on rotated pages, and prints.
   */
  addImageStamp(stamp: ImageStamp): EditResult {
    const pdf = this.requirePdf();
    const [index] = this.checkPages([stamp.page]) as [number];
    const labels = STAMP_LABELS[stamp.kind];
    if (!labels) throw new Error(`Unknown stamp kind: ${String(stamp.kind)}`);
    const [x0, y0, x1, y1] = checkRect(stamp.rect);
    if (stamp.image.byteLength === 0) throw new Error("The image is empty");
    if (stamp.image.byteLength > MAX_STAMP_IMAGE_BYTES) {
      throw new Error("The image is too large (10 MB at most)");
    }
    let image: mupdf.Image;
    try {
      image = new mupdf.Image(stamp.image);
    } catch {
      throw new Error("The image couldn't be read. Use a PNG or JPEG file.");
    }
    if (image.getWidth() * image.getHeight() > MAX_STAMP_IMAGE_PIXELS) {
      image.destroy();
      throw new Error(
        "The image has too many pixels (about 16.8 million at most, e.g. 4096 × 4096)",
      );
    }

    let object: mupdf.PDFObject;
    const page = pdf.loadPage(index);
    try {
      const [bx0, by0, bx1, by1] = page.getBounds();
      const slack = 0.5; // Rounding in the UI can put an edge a fraction of a point outside.
      if (x0 < -slack || y0 < -slack || x1 > bx1 - bx0 + slack || y1 > by1 - by0 + slack) {
        throw new Error("The stamp must be inside the page");
      }
      const annot = page.createAnnotation("Stamp");
      annot.setRect([bx0 + x0, by0 + y0, bx0 + x1, by0 + y1]);
      annot.setStampImage(image);
      // Signatures, initials and dates are locked, so other apps don't let them be moved by
      // accident; a picture is ordinary content that may be moved anywhere.
      annot.setFlags(ANNOT_FLAG_PRINT | (stamp.kind === "image" ? 0 : ANNOT_FLAG_LOCKED));
      annot.setContents(stamp.text?.trim() || labels.contents);
      annot.update();
      object = annot.getObject();
      // Not one of the standard stamp names (MuPDF defaults to "Draft"), so no viewer draws
      // a stock "DRAFT" stamp in its place; and no border colour, which an image doesn't use.
      object.put("Name", pdf.newName(`PDFoctopus${capitalise(stamp.kind)}`));
      object.delete("C");
      // MuPDF draws the image upright for an unrotated page. On a rotated page, turn the
      // appearance back by the page's rotation so it's upright as the page is shown. This is
      // set after update(), which would otherwise rebuild the appearance without it.
      const rotation = readRotation(pdf.findPage(index));
      if (rotation !== 0) {
        const t = (rotation * Math.PI) / 180;
        const c = Math.round(Math.cos(t));
        const s = Math.round(Math.sin(t));
        const matrix = pdf.newArray();
        for (const v of [c, s, -s, c, 0, 0]) matrix.push(v);
        object.get("AP").get("N").put("Matrix", matrix);
      }
    } finally {
      page.destroy();
      image.destroy();
    }

    return this.annotationStep(labels.undo, index, [object]);
  }

  /**
   * Add a text stamp ("APPROVED", "DRAFT", …) as one undoable step. It's drawn as vector
   * graphics with a standard font, scaled to fit `rect` and centred in it.
   */
  addTextStamp(stamp: TextStamp): EditResult {
    const pdf = this.requirePdf();
    const [index] = this.checkPages([stamp.page]) as [number];
    const [x0, y0, x1, y1] = checkRect(stamp.rect);
    const text = checkStampText(stamp.text, MAX_STAMP_TEXT, "stamp text");
    if (!text) throw new Error("The stamp needs some text");
    const detail = stamp.detail
      ? checkStampText(stamp.detail, MAX_STAMP_DETAIL, "second line")
      : "";
    const color = checkColor(stamp.color);
    this.checkOnPage(index, [x0, y0, x1, y1], "The stamp must be inside the page");

    let object: mupdf.PDFObject;
    const page = pdf.loadPage(index);
    let annot: mupdf.PDFAnnotation | undefined;
    try {
      const [bx0, by0] = page.getBounds();
      annot = page.createAnnotation("Stamp");
      annot.setRect([bx0 + x0, by0 + y0, bx0 + x1, by0 + y1]);
      annot.setFlags(ANNOT_FLAG_PRINT);
      annot.setContents(detail ? `${text}\n${detail}` : text);
      annot.update();
      object = annot.getObject();
      // Replace MuPDF's stock appearance with ours, after update(), which would redraw it.
      const ap = pdf.newDictionary();
      ap.put(
        "N",
        stampAppearance(
          pdf,
          { text, detail: detail || null, color },
          x1 - x0,
          y1 - y0,
          readRotation(pdf.findPage(index)),
        ),
      );
      object.put("AP", ap);
      // update() resized the box to suit MuPDF's stock stamp; put back the one asked for.
      putRect(pdf, object, transformRect(invert(this.shownTransform(index)), [x0, y0, x1, y1]));
      object.put("Name", pdf.newName(stampName(text)));
      const c = pdf.newArray();
      for (const v of color) c.push(v);
      object.put("C", c);
    } catch (err) {
      if (annot) page.deleteAnnotation(annot);
      throw err;
    } finally {
      page.destroy();
    }
    return this.annotationStep("Add stamp", index, [object]);
  }

  // ---------------------------------------------------------------------------------------
  // Annotations: highlights, drawings, shapes, notes and text boxes, each one undoable step.

  /**
   * The text between two points on a page, as quads in points from the page's top-left
   * corner as shown: what a highlight from `from` to `to` would cover. Empty if there's no
   * text there (e.g. a scanned page).
   */
  selectText(pageIndex: number, from: PagePoint, to: PagePoint): number[][] {
    const [index] = this.checkPages([pageIndex]) as [number];
    const [x0, y0] = this.pageOrigin(index);
    return this.textQuads(index, from, to).map((q) => q.map((v, i) => v - (i % 2 === 0 ? x0 : y0)));
  }

  /** Add a markup annotation as one undoable step. */
  addAnnotation(spec: AnnotationSpec): EditResult {
    const pdf = this.requirePdf();
    const [index] = this.checkPages([spec.page]) as [number];
    const label = ANNOTATION_LABELS[spec.kind];
    if (!label)
      throw new Error(`Unknown annotation kind: ${String((spec as { kind: unknown }).kind)}`);
    const [ox, oy] = this.pageOrigin(index);
    const pt = (p: PagePoint): mupdf.Point => {
      checkPoint(p);
      return [p[0] + ox, p[1] + oy];
    };
    const rect = (r: readonly number[]): mupdf.Rect => {
      const [x0, y0, x1, y1] = checkRect(r);
      return [x0 + ox, y0 + oy, x1 + ox, y1 + oy];
    };

    // Text markup needs text: find it before creating anything.
    let quads: mupdf.Quad[] = [];
    if (spec.kind === "highlight" || spec.kind === "underline" || spec.kind === "strikeout") {
      checkPoint(spec.from);
      checkPoint(spec.to);
      quads = this.textQuads(index, spec.from, spec.to);
      if (quads.length === 0) throw new Error("There's no text there to mark");
    }

    // Check everything before anything is created, so bad input leaves the page untouched.
    validateAnnotation(spec);

    let objects: mupdf.PDFObject[];
    const page = pdf.loadPage(index);
    let annot: mupdf.PDFAnnotation | undefined;
    try {
      switch (spec.kind) {
        case "highlight":
        case "underline":
        case "strikeout": {
          const type = {
            highlight: "Highlight",
            underline: "Underline",
            strikeout: "StrikeOut",
          } as const;
          annot = page.createAnnotation(type[spec.kind]);
          annot.setColor(checkColor(spec.color));
          annot.setQuadPoints(quads);
          break;
        }
        case "ink": {
          const strokes = spec.strokes.filter((s) => s.length > 0);
          const count = strokes.reduce((n, s) => n + s.length, 0);
          if (count === 0) throw new Error("There's nothing drawn");
          if (count > MAX_INK_POINTS) throw new Error("The drawing has too many points");
          annot = page.createAnnotation("Ink");
          annot.setColor(checkColor(spec.color));
          annot.setBorderWidth(checkWidth(spec.width));
          annot.setInkList(strokes.map((s) => s.map(pt)));
          break;
        }
        case "rectangle":
        case "ellipse": {
          annot = page.createAnnotation(spec.kind === "rectangle" ? "Square" : "Circle");
          annot.setRect(rect(spec.rect));
          annot.setColor(checkColor(spec.color));
          annot.setBorderWidth(checkWidth(spec.width));
          break;
        }
        case "line":
        case "arrow": {
          const a = pt(spec.from);
          const b = pt(spec.to);
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) throw new Error("The line is too short");
          annot = page.createAnnotation("Line");
          annot.setLine(a, b);
          annot.setColor(checkColor(spec.color));
          annot.setBorderWidth(checkWidth(spec.width));
          if (spec.kind === "arrow") annot.setLineEndingStyles("None", "ClosedArrow");
          break;
        }
        case "note": {
          const [x, y] = pt(spec.at);
          annot = page.createAnnotation("Text");
          annot.setRect([x, y, x + 20, y + 20]);
          annot.setIcon("Comment");
          annot.setColor(checkColor(spec.color));
          annot.setContents(checkText(spec.text));
          break;
        }
        case "text": {
          if (!(spec.size >= 4 && spec.size <= 144)) throw new Error("Text size must be 4 to 144");
          annot = page.createAnnotation("FreeText");
          annot.setRect(rect(spec.rect));
          annot.setDefaultAppearance("Helv", spec.size, checkColor(spec.color));
          annot.setContents(checkText(spec.text));
          break;
        }
        case "redact": {
          annot = page.createAnnotation("Redact");
          annot.setRect(rect(spec.rect));
          annot.setContents("Marked for redaction");
          break;
        }
        case "whiteout": {
          annot = page.createAnnotation("Square");
          annot.setRect(rect(spec.rect));
          annot.setColor([]);
          annot.setInteriorColor([1, 1, 1]);
          annot.setBorderWidth(0);
          annot.setContents("White-out");
          break;
        }
      }
      annot.setFlags(ANNOT_FLAG_PRINT);
      annot.update();
      const object = annot.getObject();
      // MuPDF gives a sticky note a pop-up window annotation: it comes and goes with the note.
      const popup = object.get("Popup");
      objects = popup.isIndirect() ? [object, popup] : [object];
    } catch (err) {
      if (annot) page.deleteAnnotation(annot);
      throw err;
    } finally {
      page.destroy();
    }
    return this.annotationStep(label, index, objects);
  }

  /** The annotations on a page that can be selected, bottom first (as they're drawn). */
  listAnnotations(pageIndex: number): AnnotationInfo[] {
    const pdf = this.requirePdf();
    const [index] = this.checkPages([pageIndex]) as [number];
    const shown = this.shownTransform(index);
    const annots = pdf.findPage(index).get("Annots");
    const list: AnnotationInfo[] = [];
    if (!annots.isArray()) return list;
    for (let i = 0; i < annots.length; i++) {
      const object = annots.get(i);
      if (!isListed(object)) continue;
      const editableText = canEditText(object);
      const contents = object.get("Contents");
      list.push({
        id: object.asIndirect(),
        label: describe(object),
        rect: transformRect(shown, readRect(object)),
        color: readColor(object),
        text: editableText ? (contents.isString() ? contents.asString() : "") : null,
        canResize: canResize(object),
        canRecolor: canRecolor(object),
        canEditText: editableText,
      });
    }
    return list;
  }

  /**
   * Delete an annotation (and a note's pop-up window) as one undoable step. Undo puts the same
   * objects back where they were, so the stacking order is kept.
   */
  deleteAnnotation(pageIndex: number, id: number): EditResult {
    const pdf = this.requirePdf();
    const [index] = this.checkPages([pageIndex]) as [number];
    const object = this.findAnnotation(index, id);
    const annots = annotsOf(pdf, index);
    // The annotation and any pop-up that belongs to it, with their places in /Annots.
    const removed: { at: number; object: mupdf.PDFObject }[] = [];
    for (let i = 0; i < annots.length; i++) {
      const item = annots.get(i);
      const parent = item.get("Parent");
      const isOwnPopup =
        subtype(item) === "Popup" && parent.isIndirect() && parent.asIndirect() === id;
      if (item.asIndirect() === id || isOwnPopup) removed.push({ at: i, object: item });
    }
    return this.run({
      label: `Delete ${describe(object)}`,
      redo: () => {
        for (const { object: item } of removed.slice().reverse()) {
          detachAnnotation(pdf, index, item);
        }
      },
      undo: () => {
        const list = annotsOf(pdf, index);
        for (const { at, object: item } of removed) insertAt(list, at, item);
      },
    });
  }

  /**
   * Move, resize, recolour or change the text of an annotation, as one undoable step.
   * Moving shifts its coordinates and keeps its appearance, so annotations from other apps
   * move unchanged. Other changes have MuPDF redraw it into a new appearance stream, so the
   * old one is still there for undo.
   */
  editAnnotation(pageIndex: number, id: number, change: AnnotationChange): EditResult {
    const pdf = this.requirePdf();
    const [index] = this.checkPages([pageIndex]) as [number];
    const object = this.findAnnotation(index, id);
    const noun = describe(object);
    const shown = this.shownTransform(index);
    const toPdf = invert(shown);

    // Check everything before changing anything.
    let move: [number, number] | null = null;
    let resizeTo: [number, number, number, number] | null = null;
    if (change.rect) {
      const target = checkRect(change.rect);
      const current = transformRect(shown, readRect(object));
      const sameSize =
        Math.abs(target[2] - target[0] - (current[2] - current[0])) < 0.01 &&
        Math.abs(target[3] - target[1] - (current[3] - current[1])) < 0.01;
      this.checkOnPage(index, target, "The annotation must stay on the page", sameSize);
      if (sameSize) {
        const dx = target[0] - current[0];
        const dy = target[1] - current[1];
        // Only the linear part: a shift has no origin.
        const pdx = dx * toPdf[0] + dy * toPdf[2];
        const pdy = dx * toPdf[1] + dy * toPdf[3];
        if (Math.abs(pdx) >= 0.001 || Math.abs(pdy) >= 0.001) move = [pdx, pdy];
      } else {
        if (!canResize(object)) throw new Error(`A ${noun} can't be resized`);
        if (target[2] - target[0] < 2 || target[3] - target[1] < 2) {
          throw new Error("The annotation is too small");
        }
        resizeTo = transformRect(toPdf, target);
      }
    }
    let color: RgbColor | null = null;
    if (change.color) {
      if (!canRecolor(object)) throw new Error(`A ${noun}'s colour can't be changed`);
      const next = checkColor(change.color);
      const old = readColor(object);
      color = old?.every((v, i) => Math.abs(v - (next[i] as number)) < 0.001) ? null : next;
    }
    let text: string | null = null;
    if (change.text !== undefined) {
      if (!canEditText(object)) throw new Error(`A ${noun} has no text to edit`);
      text = checkText(change.text);
      const old = object.get("Contents");
      if (old.isString() && old.asString() === text) text = null;
    }
    const changes = [move, resizeTo, color, text].filter((c) => c !== null).length;
    if (changes === 0) return this.run({ label: "", undo() {}, redo() {} }, true);

    const popup = object.get("Popup");
    const popupRect = () => (popup.isIndirect() ? readRect(popup) : null);
    const before = { entries: snapshot(pdf, object), popup: popupRect() };

    const page = pdf.loadPage(index);
    try {
      if (move) {
        shiftAnnotation(pdf, object, move[0], move[1]);
        if (popup.isIndirect() && popup.get("Rect").isArray()) {
          shiftAnnotation(pdf, popup, move[0], move[1]);
        }
      }
      let redraw = false;
      if (resizeTo) {
        putRect(pdf, object, resizeTo);
        // A stamp's appearance (a signature image) scales to its box; shapes and text boxes
        // are redrawn at the new size, without the old inner margins.
        if (subtype(object) !== "Stamp") {
          object.delete("RD");
          redraw = true;
        }
      }
      const annot = page.getAnnotations().find((a) => a.getObject().asIndirect() === id);
      if (!annot) throw new Error("That annotation is not on the page");
      if (color) {
        if (subtype(object) === "FreeText") {
          const da = annot.getDefaultAppearance();
          annot.setDefaultAppearance(da.font || "Helv", da.size || 12, color);
        } else {
          annot.setColor(color);
        }
        redraw = true;
      }
      if (text !== null) {
        annot.setContents(text);
        // Some viewers show rich text, when there is any, instead of the plain text.
        object.delete("RC");
        if (subtype(object) === "FreeText") redraw = true;
      }
      if (redraw) {
        // Without an appearance MuPDF draws a new stream, leaving the old one for undo.
        object.delete("AP");
        annot.update();
      }
    } catch (err) {
      restore(pdf, object, before.entries);
      if (before.popup && popup.isIndirect()) putRect(pdf, popup, before.popup);
      throw err;
    } finally {
      page.destroy();
    }
    const after = { entries: snapshot(pdf, object), popup: popupRect() };

    const label =
      changes > 1
        ? `Edit ${noun}`
        : move
          ? `Move ${noun}`
          : resizeTo
            ? `Resize ${noun}`
            : color
              ? `Recolour ${noun}`
              : `Edit ${noun}`;
    let applied = true;
    const apply = (state: typeof before) => {
      restore(pdf, object, state.entries);
      if (state.popup && popup.isIndirect()) putRect(pdf, popup, state.popup);
    };
    return this.run({
      label,
      redo: () => {
        if (applied) return;
        apply(after);
        applied = true;
      },
      undo: () => {
        apply(before);
        applied = false;
      },
    });
  }

  // ---------------------------------------------------------------------------------------
  // Forms: fill in fields, and flatten a form into ordinary page content.

  /** The form field boxes on a page, in the order the page lists them. */
  listFields(pageIndex: number): FormField[] {
    const pdf = this.requirePdf();
    const [index] = this.checkPages([pageIndex]) as [number];
    const shown = this.shownTransform(index);
    const page = pdf.loadPage(index);
    try {
      return page.getWidgets().map((w) => {
        const object = w.getObject();
        const kind = fieldKind(w);
        const flags = w.getFieldFlags();
        const choice = kind === "combobox" || kind === "listbox";
        const labels = choice ? w.getOptions(false) : [];
        const values = choice ? w.getOptions(true) : [];
        const maxLength = kind === "text" ? w.getMaxLen() : 0;
        return {
          id: object.asIndirect(),
          name: w.getName(),
          label: w.getLabel() || w.getName(),
          kind,
          rect: transformRect(shown, readRect(object)),
          value: kind === "checkbox" || kind === "radio" ? onState(object) : w.getValue(),
          checked: (kind === "checkbox" || kind === "radio") && isOn(object),
          options: labels.map((label, i) => ({ label, value: values[i] ?? label })),
          readOnly: w.isReadOnly(),
          required: (flags & mupdf.PDFWidget.FIELD_IS_REQUIRED) !== 0,
          multiline: kind === "text" && w.isMultiline(),
          editable: kind === "combobox" && (flags & mupdf.PDFWidget.CH_FIELD_IS_EDIT) !== 0,
          maxLength: maxLength > 0 ? maxLength : null,
          partialName: textOf(fieldOf(object).get("T")),
          defaultValue: textOf(inherited(object, "DV")),
          date: kind === "text" && isDateField(object),
        };
      });
    } finally {
      page.destroy();
    }
  }

  /**
   * Fill in a form field, as one undoable step: text for a text field, true or false for a
   * checkbox, true to choose a radio button, an option's value for a dropdown or list. In a
   * hybrid form, the XFA copy is removed at the same time, so apps that would show it (Adobe
   * Reader) show what was typed instead.
   */
  setFieldValue(pageIndex: number, id: number, value: string | boolean): EditResult {
    const pdf = this.requirePdf();
    const [index] = this.checkPages([pageIndex]) as [number];
    const page = pdf.loadPage(index);
    let before: ReturnType<typeof snapshotField> | null = null;
    try {
      const widget = page.getWidgets().find((w) => w.getObject().asIndirect() === id);
      if (!widget) throw new Error("That form field is not on the page");
      const kind = fieldKind(widget);
      if (!isFillable(kind)) throw new Error("This kind of field can't be filled in here");
      if (widget.isReadOnly()) throw new Error("This field is read-only");
      const object = widget.getObject();
      const objects = fieldObjects(fieldOf(object));

      // Check the value, and whether it changes anything, before touching the field.
      let change: (() => void) | null = null;
      if (kind === "text") {
        if (typeof value !== "string") throw new Error("A text field takes text");
        if (value.length > MAX_ANNOTATION_TEXT) throw new Error("The text is too long");
        const max = widget.getMaxLen();
        if (max > 0 && value.length > max) {
          throw new Error(`This field takes ${max} characters at most`);
        }
        if (widget.getValue() !== value) change = () => widget.setTextValue(value);
      } else if (kind === "checkbox") {
        if (typeof value !== "boolean") throw new Error("A checkbox is ticked or not");
        if (isOn(object) !== value) change = () => widget.toggle();
      } else if (kind === "radio") {
        if (value !== true) throw new Error("A radio button can only be chosen");
        if (!isOn(object)) change = () => widget.toggle();
      } else {
        if (typeof value !== "string") throw new Error("Choose one of the options");
        const editable =
          kind === "combobox" && (widget.getFieldFlags() & mupdf.PDFWidget.CH_FIELD_IS_EDIT) !== 0;
        if (!editable && !widget.getOptions(true).includes(value)) {
          throw new Error("That isn't one of the options");
        }
        if (widget.getValue() !== value) change = () => widget.setChoiceValue(value);
      }
      if (!change) return this.run({ label: "", undo() {}, redo() {} }, true);

      const form = acroForm(pdf);
      const xfa = form?.get("XFA");
      const xfaBefore = xfa && !xfa.isNull() ? copyDirect(pdf, xfa) : null;
      before = snapshotField(pdf, objects);
      change();
      widget.update();
      // The field's other boxes on this page show the new value too. (MuPDF already redraws a
      // text field's boxes on every page; forms.test.ts checks that.)
      const ids = new Set(objects.map((o) => o.asIndirect()));
      for (const other of page.getWidgets()) {
        if (other !== widget && ids.has(other.getObject().asIndirect())) other.update();
      }
      if (xfaBefore) form?.delete("XFA");
      const after = snapshotField(pdf, objects);
      const saved = before;

      let applied = true;
      return this.run({
        label: kind === "checkbox" || kind === "radio" ? "Change form field" : "Fill in form field",
        redo: () => {
          if (applied) return;
          restoreField(pdf, after);
          if (xfaBefore) form?.delete("XFA");
          applied = true;
        },
        undo: () => {
          restoreField(pdf, saved);
          if (xfaBefore) form?.put("XFA", copyDirect(pdf, xfaBefore));
          applied = false;
        },
      });
    } catch (err) {
      if (before) restoreField(pdf, before);
      throw err;
    } finally {
      page.destroy();
    }
  }

  /**
   * Flatten the form, as one undoable step: every field box becomes ordinary page content
   * showing its current value, and the form is gone, so nothing can be changed any more.
   */
  flattenForm(): EditResult {
    const pdf = this.requirePdf();
    if (this.formInfo().fields === 0) throw new Error("There's no form to flatten");
    const root = pdf.getTrailer().get("Root");
    const pageCount = pdf.countPages();
    const capture = () => ({
      pages: Array.from({ length: pageCount }, (_, i) => capturePage(pdf, i)),
      form: root.get("AcroForm").isNull() ? null : copyContainer(pdf, root.get("AcroForm")),
    });
    const putBack = (state: ReturnType<typeof capture>) => {
      state.pages.forEach((page, i) => {
        restorePage(pdf, i, page);
      });
      if (state.form === null) root.delete("AcroForm");
      else root.put("AcroForm", copyDirect(pdf, state.form));
    };
    const before = capture();
    // A form that asks apps to draw its fields (NeedAppearances) may have empty or stale
    // appearances; flattening keeps only appearances, so draw the text ones first. Each gets a
    // new stream (MuPDF would otherwise rewrite the old one in place), so undo can put the old
    // ones back.
    const redrawn = this.redrawFieldsIfNeeded(pdf);
    try {
      pdf.bake(false, true);
      // Whatever MuPDF leaves of the form, there are no fields now.
      root.delete("AcroForm");
    } catch (err) {
      putBack(before);
      restoreField(pdf, redrawn);
      throw err;
    }
    const after = capture();
    let applied = true;
    return this.run({
      label: "Flatten form",
      redo: () => {
        if (applied) return;
        putBack(after);
        applied = true;
      },
      undo: () => {
        putBack(before);
        restoreField(pdf, redrawn);
        applied = false;
      },
    });
  }

  /**
   * If the form asks apps to draw its fields (NeedAppearances), give every text and choice
   * field box a freshly drawn appearance. Returns what they had, to put back on undo.
   */
  private redrawFieldsIfNeeded(pdf: mupdf.PDFDocument): FieldSnapshot {
    const form = acroForm(pdf);
    const need = form?.get("NeedAppearances");
    if (!need?.isBoolean() || !need.asBoolean()) return [];
    const snapshot: FieldSnapshot = [];
    try {
      for (let i = 0; i < pdf.countPages(); i++) {
        const page = pdf.loadPage(i);
        try {
          for (const w of page.getWidgets()) {
            const kind = fieldKind(w);
            if (kind !== "text" && kind !== "combobox" && kind !== "listbox") continue;
            const object = w.getObject();
            snapshot.push(...snapshotField(pdf, [object]));
            object.delete("AP");
            w.update();
          }
        } finally {
          page.destroy();
        }
      }
    } catch (err) {
      // Put back the appearances already redrawn, so a failure changes nothing.
      restoreField(pdf, snapshot);
      throw err;
    }
    return snapshot;
  }

  // ---------------------------------------------------------------------------------------
  // Building forms: add fields, change their properties, delete them; each one undoable step.

  /** Add a form field (a box on a page), as one undoable step. */
  addField(spec: NewField): EditResult {
    const pdf = this.requirePdf();
    const [index] = this.checkPages([spec.page]) as [number];
    const [x0, y0, x1, y1] = checkRect(spec.rect);
    if (x1 - x0 < MIN_FIELD_SIZE || y1 - y0 < MIN_FIELD_SIZE) {
      throw new Error("The field is too small");
    }
    const name = checkFieldName(spec.name);
    const existingForm = acroForm(pdf);
    const group = spec.kind === "radio" ? radioGroup(existingForm, name) : null;
    if (!group && fieldNames(existingForm).has(name)) {
      throw new Error(`There's already a field called "${name}"`);
    }
    if (group) {
      const value = checkRadioValue(spec.value);
      if (radioValues(group).includes(value)) {
        throw new Error(`The group "${name}" already has a button with the value "${value}"`);
      }
    }
    const defaultValue = spec.defaultValue?.trim() ?? "";
    if (defaultValue.length > MAX_ANNOTATION_TEXT) throw new Error("The default value is too long");
    if (
      spec.kind === "combobox" &&
      defaultValue &&
      !checkOptions(spec.options).includes(defaultValue)
    ) {
      throw new Error("The default value must be one of the options");
    }

    const pageObject = pdf.findPage(index);
    const before = snapshotEntries(pdf, entriesForAdd(pdf, pageObject, group));
    let widget: mupdf.PDFObject | null = null;
    try {
      const form = ensureForm(pdf);
      // A hybrid form's XFA copy would show the form as it was (in Adobe Reader).
      form.delete("XFA");
      const rect = transformRect(invert(this.shownTransform(index)), [x0, y0, x1, y1]);
      const built = buildField(pdf, pageObject, { ...spec, name }, name, rect, group);
      widget = built.widget;
      if (built.field) form.get("Fields").push(built.field);
      let annots = pageObject.get("Annots");
      if (!annots.isArray()) {
        annots = pdf.newArray();
        pageObject.put("Annots", annots);
      }
      annots.push(widget);
      // Draw the field, with its default value if it has one.
      const page = pdf.loadPage(index);
      try {
        const w = page
          .getWidgets()
          .find((x) => x.getObject().asIndirect() === widget?.asIndirect());
        if (!w) throw new Error("The new field couldn't be found on the page");
        if (
          defaultValue &&
          spec.kind !== "checkbox" &&
          spec.kind !== "radio" &&
          spec.kind !== "signature"
        ) {
          widget.put("DV", pdf.newString(defaultValue));
          if (spec.kind === "combobox") w.setChoiceValue(defaultValue);
          else w.setTextValue(defaultValue);
        }
        w.setRect(w.getRect()); // so MuPDF draws it
        w.update();
      } finally {
        page.destroy();
      }
    } catch (err) {
      restoreEntries(pdf, before);
      throw err;
    }
    const after = snapshotEntries(pdf, entriesForAdd(pdf, pageObject, group));
    return this.entryStep(
      spec.kind === "radio" && group ? "Add radio button" : "Add form field",
      before,
      after,
    );
  }

  /** Change a field's name, whether it's required, its default value or its options. */
  updateField(pageIndex: number, id: number, changes: FieldChanges): EditResult {
    const pdf = this.requirePdf();
    const [index] = this.checkPages([pageIndex]) as [number];
    const page = pdf.loadPage(index);
    try {
      const widget = page.getWidgets().find((w) => w.getObject().asIndirect() === id);
      if (!widget) throw new Error("That form field is not on the page");
      const kind = fieldKind(widget);
      const field = fieldOf(widget.getObject());
      const objects = fieldObjects(field);

      // Check everything before changing anything.
      let name: string | null = null;
      if (changes.name !== undefined) {
        name = checkFieldName(changes.name);
        const full = renamed(field, name);
        const other = fieldNames(acroForm(pdf)).get(full);
        if (other && other.asIndirect() !== field.asIndirect()) {
          throw new Error(`There's already a field called "${full}"`);
        }
        if (textOf(field.get("T")) === name) name = null;
      }
      let options: string[] | null = null;
      if (changes.options !== undefined) {
        if (kind !== "combobox" && kind !== "listbox")
          throw new Error("Only a dropdown or list has options");
        options = checkOptions(changes.options);
        const now = widget.getOptions(true);
        if (now.length === options.length && now.every((o, i) => o === options?.[i]))
          options = null;
      }
      let defaultValue: string | null = null;
      if (changes.defaultValue !== undefined) {
        if (kind !== "text" && kind !== "combobox" && kind !== "listbox") {
          throw new Error("Only a text field, dropdown or list has a default value");
        }
        defaultValue = changes.defaultValue.trim();
        if (defaultValue.length > MAX_ANNOTATION_TEXT)
          throw new Error("The default value is too long");
        const allowed = options ?? widget.getOptions(true);
        if (kind !== "text" && defaultValue && !allowed.includes(defaultValue)) {
          throw new Error("The default value must be one of the options");
        }
        if (textOf(inherited(widget.getObject(), "DV")) === defaultValue) defaultValue = null;
      }
      const ffNow = inherited(widget.getObject(), "Ff");
      const flags = ffNow.isNumber() ? ffNow.asNumber() : 0;
      const required =
        changes.required !== undefined &&
        changes.required !== ((flags & FIELD_FLAGS.required) !== 0)
          ? changes.required
          : null;
      if (name === null && options === null && defaultValue === null && required === null) {
        return this.run({ label: "", undo() {}, redo() {} }, true);
      }

      const form = acroForm(pdf);
      const keys: [mupdf.PDFObject, string][] = [
        [field, "T"],
        [field, "Ff"],
        [field, "DV"],
        [field, "Opt"],
      ];
      if (form) keys.push([form, "XFA"]);
      const beforeEntries = snapshotEntries(pdf, keys);
      const beforeValue = snapshotField(pdf, objects);
      try {
        // A hybrid form's XFA copy would show the form as it was (in Adobe Reader).
        form?.delete("XFA");
        if (name !== null) field.put("T", pdf.newString(name));
        if (required !== null) {
          field.put("Ff", required ? flags | FIELD_FLAGS.required : flags & ~FIELD_FLAGS.required);
        }
        if (options !== null) {
          // An option kept from before keeps its label, if it had its own (["CA", "California"]).
          const values = widget.getOptions(true);
          const labels = widget.getOptions(false);
          const opt = pdf.newArray();
          for (const o of options) {
            const i = values.indexOf(o);
            const label = i >= 0 ? labels[i] : undefined;
            if (label !== undefined && label !== o) {
              const pair = pdf.newArray();
              pair.push(pdf.newString(o));
              pair.push(pdf.newString(label));
              opt.push(pair);
            } else opt.push(pdf.newString(o));
          }
          field.put("Opt", opt);
          // A default that's no longer an option is cleared (unless a new one is given).
          const dv = textOf(inherited(widget.getObject(), "DV"));
          if (defaultValue === null && dv && !options.includes(dv)) field.delete("DV");
          // An answer that's no longer an option is cleared, unless the dropdown takes typed
          // answers.
          const editable = (flags & mupdf.PDFWidget.CH_FIELD_IS_EDIT) !== 0;
          if (!editable && widget.getValue() && !options.includes(widget.getValue())) {
            widget.setChoiceValue("");
          }
        }
        if (defaultValue !== null) {
          const old = textOf(inherited(widget.getObject(), "DV"));
          if (defaultValue) field.put("DV", pdf.newString(defaultValue));
          else field.delete("DV");
          // A field still showing its old default (or nothing) shows the new one.
          const now = widget.getValue();
          if (now === "" || now === old) {
            if (kind === "text") widget.setTextValue(defaultValue);
            else widget.setChoiceValue(defaultValue);
          }
        }
        widget.setRect(widget.getRect());
        widget.update();
      } catch (err) {
        restoreEntries(pdf, beforeEntries);
        restoreField(pdf, beforeValue);
        throw err;
      }
      const afterEntries = snapshotEntries(pdf, keys);
      const afterValue = snapshotField(pdf, objects);
      let applied = true;
      return this.run({
        label: "Change form field",
        redo: () => {
          if (applied) return;
          restoreEntries(pdf, afterEntries);
          restoreField(pdf, afterValue);
          applied = true;
        },
        undo: () => {
          restoreEntries(pdf, beforeEntries);
          restoreField(pdf, beforeValue);
          applied = false;
        },
      });
    } finally {
      page.destroy();
    }
  }

  /**
   * Delete a form field's box, as one undoable step. A field with no boxes left (a radio
   * group whose last button goes) is removed from the form too.
   */
  deleteField(pageIndex: number, id: number): EditResult {
    const pdf = this.requirePdf();
    const [index] = this.checkPages([pageIndex]) as [number];
    const pageObject = pdf.findPage(index);
    const annots = pageObject.get("Annots");
    let widget: mupdf.PDFObject | null = null;
    if (annots.isArray()) {
      for (let i = 0; i < annots.length; i++) {
        const a = annots.get(i);
        const subtype = a.get("Subtype");
        if (a.asIndirect() === id && subtype.isName() && subtype.asName() === "Widget") widget = a;
      }
    }
    if (!widget) throw new Error("That form field is not on the page");
    const form = acroForm(pdf);
    // Going up from the box: each node is removed from its parent's /Kids (or the form's
    // /Fields) while that leaves the parent with no kids.
    const removals: { node: mupdf.PDFObject; container: mupdf.PDFObject; key: string }[] = [];
    let node = widget;
    for (let depth = 0; depth < 32; depth++) {
      const parent = node.get("Parent");
      if (parent.isNull()) {
        if (form) removals.push({ node, container: form, key: "Fields" });
        break;
      }
      removals.push({ node, container: parent, key: "Kids" });
      const kids = parent.get("Kids");
      if (!kids.isArray() || kids.length > 1) break;
      node = parent;
    }
    const entries: [mupdf.PDFObject, string][] = [[pageObject, "Annots"]];
    for (const r of removals) entries.push([r.container, r.key]);
    // A radio group whose chosen button goes has no choice left.
    // A radio group whose chosen button goes has no choice left. (A checkbox with several boxes
    // keeps its value: the others still show it.)
    const parent = widget.get("Parent");
    const parentFlags = parent.isNull() ? null : parent.get("Ff");
    const group =
      parentFlags?.isNumber() && (parentFlags.asNumber() & mupdf.PDFWidget.BTN_FIELD_IS_RADIO) !== 0
        ? parent
        : null;
    if (group) entries.push([group, "V"]);
    if (form) entries.push([form, "XFA"]);
    const before = snapshotEntries(pdf, entries);
    try {
      // A hybrid form's XFA copy would show the form as it was (in Adobe Reader).
      form?.delete("XFA");
      removeFrom(pageObject.get("Annots"), widget);
      for (const r of removals) removeFrom(r.container.get(r.key), r.node);
      const state = widget.get("AS");
      const v = group ? group.get("V") : null;
      if (
        v?.isName() &&
        state.isName() &&
        v.asName() === state.asName() &&
        state.asName() !== "Off"
      ) {
        group?.put("V", pdf.newName("Off"));
      }
    } catch (err) {
      restoreEntries(pdf, before);
      throw err;
    }
    const after = snapshotEntries(pdf, entries);
    return this.entryStep("Delete form field", before, after);
  }

  /** The full names of every field in the form, to suggest a new one that isn't taken. */
  listFieldNames(): string[] {
    return [...fieldNames(acroForm(this.requirePdf())).keys()];
  }

  /** An undoable step that puts dictionary entries back as they were (and forward again). */
  private entryStep(
    label: string,
    before: ReturnType<typeof snapshotEntries>,
    after: ReturnType<typeof snapshotEntries>,
  ): EditResult {
    const pdf = this.requirePdf();
    let applied = true;
    return this.run({
      label,
      redo: () => {
        if (applied) return;
        restoreEntries(pdf, after);
        applied = true;
      },
      undo: () => {
        restoreEntries(pdf, before);
        applied = false;
      },
    });
  }

  /** How many form field boxes there are, and whether the form has XFA. */
  private formInfo(): FormInfo {
    const pdf = this.doc?.asPDF();
    if (!pdf) return { fields: 0, xfa: "none" };
    let fields = 0;
    for (let i = 0; i < pdf.countPages(); i++) {
      const annots = pdf.findPage(i).get("Annots");
      if (!annots.isArray()) continue;
      for (let j = 0; j < annots.length; j++) {
        if (subtype(annots.get(j)) === "Widget") fields++;
      }
    }
    const form = acroForm(pdf);
    const hasXfa = form !== null && !form.get("XFA").isNull();
    return { fields, xfa: hasXfa ? (fields > 0 ? "hybrid" : "dynamic") : "none" };
  }

  // ---------------------------------------------------------------------------------------
  // Redaction: mark areas (or search results), then apply, which removes the text, images and
  // drawings under the marks for good. Applying is one undoable step until the file is saved;
  // saving then rewrites the whole file, so nothing removed is left in it.

  /**
   * Mark text for redaction, such as every search result, as one undoable step. Each entry's
   * quads are in points from the page's top-left corner as shown (as search returns them).
   */
  markForRedaction(
    marks: readonly { page: number; quads: readonly (readonly number[])[] }[],
  ): EditResult {
    const pdf = this.requirePdf();
    if (marks.length === 0) throw new Error("There's nothing to mark");
    if (marks.length > MAX_SEARCH_HITS) throw new Error("There are too many to mark at once");
    const quadCount = marks.reduce((n, m) => n + m.quads.length, 0);
    if (quadCount > MAX_REDACTION_QUADS) throw new Error("There are too many to mark at once");
    // Check everything first, so a bad entry leaves every page untouched.
    const checked = marks.map((m) => {
      const [index] = this.checkPages([m.page]) as [number];
      if (m.quads.length === 0) throw new Error("A mark has no area");
      for (const q of m.quads) {
        if (q.length !== 8 || !q.every((v) => Number.isFinite(v))) {
          throw new Error("A mark's position isn't valid");
        }
      }
      return { index, quads: m.quads };
    });
    const added: { index: number; object: mupdf.PDFObject }[] = [];
    try {
      for (const { index, quads } of checked) {
        const [ox, oy] = this.pageOrigin(index);
        const page = pdf.loadPage(index);
        try {
          const annot = page.createAnnotation("Redact");
          // Tracked straight away, so it's taken off again if anything below fails.
          added.push({ index, object: annot.getObject() });
          annot.setQuadPoints(
            quads.map((q) => q.map((v, i) => v + (i % 2 === 0 ? ox : oy)) as mupdf.Quad),
          );
          annot.setContents("Marked for redaction");
          annot.update();
        } finally {
          page.destroy();
        }
      }
    } catch (err) {
      for (const { index, object } of added) detachAnnotation(pdf, index, object);
      throw err;
    }
    let attached = true;
    return this.run({
      label:
        added.length === 1 ? "Mark for redaction" : `Mark ${added.length} places for redaction`,
      redo: () => {
        if (attached) return;
        for (const { index, object } of added) attachAnnotation(pdf, index, object);
        attached = true;
      },
      undo: () => {
        for (const { index, object } of added) detachAnnotation(pdf, index, object);
        attached = false;
      },
    });
  }

  /**
   * Apply every redaction mark, as one undoable step: the text, images and drawings under the
   * marks are removed from the pages' content and black boxes drawn in their place, and any
   * annotation under a mark (a comment, a highlight, a link) is deleted too. From then on every
   * save rewrites the whole file (see DocumentInfo.redacted).
   */
  applyRedactions(): RedactionResult {
    const pdf = this.requirePdf();
    const pages: number[] = [];
    for (let i = 0; i < pdf.countPages(); i++) {
      if (redactionRegions(pdf.findPage(i)).length > 0) pages.push(i);
    }
    if (pages.length === 0) throw new Error("Nothing is marked for redaction");

    // A form field's value lives in the form, not only on the page: deleting its box would
    // leave the value in the file. Refuse rather than leave something behind.
    for (const index of pages) {
      const page = pdf.findPage(index);
      const regions = redactionRegions(page);
      const annots = page.get("Annots");
      for (let i = 0; i < annots.length; i++) {
        const item = annots.get(i);
        if (subtype(item) === "Widget" && item.get("Rect").isArray()) {
          if (regions.some((r) => overlaps(r, readRect(item)))) {
            throw new Error(
              `A redaction mark on page ${index + 1} covers a form field. Flatten the form first (its fields become ordinary page content, which can be redacted), or move that mark.`,
            );
          }
        }
      }
    }

    const capture = (index: number) => capturePage(pdf, index);
    const putBack = (index: number, state: PageState) => restorePage(pdf, index, state);

    const before = pages.map(capture);
    let removedAnnotations = 0;
    // Annotations deleted from under the marks, and their entries. Taking them off the page
    // isn't enough: a reply (/IRT), the structure tree of a tagged PDF or anything else can
    // still point at one, and a full save keeps whatever is pointed at. So each is emptied, and
    // its entries kept here (in memory only) for undo.
    const emptied: { object: mupdf.PDFObject; entries: [string, mupdf.PDFObject][] }[] = [];
    const empty = (object: mupdf.PDFObject) => {
      const entries: [string, mupdf.PDFObject][] = [];
      object.forEach((value, key) => {
        entries.push([String(key), copyDirect(pdf, value)]);
      });
      for (const [key] of entries) object.delete(key);
      emptied.push({ object, entries });
    };
    const refill = () => {
      for (const { object, entries } of emptied) {
        for (const [key, value] of entries) object.put(key, copyDirect(pdf, value));
      }
    };
    const reEmpty = () => {
      for (const { object, entries } of emptied) for (const [key] of entries) object.delete(key);
    };
    try {
      for (const index of pages) {
        const page = pdf.findPage(index);
        const regions = redactionRegions(page);
        // Annotations under a mark go first (and a note's pop-up with it).
        const annots = page.get("Annots");
        const doomed = new Set<number>();
        for (let i = 0; i < annots.length; i++) {
          const item = annots.get(i);
          const type = subtype(item);
          if (type === "Redact" || type === "Popup" || !item.get("Rect").isArray()) continue;
          if (regions.some((r) => overlaps(r, readRect(item)))) doomed.add(item.asIndirect());
        }
        for (let i = annots.length - 1; i >= 0; i--) {
          const item = annots.get(i);
          const parent = item.get("Parent");
          const ownPopup =
            subtype(item) === "Popup" && parent.isIndirect() && doomed.has(parent.asIndirect());
          if (doomed.has(item.asIndirect()) || ownPopup) {
            annots.delete(i);
            empty(item);
            if (!ownPopup) removedAnnotations++;
          }
        }
        const loaded = pdf.loadPage(index);
        try {
          loaded.applyRedactions(
            true,
            mupdf.PDFPage.REDACT_IMAGE_PIXELS,
            // Any drawing a mark touches goes, even partly: what's outside the mark goes too,
            // rather than leave something recoverable under the black box.
            mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED,
            mupdf.PDFPage.REDACT_TEXT_REMOVE,
          );
        } finally {
          loaded.destroy();
        }
      }
    } catch (err) {
      refill();
      pages.forEach((index, i) => {
        putBack(index, before[i] as PageState);
      });
      throw err;
    }
    const after = pages.map(capture);
    this.redacted = true;

    let applied = true;
    const result = this.run({
      label: "Apply redactions",
      redo: () => {
        if (applied) return;
        reEmpty();
        pages.forEach((index, i) => {
          putBack(index, after[i] as PageState);
        });
        applied = true;
      },
      undo: () => {
        refill();
        pages.forEach((index, i) => {
          putBack(index, before[i] as PageState);
        });
        applied = false;
      },
    });
    return { ...result, pages: pages.length, annotationsRemoved: removedAnnotations };
  }

  /** How many redaction marks there are on all pages. */
  private countRedactionMarks(): number {
    const pdf = this.doc?.asPDF();
    if (!pdf) return 0;
    let count = 0;
    for (let i = 0; i < pdf.countPages(); i++) {
      const annots = pdf.findPage(i).get("Annots");
      if (!annots.isArray()) continue;
      for (let j = 0; j < annots.length; j++) {
        if (subtype(annots.get(j)) === "Redact") count++;
      }
    }
    return count;
  }

  /** The annotation with this object number on a page, if it's one that can be edited. */
  private findAnnotation(index: number, id: number): mupdf.PDFObject {
    if (!Number.isInteger(id) || id <= 0) throw new Error("That annotation is not on the page");
    const annots = this.requirePdf().findPage(index).get("Annots");
    if (annots.isArray()) {
      for (let i = 0; i < annots.length; i++) {
        const item = annots.get(i);
        if (item.asIndirect() === id && isListed(item)) return item;
      }
    }
    throw new Error("That annotation is not on the page");
  }

  /** From PDF space to points from the page's top-left corner as shown. */
  private shownTransform(index: number): Matrix6 {
    const page = this.requirePdf().loadPage(index);
    try {
      const [a, b, c, d, e, f] = page.getTransform();
      const [x0, y0] = page.getBounds();
      return [a, b, c, d, e - x0, f - y0];
    } finally {
      page.destroy();
    }
  }

  /**
   * Throw unless a rect (in points as shown) is on the page, give or take rounding. With
   * `allowCover`, a rect bigger than the page one way (some apps make those) may instead cover
   * the page that way, so it can still be moved.
   */
  private checkOnPage(index: number, rect: readonly number[], message: string, allowCover = false) {
    const page = this.requireDoc().loadPage(index);
    try {
      const [bx0, by0, bx1, by1] = page.getBounds();
      const [x0, y0, x1, y1] = rect as [number, number, number, number];
      const slack = 0.5;
      const fits = (start: number, end: number, size: number) => {
        if (start >= -slack && end <= size + slack) return true;
        return allowCover && end - start > size && start <= slack && end >= size - slack;
      };
      if (!fits(x0, x1, bx1 - bx0) || !fits(y0, y1, by1 - by0)) throw new Error(message);
    } finally {
      page.destroy();
    }
  }

  /**
   * Record an annotation that is already on the page as one undoable step. Undo takes it off
   * the page and redo puts the same object back, so the file doesn't collect copies.
   */
  private annotationStep(label: string, index: number, objects: mupdf.PDFObject[]): EditResult {
    const pdf = this.requirePdf();
    let attached = true;
    return this.run({
      label,
      redo: () => {
        if (attached) return;
        for (const object of objects) attachAnnotation(pdf, index, object);
        attached = true;
      },
      undo: () => {
        for (const object of objects) detachAnnotation(pdf, index, object);
        attached = false;
      },
    });
  }

  /** Quads of the text between two points, in MuPDF's page coordinates. */
  private textQuads(index: number, from: PagePoint, to: PagePoint): mupdf.Quad[] {
    const [x0, y0] = this.pageOrigin(index);
    return this.pageText(index).highlight(
      [from[0] + x0, from[1] + y0],
      [to[0] + x0, to[1] + y0],
      2000,
    );
  }

  /** Where the page's visible top-left corner is, in MuPDF's page coordinates. */
  private pageOrigin(index: number): [number, number] {
    const page = this.requireDoc().loadPage(index);
    try {
      const [x0, y0] = page.getBounds();
      return [x0, y0];
    } finally {
      page.destroy();
    }
  }

  // ---------------------------------------------------------------------------------------
  // Editing text in place (see textEdit.ts). One line at a time, in the page's own content.

  /** The lines of text on a page, each with whether it can be edited and, if not, why not. */
  listTextLines(pageIndex: number): PageText {
    const pdf = this.requirePdf();
    const [index] = this.checkPages([pageIndex]) as [number];
    const blocker = this.textEditBlocker();
    const lines = this.lineAnalysis(index).infos.map((line) =>
      blocker && line.editable ? { ...line, editable: false, reason: blocker } : line,
    );
    return { lines, signed: signedFields(pdf).length > 0 };
  }

  /**
   * What replacing a line's text would do (the font used, whether it fits), without doing it.
   * `expected` is the line's text as listed, so a stale list is caught.
   */
  checkTextEdit(pageIndex: number, id: number, expected: string, text: string): TextEditCheck {
    const [index] = this.checkPages([pageIndex]) as [number];
    const analysis = this.editableLine(index, id, expected);
    return planLineEdit(analysis, id, text).check;
  }

  /**
   * Replace a line of text, as one undoable step. Only the operators that draw the line change;
   * undo puts the page's original content streams back, byte for byte.
   */
  editTextLine(pageIndex: number, id: number, expected: string, text: string): TextEditResult {
    const pdf = this.requirePdf();
    const [index] = this.checkPages([pageIndex]) as [number];
    const analysis = this.editableLine(index, id, expected);
    const plan = planLineEdit(analysis, id, text);
    if (text === expected) return { ...this.editResult(), check: plan.check };
    const made = makeEdit(pdf, index, analysis, plan);
    const page = pdf.findPage(index);
    const oldContents = page.get("Contents");
    const oldResources = page.get("Resources");
    const apply = () => {
      page.put("Contents", made.contents);
      if (made.resources) page.put("Resources", made.resources);
    };
    const revert = () => {
      page.put("Contents", oldContents);
      if (made.resources) {
        if (oldResources.isNull()) page.delete("Resources");
        else page.put("Resources", oldResources);
      }
    };
    // Make the change and check it before keeping it: every other line must be where it was.
    apply();
    let right = false;
    try {
      const loaded = pdf.loadPage(index);
      try {
        right = editLooksRight(analysis, id, contentLines(loaded), text);
      } finally {
        loaded.destroy();
      }
    } finally {
      if (!right) {
        revert();
        for (const object of made.created) pdf.deleteObject(object);
      }
    }
    if (!right) {
      throw new Error(
        "This line couldn't be changed without affecting other text, so it was left as it was.",
      );
    }
    let applied = true;
    const result = this.run({
      label: "Edit text",
      redo: () => {
        if (applied) return;
        apply();
        applied = true;
      },
      undo: () => {
        revert();
        applied = false;
      },
    });
    return { ...result, check: plan.check };
  }

  /** Why no text in the file can be edited, or null. */
  private textEditBlocker(): string | null {
    const security = this.securityInfo();
    if (security.encrypted && !security.permissions.edit && !this.ownerUnlocked) {
      return (
        "This file doesn't allow changes to its content. To edit its text, unlock its " +
        "permissions with the permissions password first (Password)."
      );
    }
    return null;
  }

  private lineAnalysis(index: number): PageAnalysis {
    let analysis = this.lineCache.get(index);
    if (!analysis) {
      analysis = analysePage(this.requirePdf(), index);
      if (this.lineCache.size >= TEXT_CACHE_PAGES) {
        const oldest = this.lineCache.keys().next().value as number;
        this.lineCache.delete(oldest);
      }
      this.lineCache.set(index, analysis);
    }
    return analysis;
  }

  private editableLine(index: number, id: number, expected: string): PageAnalysis {
    const blocker = this.textEditBlocker();
    if (blocker) throw new Error(blocker);
    const analysis = this.lineAnalysis(index);
    const line = Number.isInteger(id) ? analysis.infos[id] : undefined;
    if (!line || line.text !== expected) {
      throw new Error("The page has changed since its text was read. Try again.");
    }
    if (!line.editable) throw new Error(line.reason ?? "This line can't be edited.");
    return analysis;
  }

  /** Undo the last page operation. Returns null when there is nothing to undo. */
  undo(): EditResult | null {
    this.requirePdf();
    const step = this.undoStack.pop();
    if (!step) return null;
    step.undo();
    this.changes--;
    this.redoStack.push(step);
    return this.editResult();
  }

  /** Redo the last undone page operation. Returns null when there is nothing to redo. */
  redo(): EditResult | null {
    this.requirePdf();
    const step = this.redoStack.pop();
    if (!step) return null;
    step.redo();
    this.changes++;
    this.undoStack.push(step);
    return this.editResult();
  }

  history(): HistoryState {
    const top = this.undoStack[this.undoStack.length - 1];
    const next = this.redoStack[this.redoStack.length - 1];
    return {
      canUndo: top !== undefined,
      canRedo: next !== undefined,
      undoLabel: top?.label ?? null,
      redoLabel: next?.label ?? null,
    };
  }

  /** Do a step for the first time and record it, unless it changes nothing. */
  private run(step: Step, noOp = false): EditResult {
    if (noOp) return this.editResult();
    step.redo();
    this.changes++;
    this.undoStack.push(step);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    return this.editResult();
  }

  private insertStep(label: string, at: number, objects: mupdf.PDFObject[]): EditResult {
    const entries = objects.map((object, i) => ({ index: at + i, object }));
    return this.run(
      this.labelled({
        label,
        redo: () => this.insertPages(entries),
        undo: () => this.removePages(entries.map((e) => e.index)),
      }),
    );
  }

  /**
   * A step that changes which pages are where, made to keep page labels with their pages:
   * each page stays in its label section, and sections are numbered again in order. Undo
   * puts back the labels exactly as they were.
   */
  private labelled(step: Step): Step {
    const pdf = this.requirePdf();
    const plan = planLabels(pdf);
    if (!plan) {
      // No labels: keep it that way (MuPDF adds some when it inserts pages).
      return {
        label: step.label,
        redo: () => {
          step.redo();
          removeLabels(pdf);
        },
        undo: () => {
          step.undo();
          removeLabels(pdf);
        },
      };
    }
    return {
      label: step.label,
      redo: () => {
        step.redo();
        applyLabels(pdf, plan);
      },
      undo: () => {
        step.undo();
        restoreLabels(pdf, plan);
      },
    };
  }

  private editResult(): EditResult {
    this.clearTextCache(); // Pages may have moved, gone or changed.
    return { info: this.info(), history: this.history() };
  }

  private clearTextCache(): void {
    for (const text of this.textCache.values()) text.destroy();
    this.textCache.clear();
    this.lineCache.clear();
  }

  private pageText(index: number): mupdf.StructuredText {
    let text = this.textCache.get(index);
    if (text) {
      // Most recently used goes last (a Map keeps insertion order).
      this.textCache.delete(index);
    } else {
      const page = this.requireDoc().loadPage(index);
      try {
        text = page.toStructuredText("preserve-whitespace");
      } finally {
        page.destroy();
      }
      while (this.textCache.size >= TEXT_CACHE_PAGES) {
        const [oldest, layout] = this.textCache.entries().next().value as [
          number,
          mupdf.StructuredText,
        ];
        layout.destroy();
        this.textCache.delete(oldest);
      }
    }
    this.textCache.set(index, text);
    return text;
  }

  /**
   * Take pages out of the page tree (indices ascending) and return them with their old
   * indices. Inherited attributes are copied onto each page first, so it looks the same
   * wherever it is put back.
   */
  private removePages(indices: readonly number[]): PageEntry[] {
    const pdf = this.requirePdf();
    const entries = indices.map((index) => {
      const object = pdf.findPage(index);
      flattenInherited(object);
      return { index, object };
    });
    for (let i = entries.length - 1; i >= 0; i--) pdf.deletePage((entries[i] as PageEntry).index);
    return entries;
  }

  /** Put pages back into the page tree. Entries must be in ascending index order. */
  private insertPages(entries: readonly PageEntry[]): void {
    const pdf = this.requirePdf();
    for (const { index, object } of entries) {
      pdf.insertPage(index >= pdf.countPages() ? -1 : index, object);
    }
  }

  /** Validate page indices; returns them sorted and without duplicates. */
  private checkPages(pages: readonly number[]): number[] {
    const count = this.requirePdf().countPages();
    if (pages.length === 0) throw new Error("Select at least one page");
    for (const p of pages) {
      if (!Number.isInteger(p) || p < 0 || p >= count)
        throw new Error(`Page ${p + 1} doesn't exist`);
    }
    return [...new Set(pages)].sort((a, b) => a - b);
  }

  private checkInsertAt(at: number, pageCount: number): void {
    if (!Number.isInteger(at) || at < 0 || at > pageCount) {
      throw new Error(`Insert position ${at} is out of range (0 to ${pageCount})`);
    }
  }

  /** Size of the page before `at` (or after it, when inserting at the start). */
  private neighbourSize(at: number, pageCount: number): PageSize {
    if (pageCount === 0) return { width: 595, height: 842 };
    // The size as shown, after the neighbour's own rotation: the new page has no rotation, so
    // this makes it look the same way round as the page next to it.
    const page = this.requireDoc().loadPage(Math.min(Math.max(at - 1, 0), pageCount - 1));
    try {
      const [x0, y0, x1, y1] = page.getBounds();
      return { width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
    } finally {
      page.destroy();
    }
  }

  private requirePdf(): mupdf.PDFDocument {
    const pdf = this.requireDoc().asPDF();
    if (!pdf) throw new Error("Not a PDF document");
    return pdf;
  }

  /** The open document; by default it must also be unlocked. */
  private requireDoc(unlocked = true): mupdf.Document {
    if (!this.doc) throw new Error("No document is open");
    if (unlocked && this.locked) throw new PasswordRequiredError();
    return this.doc;
  }
}

interface PageEntry {
  index: number;
  object: mupdf.PDFObject;
}

/** Open another PDF to insert from, unlocking it if needed. */
function openSource(source: PdfSource): mupdf.Document {
  const doc = mupdf.Document.openDocument(source.bytes, "application/pdf");
  try {
    if (!doc.asPDF()) throw new Error("The file being inserted isn't a PDF");
    if (doc.needsPassword() && doc.authenticatePassword(source.password ?? "") === 0) {
      throw new PasswordRequiredError("The file being inserted is password-protected");
    }
    return doc;
  } catch (err) {
    doc.destroy();
    throw err;
  }
}

function readRotation(page: mupdf.PDFObject): number {
  const value = page.getInheritable("Rotate");
  return value.isNumber() ? normaliseRotation(value.asNumber()) : 0;
}

/** Bring any multiple of 90 into 0, 90, 180 or 270. Other values count as 0, like MuPDF. */
function normaliseRotation(degrees: number): number {
  const r = ((Math.round(degrees) % 360) + 360) % 360;
  return r % 90 === 0 ? r : 0;
}

/** Copy attributes the page inherits from its parents onto the page itself. */
function flattenInherited(page: mupdf.PDFObject): void {
  for (const key of INHERITABLE_KEYS) {
    if (!page.get(key).isNull()) continue;
    const inherited = page.getInheritable(key);
    if (!inherited.isNull()) page.put(key, inherited);
  }
}

/** Where the last cross-reference section of a PDF starts (its final `startxref`), or null. */
export function lastStartxref(bytes: Uint8Array): number | null {
  // It's within the last few hundred bytes of a well-formed file; allow some junk after it.
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
  const matches = [...tail.matchAll(/startxref\s+(\d+)/g)];
  const last = matches[matches.length - 1];
  return last ? Number(last[1]) : null;
}

/**
 * Make the update appended to `base` original bytes point back (/Prev) at the original's last
 * cross-reference section. Only the update is touched, so the original bytes stay identical.
 * Changing the number's length is safe: the trailer comes after everything its offsets point to.
 */
export function fixUpdatePrev(bytes: Uint8Array, baseLength: number, prev: number): Uint8Array {
  const latin1 = new TextDecoder("latin1");
  const update = latin1.decode(bytes.subarray(baseLength));
  // MuPDF writes a classic trailer for the update, or, for a file that uses cross-reference
  // streams, a last object with /Type /XRef whose dictionary (never compressed) has the /Prev.
  let from = update.lastIndexOf("trailer");
  let to = update.length;
  if (from < 0) {
    const xref = update.lastIndexOf("/XRef");
    if (xref < 0) return bytes;
    from = update.lastIndexOf("<<", xref);
    to = update.indexOf("stream", xref);
    if (from < 0 || to < 0) return bytes;
  }
  const match = /\/Prev\s+(\d+)/.exec(update.slice(from, to));
  if (!match || Number(match[1]) === prev) return bytes;
  const at = baseLength + from + match.index;
  const replacement = new TextEncoder().encode(`/Prev ${prev}`);
  const out = new Uint8Array(bytes.length - match[0].length + replacement.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(replacement, at);
  out.set(bytes.subarray(at + match[0].length), at + replacement.length);
  return out;
}

/** Check a [left, top, right, bottom] rectangle: finite numbers, at least 1 point each way. */
function checkRect(rect: readonly number[]): [number, number, number, number] {
  const [x0, y0, x1, y1] = rect;
  if (rect.length !== 4 || ![x0, y0, x1, y1].every((v) => Number.isFinite(v))) {
    throw new Error("The position isn't valid");
  }
  const r = [x0, y0, x1, y1] as [number, number, number, number];
  if (r[2] - r[0] < 1 || r[3] - r[1] < 1) throw new Error("It's too small");
  return r;
}

/** Check an annotation's values (all but the page and the text under markup). */
function validateAnnotation(spec: AnnotationSpec): void {
  if ("color" in spec) checkColor(spec.color);
  if ("width" in spec) checkWidth(spec.width);
  if ("rect" in spec) checkRect(spec.rect);
  if ("text" in spec) checkText(spec.text);
  if ("from" in spec) checkPoint(spec.from);
  if ("to" in spec) checkPoint(spec.to);
  if ("at" in spec) checkPoint(spec.at);
  if (spec.kind === "text" && !(spec.size >= 4 && spec.size <= 144)) {
    throw new Error("Text size must be 4 to 144");
  }
  if (spec.kind === "ink") {
    const count = spec.strokes.reduce((n, s) => n + s.length, 0);
    if (count === 0) throw new Error("There's nothing drawn");
    if (count > MAX_INK_POINTS) throw new Error("The drawing has too many points");
    for (const stroke of spec.strokes) for (const p of stroke) checkPoint(p);
  }
  if (spec.kind === "line" || spec.kind === "arrow") {
    if (Math.hypot(spec.to[0] - spec.from[0], spec.to[1] - spec.from[1]) < 1) {
      throw new Error("The line is too short");
    }
  }
}

function checkPoint(p: readonly number[]): void {
  if (p.length !== 2 || !p.every((v) => Number.isFinite(v))) {
    throw new Error("A position isn't valid");
  }
}

function checkColor(c: readonly number[]): [number, number, number] {
  if (c.length !== 3 || !c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new Error("A colour isn't valid");
  }
  return [c[0], c[1], c[2]] as [number, number, number];
}

function checkWidth(w: number): number {
  if (!(Number.isFinite(w) && w > 0 && w <= 50))
    throw new Error("Line width must be 0 to 50 points");
  return w;
}

function checkText(text: string): string {
  const t = text.trim();
  if (!t) throw new Error("Type some text first");
  if (t.length > MAX_ANNOTATION_TEXT) throw new Error("The text is too long");
  return t;
}

/** Whether a text field is formatted as a date (Acrobat's AFDate scripts). */
function isDateField(object: mupdf.PDFObject): boolean {
  const aa = inherited(object, "AA");
  const format = aa.isDictionary() ? aa.get("F") : null;
  const js = format?.isDictionary() ? format.get("JS") : null;
  return js?.isString() === true && js.asString().includes("AFDate_");
}

/** A string or name as text ("" for anything else). */
function textOf(value: mupdf.PDFObject): string {
  if (value.isString()) return value.asString();
  if (value.isName()) return value.asName();
  return "";
}

/** An entry a form field inherits: from the box itself, or the nearest parent that has it. */
function inherited(object: mupdf.PDFObject, key: string): mupdf.PDFObject {
  let node = object;
  for (let depth = 0; depth < 32 && !node.isNull(); depth++) {
    const value = node.get(key);
    if (!value.isNull()) return value;
    node = node.get("Parent");
  }
  return node.isNull() ? node : node.get(key);
}

/** A page's content, resources and annotations, copied so later changes can't reach them. */
type PageState = Map<string, mupdf.PDFObject | null>;
const PAGE_STATE_KEYS = ["Contents", "Resources", "Annots"] as const;

function capturePage(pdf: mupdf.PDFDocument, index: number): PageState {
  const page = pdf.findPage(index);
  const state: PageState = new Map();
  for (const key of PAGE_STATE_KEYS) {
    const v = page.get(key);
    state.set(key, v.isNull() ? null : copyContainer(pdf, v));
  }
  return state;
}

function restorePage(pdf: mupdf.PDFDocument, index: number, state: PageState): void {
  const page = pdf.findPage(index);
  for (const [key, v] of state) {
    if (v === null) page.delete(key);
    else page.put(key, copyDirect(pdf, v));
  }
}

/** The name of a checkbox's or radio button's "on" state: its appearance other than /Off. */
function onState(widget: mupdf.PDFObject): string {
  const ap = widget.get("AP");
  const normal = ap.isDictionary() ? ap.get("N") : ap;
  let name = "";
  if (normal.isDictionary()) {
    normal.forEach((_v, key) => {
      if (key !== "Off" && !name) name = String(key);
    });
  }
  return name || "Yes";
}

/** The areas a page's redaction marks cover, in PDF space: each quad's box, or the mark's box. */
function redactionRegions(page: mupdf.PDFObject): [number, number, number, number][] {
  const annots = page.get("Annots");
  const regions: [number, number, number, number][] = [];
  if (!annots.isArray()) return regions;
  for (let i = 0; i < annots.length; i++) {
    const item = annots.get(i);
    if (subtype(item) !== "Redact") continue;
    const quads = item.get("QuadPoints");
    if (quads.isArray() && quads.length >= 8) {
      for (let q = 0; q + 8 <= quads.length; q += 8) {
        const xs = [0, 2, 4, 6].map((k) => quads.get(q + k).asNumber());
        const ys = [1, 3, 5, 7].map((k) => quads.get(q + k).asNumber());
        regions.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
    } else if (item.get("Rect").isArray()) {
      regions.push(readRect(item));
    }
  }
  return regions;
}

/** Whether two boxes [x0, y0, x1, y1] overlap (touching edges don't count). */
function overlaps(a: readonly number[], b: readonly number[]): boolean {
  return (
    (a[0] as number) < (b[2] as number) &&
    (b[0] as number) < (a[2] as number) &&
    (a[1] as number) < (b[3] as number) &&
    (b[1] as number) < (a[3] as number)
  );
}

/** The page's /Annots array, created if the page has none. */
function annotsOf(pdf: mupdf.PDFDocument, pageIndex: number): mupdf.PDFObject {
  const page = pdf.findPage(pageIndex);
  let annots = page.get("Annots");
  if (!annots.isArray()) {
    annots = pdf.newArray();
    page.put("Annots", annots);
  }
  return annots;
}

function attachAnnotation(pdf: mupdf.PDFDocument, pageIndex: number, object: mupdf.PDFObject) {
  annotsOf(pdf, pageIndex).push(object);
}

function detachAnnotation(pdf: mupdf.PDFDocument, pageIndex: number, object: mupdf.PDFObject) {
  const annots = annotsOf(pdf, pageIndex);
  const num = object.asIndirect();
  for (let i = annots.length - 1; i >= 0; i--) {
    if (annots.get(i).asIndirect() === num) {
      annots.delete(i);
      return;
    }
  }
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** "1 page", "3 pages". */
function countLabel(n: number, noun = "page"): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Expand MuPDF's packed RGB samples (rows may be padded to `stride`) to RGBA. */
function rgbToRgba(
  rgb: Uint8ClampedArray,
  width: number,
  height: number,
  pixmap: mupdf.Pixmap,
): Uint8ClampedArray {
  const stride = pixmap.getStride();
  const n = pixmap.getNumberOfComponents();
  const out = new Uint8ClampedArray(width * height * 4);
  let o = 0;
  for (let y = 0; y < height; y++) {
    let i = y * stride;
    for (let x = 0; x < width; x++, i += n) {
      out[o++] = rgb[i] as number;
      out[o++] = rgb[i + 1] as number;
      out[o++] = rgb[i + 2] as number;
      out[o++] = 255;
    }
  }
  return out;
}

/** Create a simple blank PDF. Useful for tests and the "blank PDF" feature. */
export function createBlankPdf(pages = 1, width = 595, height = 842): Uint8Array {
  const pdf = new mupdf.PDFDocument();
  try {
    for (let i = 0; i < pages; i++) {
      const page = pdf.addPage([0, 0, width, height], 0, {}, "");
      pdf.insertPage(-1, page);
    }
    const buffer = pdf.saveToBuffer("");
    try {
      return buffer.asUint8Array().slice();
    } finally {
      buffer.destroy();
    }
  } finally {
    pdf.destroy();
  }
}
