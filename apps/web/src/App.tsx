// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AnnotationChange,
  type AnnotationInfo,
  type AnnotationSpec,
  assembleExport,
  type CompressPreset,
  type CreateSpec,
  crc32,
  type DocumentInfo,
  describePages,
  type EditResult,
  EngineCrashedError,
  EngineLoadError,
  EXPORT_TYPES,
  type ExportedPage,
  type ExportOptions,
  exportFileName,
  type FieldChanges,
  type FormField,
  type FormInfo,
  filePerPage,
  type HistoryState,
  IncrementalSaveError,
  isFatalEngineError,
  type LoadProgress,
  type NewFieldKind,
  PasswordRequiredError,
  type PasswordSpec,
  PdfWorkerClient,
  type RgbColor,
  type RotationDelta,
  type SearchHit,
  type StampKind,
  ZIP_TYPE,
} from "@pdfoctopus/core";
import { Footer } from "@pdfoctopus/ui";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnnotateLayer } from "./annotate/AnnotateLayer";
import { arrowDelta, moveBox, sameBox } from "./annotate/edit";
import { RedactDialog } from "./annotate/RedactDialog";
import { SelectLayer } from "./annotate/SelectLayer";
import {
  cssColor,
  hasColor,
  PALETTE,
  TOOLS,
  type ToolId,
  toolById,
  WIDTHS,
} from "./annotate/tools";
import { CompressDialog, type CompressOutcome, formatSize } from "./compress/CompressDialog";
import { CreateDialog } from "./create/CreateDialog";
import { ExportDialog, type ExportProgress } from "./export/ExportDialog";
import { FieldDrawLayer, FieldEditLayer } from "./form/BuildLayers";
import { FIELD_KIND_NAMES, FieldDialog, type FieldProperties } from "./form/FieldDialog";
import { FlattenDialog } from "./form/FlattenDialog";
import { FormLayer } from "./form/FormLayer";
import {
  chooseDestination,
  chooseFolder,
  derivedName,
  type SaveTarget,
  writeFiles,
  writeToDestination,
} from "./saveFile";
import { SecurityDialog } from "./security/SecurityDialog";
import { clampRect, formatToday, initialRect, type PageRect, placementKey } from "./sign/ink";
import { Placement } from "./sign/Placement";
import { SignDialog } from "./sign/SignDialog";
import { StampDialog } from "./sign/StampDialog";
import { dateToStamp, pictureToImage, type StampImage } from "./sign/stampImage";
import {
  type ChosenPdf,
  InsertPdfDialog,
  type InsertPosition,
  PasswordDialog,
  PropertiesDialog,
  SplitDialog,
} from "./ui/Dialogs";
import { THEMES, type Theme, useTheme } from "./ui/theme";
import { percentToScale, scaleToPercent, stepZoom } from "./viewer/layout";
import { PageRenderer } from "./viewer/renderer";
import {
  clampSelection,
  clickSelection,
  EMPTY_SELECTION,
  moveTarget,
  type Selection,
  selectAll,
  selectRun,
  targetPages,
} from "./viewer/selection";
import { Thumbnails } from "./viewer/Thumbnails";
import { Viewer, type ViewerHandle, type Zoom } from "./viewer/Viewer";

interface OpenDocument {
  /** Changes for every opened file, so per-document state resets. */
  id: number;
  fileName: string;
  fileSize: number;
  info: DocumentInfo;
  renderer: PageRenderer;
  /** Where the file was last saved, so "Save" can write there again without asking. */
  saveTarget?: SaveTarget;
}

/** Open dialogs for the page tools. */
type PageDialog =
  | { kind: "split" }
  | {
      kind: "insert";
      title: string;
      defaultPosition: InsertPosition;
      error?: string;
      needsPasswords?: boolean;
    };

/** A signature, initials or date being positioned on a page, before it's applied. */
interface PendingStamp {
  kind: StampKind | "stamp";
  /** The picture shown while placing it (and, except for text stamps, what's added). */
  image: StampImage;
  page: number;
  rect: PageRect;
  /** What the stamp says, when it's text (the date). */
  text?: string;
  /** For a text stamp: what it says, drawn by the engine as vector graphics. */
  textStamp?: { text: string; detail: string; color: RgbColor };
}

const STAMP_NOUN: Record<PendingStamp["kind"], string> = {
  signature: "signature",
  initials: "initials",
  date: "date",
  stamp: "stamp",
  image: "image",
};

const NO_HISTORY: HistoryState = {
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
};

type EngineState =
  | { status: "loading"; progress: LoadProgress | null }
  | { status: "ready" }
  | { status: "failed"; message: string };

interface PasswordPrompt {
  fileName: string;
  fileSize: number;
  /** The unlocked document, null if the user cancelled, or "failed" if unlocking errored. */
  resolve(info: DocumentInfo | null | "failed"): void;
}

const MB = 1024 * 1024;
const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200, 300, 400];
const THEME_ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };
const THEME_LABEL: Record<Theme, string> = {
  system: "Auto theme",
  light: "Light theme",
  dark: "Dark theme",
};

function formatProgress(progress: LoadProgress | null): string {
  if (!progress) return "Loading the PDF engine…";
  const loaded = (progress.loaded / MB).toFixed(1);
  if (progress.total === null) return `Loading the PDF engine… ${loaded} MB`;
  return `Loading the PDF engine… ${loaded} of ${(progress.total / MB).toFixed(1)} MB`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a file looks like a picture to place: by its type, or by its name when the browser
 * doesn't know the type. pictureToImage checks what's really inside.
 */
function isPictureFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name);
}

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

/** True when a key press is meant for a text field rather than the app. */
function typingInField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** "1-3, 5" for a list of 0-based pages, to prefill the split dialog. */
function formatRanges(pages: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === (pages[j] as number) + 1) j++;
    const a = (pages[i] as number) + 1;
    const b = (pages[j] as number) + 1;
    parts.push(a === b ? String(a) : `${a}-${b}`);
    i = j + 1;
  }
  return parts.join(", ");
}

/** "a rectangle", "an ellipse". */
function articled(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/**
 * A field label worth quoting back: words ("Last Name"), not a name only software reads
 * ("f1_01[0]"), which is all some forms have.
 */
const READABLE_LABEL = /^\p{L}[\p{L}\p{N} '’.,:?()/-]{0,60}$/u;

/** The kinds of field the Form row adds, in order. */
const FORM_TOOLS: readonly NewFieldKind[] = [
  "text",
  "checkbox",
  "radio",
  "combobox",
  "date",
  "signature",
];

/** What to say about a form when its file is opened, if anything. */
function formNotice(form: FormInfo): string {
  if (form.xfa === "dynamic") {
    return (
      "This PDF's form is an XFA form, which PDFoctopus can't fill in. " +
      "Its pages may show only a message asking for Adobe Reader."
    );
  }
  if (form.fields === 0) return "";
  return "This PDF has a form: click a field to fill it in.";
}

/** The most an export collects before saving, in bytes. */
const MAX_EXPORT_BYTES = 1_500_000_000;

function countPages(n: number): string {
  return `${n} page${n === 1 ? "" : "s"}`;
}

let nextDocId = 1;

export function App() {
  const client = useRef<PdfWorkerClient | null>(null);
  const viewer = useRef<ViewerHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The hidden file picker for a picture to put on the page. */
  const imageInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const [engine, setEngine] = useState<EngineState>({ status: "loading", progress: null });
  const [doc, setDoc] = useState<OpenDocument>();
  /** The latest document, for code that runs after an await. */
  const docRef = useRef(doc);
  docRef.current = doc;
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [history, setHistory] = useState<HistoryState>(NO_HISTORY);
  /** True when there are edits that haven't been saved. */
  const [dirty, setDirty] = useState(false);
  /** The latest `dirty`, for callbacks from older renders (a drop, the desktop startup file). */
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const [pageDialog, setPageDialog] = useState<PageDialog>();
  /** Which dialog for making a signature is open, if any. */
  const [signDialog, setSignDialog] = useState<"signature" | "initials">();
  /** True while the dialog for choosing a stamp ("APPROVED", …) is open. */
  const [stampDialog, setStampDialog] = useState(false);
  /** True while the "Apply redactions?" confirmation is open. */
  const [redactDialog, setRedactDialog] = useState(false);
  /** True while the "Flatten form?" confirmation is open. */
  const [flattenDialog, setFlattenDialog] = useState(false);
  /** The form field that has the focus, so it gets it back after a change redraws the page. */
  const [focusedField, setFocusedField] = useState<number | null>(null);
  /**
   * Text typed in a form field that isn't in the document yet: saving puts it in first, and its
   * page stays loaded (scrolling it away would otherwise lose the text).
   */
  const formDraft = useRef<{ page: number; field: FormField; value: string } | null>(null);
  const [formDraftPage, setFormDraftPage] = useState<number | null>(null);
  /** The task running now (see runTask), for saving to wait for. */
  const currentTask = useRef<Promise<void>>(Promise.resolve());
  /** A stamp being positioned. Page tools wait until it's applied or cancelled. */
  const [pending, setPending] = useState<PendingStamp>();
  /** The annotation tool picked, if any: dragging on a page then draws with it. */
  const [tool, setTool] = useState<ToolId>();
  /**
   * The form-building tool picked, if any: a kind of field (drag on a page to add one), or
   * "edit" (click a field to change it).
   */
  const [formTool, setFormTool] = useState<NewFieldKind | "edit">();
  /** The dialog for a field's properties: one being added (its box drawn), or one to change. */
  const [fieldDialog, setFieldDialog] = useState<
    | {
        mode: "add";
        kind: NewFieldKind;
        page: number;
        rect: [number, number, number, number];
        suggestedName: string;
        error?: string;
      }
    | { mode: "edit"; page: number; field: FormField; error?: string }
  >();
  /** The last radio group a button was added to, offered for the next one. */
  const lastRadioGroup = useRef<string | null>(null);
  /** The colour chosen for each tool (until then, the tool's own default). */
  const [toolColors, setToolColors] = useState<Partial<Record<ToolId, RgbColor>>>({});
  const [lineWidth, setLineWidth] = useState(2);
  /** True while the Select tool is picked: clicking an annotation then selects it. */
  const [selecting, setSelecting] = useState(false);
  /** The selected annotation and its page, if any. */
  const [selectedAnnot, setSelectedAnnot] = useState<{
    page: number;
    annotation: AnnotationInfo;
  } | null>(null);
  /**
   * The page where a note or text box is being typed, if any. Other edits (and drawing on other
   * pages, and saving) wait for it, and its page stays loaded even when scrolled away.
   */
  const [draftPage, setDraftPage] = useState<number | null>(null);
  const drafting = draftPage !== null;
  /** Bumped on every edit, so the drawing layers start afresh on the edited pages. */
  const [editVersion, setEditVersion] = useState(0);
  /** A page to scroll to once the viewer has the edited document. */
  const pendingScroll = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  /** True while a file is being opened or saved; one operation at a time. */
  const workingRef = useRef(false);
  const [status, setStatus] = useState("");
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt>();
  const [showProperties, setShowProperties] = useState(false);
  /** The password and permissions dialog, if open, with the last error from applying it. */
  const [passwordDialog, setPasswordDialog] = useState<{ error?: string }>();
  /** The compress dialog, if open: the last compressed copy made, or an error. */
  const [compressDialog, setCompressDialog] = useState<{
    outcome?: CompressOutcome;
    error?: string;
  }>();
  /** The New PDF dialog, if open, with the last error from making one. */
  const [createDialog, setCreateDialog] = useState<{ error?: string }>();
  /** The last compressed copy's bytes, kept out of state (they can be large). */
  const compressedBytes = useRef<Uint8Array | null>(null);
  /** The export dialog, if open: how far an export has got, or the last error. */
  const [exportDialog, setExportDialog] = useState<{
    progress?: ExportProgress;
    error?: string;
  }>();
  /** Set by Stop: the export in progress stops before its next page. */
  const exportStop = useRef(false);
  const [sidebar, setSidebar] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [theme, setTheme] = useTheme();

  const [zoom, setZoom] = useState<Zoom>({ mode: "fit-width", scale: 1 });
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState(0);
  /** The latest page, for work that finishes after a wait (reading a picture). */
  const pageRef = useRef(page);
  pageRef.current = page;
  const [pageInput, setPageInput] = useState("1");

  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [currentHit, setCurrentHit] = useState(0);
  const [searching, setSearching] = useState(false);
  /** Bumped whenever a search is cleared or superseded, so late results are ignored. */
  const searchGeneration = useRef(0);

  /** Replace (or clear) the open document, freeing the old one's bitmaps. */
  const replaceDoc = useCallback((next: OpenDocument | undefined) => {
    setDoc((previous) => {
      previous?.renderer.dispose();
      return next;
    });
    searchGeneration.current++;
    setSearching(false);
    setQuery("");
    setHits([]);
    setSearched(null);
    setCurrentHit(0);
    setPage(0);
    setShowProperties(false);
    setPasswordDialog(undefined);
    setCompressDialog(undefined);
    compressedBytes.current = null;
    setExportDialog(undefined);
    exportStop.current = true;
    setSelection(EMPTY_SELECTION);
    setHistory(NO_HISTORY);
    setDirty(false);
    setPageDialog(undefined);
    setSignDialog(undefined);
    setStampDialog(false);
    setRedactDialog(false);
    setFlattenDialog(false);
    setFocusedField(null);
    setFormTool(undefined);
    setFieldDialog(undefined);
    lastRadioGroup.current = null;
    formDraft.current = null;
    setFormDraftPage(null);
    setPending(undefined);
    setTool(undefined);
    setSelecting(false);
    setSelectedAnnot(null);
  }, []);

  /** Start a fresh worker and begin loading MuPDF in the background. */
  const startEngine = useCallback(() => {
    client.current?.terminate();
    const pdf = new PdfWorkerClient({
      onLoadProgress: (progress) => {
        if (client.current === pdf) setEngine({ status: "loading", progress });
      },
      // The document lived in this worker. If it crashes, even between actions, stop
      // showing the document so nothing runs against an engine that no longer has it.
      // (A crash during an action is then also reported by that action, more specifically.)
      onFatalError: (err) => {
        if (client.current !== pdf) return;
        replaceDoc(undefined);
        if (err instanceof EngineCrashedError) {
          setStatus("The PDF engine stopped unexpectedly. Please open the file again.");
        }
      },
    });
    client.current = pdf;
    setEngine({ status: "loading", progress: null });
    pdf.init().then(
      () => client.current === pdf && setEngine({ status: "ready" }),
      (err) => client.current === pdf && setEngine({ status: "failed", message: messageOf(err) }),
    );
    return pdf;
  }, [replaceDoc]);

  useEffect(() => {
    startEngine();
    return () => client.current?.terminate();
  }, [startEngine]);

  /** The current worker, replaced first if an earlier file crashed it. */
  function getClient(): PdfWorkerClient {
    const current = client.current;
    return current && !current.crashed ? current : startEngine();
  }

  /** Turn an error into a message, and reset the view if the engine was lost. */
  function reportError(action: string, err: unknown) {
    if (err instanceof EngineCrashedError) {
      replaceDoc(undefined);
      setStatus(
        `The PDF engine stopped while trying to ${action}. The file may be damaged. ` +
          "The engine has been restarted, so you can try another file.",
      );
      startEngine();
    } else if (err instanceof EngineLoadError) {
      setStatus("The PDF engine could not be loaded. Check your connection and try again.");
    } else {
      setStatus(`Could not ${action}: ${messageOf(err)}`);
    }
  }

  /**
   * Open a PDF file. `fresh`: a PDF just made (New PDF), which isn't saved anywhere yet.
   * `confirmed`: the user already agreed to drop unsaved changes.
   */
  async function openFile(file: File, { fresh = false, confirmed = false } = {}) {
    // A ref, not the `busy` state: callbacks holding an older render's openFile (the
    // desktop startup file, a drop) would otherwise see a stale `busy` and run in parallel
    // with another open or a save.
    if (workingRef.current) return;
    if (!isPdfFile(file)) {
      setStatus(`${file.name} isn't a PDF.`);
      return;
    }
    // Opening replaces the document and its undo history: never drop unsaved edits silently
    // (an answer still being typed in a form field counts).
    if (
      !confirmed &&
      (dirtyRef.current || formDraft.current !== null) &&
      !window.confirm(
        `You have unsaved changes to ${docRef.current?.fileName ?? "this PDF"}.\n\n` +
          `Open ${file.name} anyway? Your changes will be lost.`,
      )
    ) {
      return;
    }
    workingRef.current = true;
    const pdf = getClient();
    setBusy(true);
    setStatus(`Opening ${file.name}…`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Opening replaces the worker's document, so the previous one is gone from here on
      // even if this file fails. Stop showing it, so nothing acts on the wrong document.
      replaceDoc(undefined);
      const opened = await pdf.open(bytes);
      const info = opened.needsPassword
        ? await new Promise<DocumentInfo | null | "failed">((resolve) =>
            setPasswordPrompt({ fileName: file.name, fileSize: file.size, resolve }),
          )
        : opened;
      setPasswordPrompt(undefined);
      // On "failed" the error has already been reported: keep that message.
      if (info === "failed") return;
      if (!info) {
        setStatus("");
        return;
      }
      replaceDoc({
        id: nextDocId++,
        fileName: file.name,
        fileSize: file.size,
        info,
        renderer: new PageRenderer(pdf),
      });
      setZoom({ mode: "fit-width", scale: 1 });
      if (fresh) {
        // Not saved anywhere yet: closing warns, and the first Save asks where to put it.
        setDirty(true);
        setStatus(
          `New PDF, ${countPages(info.pageCount)}. It isn't saved yet: Save it to keep it.`,
        );
      } else {
        setStatus(formNotice(info.form));
      }
    } catch (err) {
      reportError("open this file", err);
    } finally {
      workingRef.current = false;
      setBusy(false);
    }
  }

  /**
   * Save the document. "Save" writes back to where it was last saved when the platform
   * allows it; the first save, and "Save as", ask where to save.
   */
  async function onSave(saveAs = false) {
    // Leaving a form field to press Save starts putting its text in: wait for that.
    if (workingRef.current) await currentTask.current;
    if (workingRef.current || !docRef.current) return;
    workingRef.current = true;
    const pdf = getClient();
    setBusy(true);
    try {
      const doc = docRef.current;
      if (!doc) return;
      // Ask where to save first, while the browser still counts this as part of the click.
      const destination = await chooseDestination(
        doc.fileName,
        saveAs ? undefined : doc.saveTarget,
      );
      if (!destination) {
        setStatus("Not saved.");
        return;
      }
      // Text still being typed in a form field (Ctrl+S) goes in first, as its own step.
      await commitFormDraft(pdf);
      setStatus("Saving…");
      let bytes: Uint8Array;
      // After redacting, the whole file is rewritten (agreed to when applying), so nothing
      // removed is left in the original bytes.
      const rewritten = doc.info.redacted;
      // Adding or removing a password rewrites the whole file too (the engine sees to that).
      const security = docRef.current?.info.security.pending ?? "none";
      try {
        bytes = await pdf.save(!rewritten);
      } catch (err) {
        if (!(err instanceof IncrementalSaveError)) throw err;
        // Never rewrite a file silently: it can change how it looks and breaks signatures.
        const rewrite = window.confirm(
          "This PDF was damaged and had to be repaired, so your changes can't simply be " +
            "added to the end of the original file.\n\nSave a rebuilt copy instead? It " +
            "should look the same, but any digital signatures in it will no longer be valid.",
        );
        if (!rewrite) {
          setStatus("Not saved.");
          return;
        }
        bytes = await pdf.save(false);
      }
      const outcome = await writeToDestination(destination, bytes);
      const savedId = doc.id;
      const savedBytes = bytes.byteLength;
      setDoc((prev) =>
        prev && prev.id === savedId
          ? {
              ...prev,
              fileName: outcome.fileName ?? prev.fileName,
              fileSize: savedBytes,
              // A "Save as" that fell back to a download leaves no file to write to again:
              // forget the old one, so the next Save asks instead of overwriting it.
              saveTarget: outcome.target ?? (saveAs ? undefined : prev.saveTarget),
            }
          : prev,
      );
      setDirty(false);
      // The engine drops the history after saving a redacted file, so it can't be undone.
      if (rewritten) setHistory(NO_HISTORY);
      const name = outcome.fileName ?? doc.fileName;
      const done = outcome.result === "saved" ? `Saved ${name}.` : `Downloaded ${name}.`;
      setStatus(
        rewritten
          ? // Not "the redacted content is gone": an undone redaction is back, and saved.
            `${done} The whole file was rewritten, as it is after redacting.`
          : security === "protect"
            ? `${done} It's protected now (the whole file was rewritten).`
            : security === "remove"
              ? `${done} It has no password now (the whole file was rewritten).`
              : done,
      );
    } catch (err) {
      reportError("save this file", err);
    } finally {
      workingRef.current = false;
      setBusy(false);
    }
  }

  // ---- Page tools ----

  /**
   * Show the edited document. The renderer is replaced, because its cached bitmaps show the
   * pages as they were. The document keeps its id, so the view and its scroll position stay.
   */
  function applyEdit(
    result: EditResult,
    message: string,
    select?: Selection,
    scrollTo?: number,
    keepAnnotation = false,
  ) {
    const current = docRef.current;
    if (!current) return;
    // A selected annotation may have moved or gone (undo, page edits): let go of it, unless it's
    // the selection's own change, after which its layer reports where it is now.
    if (!keepAnnotation) setSelectedAnnot(null);
    const renderer = new PageRenderer(getClient());
    current.renderer.dispose();
    const next = { ...current, info: result.info, renderer };
    setEditVersion((v) => v + 1);
    docRef.current = next;
    setDoc(next);
    setHistory(result.history);
    setDirty(true);
    // Search results point at the old pages.
    searchGeneration.current++;
    setSearching(false);
    setHits([]);
    setSearched(null);
    const count = result.info.pageCount;
    setSelection(select ?? clampSelection(selection, count));
    setPage((p) => Math.min(p, count - 1));
    if (scrollTo !== undefined) pendingScroll.current = Math.min(scrollTo, count - 1);
    setStatus(message);
  }

  useEffect(() => {
    if (!doc || pendingScroll.current === null) return;
    const target = pendingScroll.current;
    pendingScroll.current = null;
    // After the viewer has laid out the new pages.
    requestAnimationFrame(() => viewer.current?.scrollToPage(target));
  }, [doc]);

  /** Run one task against the worker at a time, reporting failures in the status line. */
  function runTask(action: string, task: (pdf: PdfWorkerClient) => Promise<void>) {
    if (workingRef.current || !docRef.current) return Promise.resolve();
    workingRef.current = true;
    setBusy(true);
    const run = (async () => {
      try {
        await task(getClient());
      } catch (err) {
        reportError(action, err);
      } finally {
        workingRef.current = false;
        setBusy(false);
      }
    })();
    currentTask.current = run;
    return run;
  }

  const targets = targetPages(selection, page);
  /** Page tools and saving wait while a stamp is being placed. */
  const locked = busy || pending !== undefined || drafting;

  function rotate(degrees: RotationDelta) {
    const pages = targets;
    void runTask("rotate the pages", async (pdf) => {
      const result = await pdf.rotatePages(pages, degrees);
      applyEdit(result, `Rotated ${countPages(pages.length)}.`);
    });
  }

  function deleteSelected() {
    const pages = targets;
    void runTask("delete the pages", async (pdf) => {
      const result = await pdf.deletePages(pages);
      applyEdit(
        result,
        `Deleted ${countPages(pages.length)}. Undo with Ctrl+Z.`,
        EMPTY_SELECTION,
        pages[0],
      );
    });
  }

  function movePages(pages: number[], dropBefore: number) {
    const to = moveTarget(pages, dropBefore);
    if (to === null) return;
    void runTask("move the pages", async (pdf) => {
      const result = await pdf.movePages(pages, to);
      applyEdit(result, `Moved ${countPages(pages.length)}.`, selectRun(to, pages.length), to);
    });
  }

  function insertBlank() {
    const at = (targets[targets.length - 1] as number) + 1;
    void runTask("insert a page", async (pdf) => {
      const result = await pdf.insertBlankPages(at, 1);
      applyEdit(result, "Inserted a blank page.", selectRun(at, 1), at);
    });
  }

  // ---- Signatures, initials and dates ----

  /** Show a stamp on the current page, ready to be dragged into place. */
  function startPlacing(
    kind: PendingStamp["kind"],
    image: StampImage,
    text?: string,
    textStamp?: PendingStamp["textStamp"],
  ) {
    const current = docRef.current;
    if (!current) return;
    // The page shown now: a picture may have taken a moment to read, and the view moved on.
    const page = pageRef.current;
    const size = current.info.pages[page];
    if (!size) return;
    // In the middle of what's on screen, not of the whole page, which may be mostly scrolled away.
    const centre = viewer.current?.visibleCentre(page) ?? undefined;
    const rect = initialRect(size, image.width / image.height, kind, centre);
    setTool(undefined); // Placing a stamp and drawing don't mix.
    setFormTool(undefined);
    setSelecting(false);
    setSelectedAnnot(null);
    setPending({ kind, image, text, textStamp, page, rect });
    setStatus(
      `Drag your ${STAMP_NOUN[kind]} into place, or click where it should go. ` +
        "Press Apply (or Enter) when it's right.",
    );
  }

  /** Read a picture and start placing it on the current page. */
  async function placePicture(file: File) {
    const startedWith = docRef.current;
    if (!startedWith || workingRef.current) return;
    // Everything else waits while the picture is read (a big photo takes a moment), so no
    // note, stamp or edit can start and then be swept away when it's ready.
    workingRef.current = true;
    setBusy(true);
    setStatus(`Reading ${file.name}…`);
    let image: StampImage;
    try {
      image = await pictureToImage(file);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : `${file.name} couldn't be read.`);
      return;
    } finally {
      workingRef.current = false;
      setBusy(false);
    }
    // The document was closed or replaced meanwhile: the picture isn't for this one.
    if (docRef.current !== startedWith) return;
    // No description from the file: its name could say more than the reader should see.
    startPlacing("image", image);
  }

  function addDate() {
    const text = formatToday();
    const image = dateToStamp(text, "#111111");
    if (image) startPlacing("date", image, text);
  }

  /** Move the pending stamp to where the user clicked, on whichever page, keeping its size. */
  function movePendingTo(index: number, point: { x: number; y: number }) {
    const size = docRef.current?.info.pages[index];
    if (!pending || !size) return;
    const { width, height } = pending.rect;
    const rect = { left: point.x - width / 2, top: point.y - height / 2, width, height };
    setPending({ ...pending, page: index, rect: clampRect(rect, size) });
  }

  function applyPending() {
    const stamp = pending;
    if (!stamp) return;
    const { left, top, width, height } = stamp.rect;
    void runTask(`add the ${STAMP_NOUN[stamp.kind]}`, async (pdf) => {
      const rect: [number, number, number, number] = [left, top, left + width, top + height];
      const result =
        stamp.kind === "stamp" && stamp.textStamp
          ? await pdf.addTextStamp({ page: stamp.page, rect, ...stamp.textStamp })
          : await pdf.addImageStamp({
              page: stamp.page,
              rect,
              // A copy: the bytes are handed over to the worker, and a saved image may be reused.
              image: stamp.image.png.slice(),
              kind: stamp.kind === "stamp" ? "image" : stamp.kind,
              text: stamp.text,
            });
      setPending(undefined);
      const where = `page ${stamp.page + 1}`;
      applyEdit(
        result,
        stamp.kind === "signature"
          ? `Signed ${where}. Save to keep it.`
          : `Added the ${STAMP_NOUN[stamp.kind]} to ${where}. Save to keep it.`,
      );
    });
  }

  function cancelPending() {
    setPending(undefined);
    setStatus("");
  }

  // ---- Annotations ----

  /** Pick a tool, or put it down if it's already picked. */
  function pickTool(id: ToolId) {
    if (tool === id) {
      setTool(undefined);
      setStatus("");
      return;
    }
    setSelecting(false);
    setSelectedAnnot(null);
    setFormTool(undefined);
    setTool(id);
    setStatus(`${toolById(id).hint}. Press Escape when you're done.`);
  }

  /** Pick the Select tool, or put it down. */
  function pickSelect() {
    setSelectedAnnot(null);
    if (selecting) {
      setSelecting(false);
      setStatus("");
      return;
    }
    setTool(undefined);
    setFormTool(undefined);
    setSelecting(true);
    setStatus("Click an annotation to select it. Press Escape when you're done.");
  }

  function selectAnnotation(page: number, annotation: AnnotationInfo | null) {
    setSelectedAnnot(annotation ? { page, annotation } : null);
    if (!annotation) return;
    const can = [
      "drag to move it",
      annotation.canResize ? "drag its corner to resize it" : null,
      "press Delete to remove it",
    ].filter(Boolean);
    setStatus(`Selected ${articled(annotation.label)}: ${can.join(", ")}.`);
  }

  function editAnnotation(page: number, annotation: AnnotationInfo, change: AnnotationChange) {
    const noun = `the ${annotation.label}`;
    void runTask(`change ${noun}`, async (pdf) => {
      const result = await pdf.editAnnotation(page, annotation.id, change);
      const done =
        change.text !== undefined
          ? `Updated ${noun}.`
          : change.color
            ? `Changed the colour of ${noun}.`
            : (result.history.undoLabel ?? "").startsWith("Resize")
              ? `Resized ${noun}.`
              : `Moved ${noun}.`;
      applyEdit(result, `${done} Undo with Ctrl+Z.`, undefined, undefined, true);
    });
  }

  function deleteAnnotation(page: number, annotation: AnnotationInfo) {
    const noun = `the ${annotation.label}`;
    void runTask(`delete ${noun}`, async (pdf) => {
      const result = await pdf.deleteAnnotation(page, annotation.id);
      setSelectedAnnot(null);
      applyEdit(result, `Deleted ${noun} from page ${page + 1}. Undo with Ctrl+Z.`);
    });
  }

  /** Mark every search result for redaction, to check and then apply. */
  function redactSearchHits() {
    // The search stops after its limit: marking only those would leave later matches in place
    // while seeming to have marked them all.
    if (query.trim() !== searched) return;
    if (truncated) {
      setStatus(
        `There are more than ${hits.length} matches, too many to mark at once. ` +
          "Search for something more specific, or mark areas with the Redact tool.",
      );
      return;
    }
    const marks = hits.map((h) => ({ page: h.page, quads: h.quads }));
    if (marks.length === 0) return;
    const word = searched ?? "the search";
    void runTask("mark the matches for redaction", async (pdf) => {
      const result = await pdf.markForRedaction(marks);
      applyEdit(
        result,
        `Marked ${marks.length === 1 ? "1 match" : `${marks.length} matches`} of "${word}" for redaction. ` +
          "Check them, then press Apply redactions.",
      );
    });
  }

  function applyRedactionsNow() {
    setRedactDialog(false);
    void runTask("apply the redactions", async (pdf) => {
      const result = await pdf.applyRedactions();
      const removed = result.annotationsRemoved
        ? `, and deleted ${result.annotationsRemoved === 1 ? "1 annotation" : `${result.annotationsRemoved} annotations`} under the marks`
        : "";
      applyEdit(
        result,
        `Redacted ${countPages(result.pages)}${removed}. Save to finish: the whole file will be ` +
          "rewritten, so nothing removed is left in it. Undo with Ctrl+Z.",
      );
    });
  }

  /** Note text typed in a form field that isn't in the document yet (null: there's none). */
  function setFormDraftValue(pageIndex: number, field: FormField, value: string | null) {
    if (value === null) {
      if (formDraft.current?.field.id === field.id) formDraft.current = null;
    } else {
      formDraft.current = { page: pageIndex, field, value };
    }
    setFormDraftPage(formDraft.current?.page ?? null);
  }

  /** Put a form field's new value in the document and show it. */
  async function fillField(
    pdf: PdfWorkerClient,
    pageIndex: number,
    field: FormField,
    value: string | boolean,
  ) {
    if (formDraft.current?.field.id === field.id) {
      formDraft.current = null;
      setFormDraftPage(null);
    }
    const hybrid = docRef.current?.info.form.xfa === "hybrid";
    const result = await pdf.setFieldValue(pageIndex, field.id, value);
    const note =
      hybrid && result.info.form.xfa === "none"
        ? " The form's XFA copy was removed, so every app shows what you filled in."
        : "";
    const what = READABLE_LABEL.test(field.label) ? `"${field.label}"` : "a form field";
    applyEdit(result, `Filled in ${what} on page ${pageIndex + 1}.${note} Undo with Ctrl+Z.`);
  }

  /** Fill in a form field, from its box on the page. */
  function setField(pageIndex: number, field: FormField, value: string | boolean) {
    void runTask("fill in the form field", (pdf) => fillField(pdf, pageIndex, field, value));
  }

  /** Put in text still being typed in a form field, if any (part of a running task). */
  async function commitFormDraft(pdf: PdfWorkerClient) {
    const draft = formDraft.current;
    if (draft) await fillField(pdf, draft.page, draft.field, draft.value);
  }

  function flattenFormNow() {
    setFlattenDialog(false);
    void runTask("flatten the form", async (pdf) => {
      const result = await pdf.flattenForm();
      setFocusedField(null);
      applyEdit(
        result,
        "Flattened the form: what was filled in is now part of the pages and can't be changed. " +
          "Undo with Ctrl+Z.",
      );
    });
  }

  // ---- Passwords and permissions ----

  /** Run a change from the password dialog: an error keeps the dialog open and shows there. */
  function runPasswordTask(action: string, task: (pdf: PdfWorkerClient) => Promise<void>) {
    void runTask(action, async (pdf) => {
      try {
        await task(pdf);
      } catch (err) {
        if (isFatalEngineError(err)) throw err;
        setPasswordDialog({ error: messageOf(err) });
      }
    });
  }

  function protectNow(spec: PasswordSpec) {
    runPasswordTask("set the password", async (pdf) => {
      const result = await pdf.setPassword(spec);
      setPasswordDialog(undefined);
      applyEdit(
        result,
        `${spec.openPassword ? "Password set" : "Limits set"}: the file is protected when you ` +
          "save it, which rewrites the whole file. Undo with Ctrl+Z.",
      );
    });
  }

  function removePasswordNow() {
    runPasswordTask("remove the password", async (pdf) => {
      const result = await pdf.removePassword();
      setPasswordDialog(undefined);
      applyEdit(
        result,
        result.info.security.pending === "remove"
          ? "The password is removed when you save, which rewrites the whole file. Undo with Ctrl+Z."
          : "The file won't get a password when you save. Undo with Ctrl+Z.",
      );
    });
  }

  function unlockPermissionsNow(password: string) {
    runPasswordTask("unlock the permissions", async (pdf) => {
      const info = await pdf.unlockPermissions(password);
      if (!info) {
        setPasswordDialog({ error: "That isn't the permissions password." });
        return;
      }
      const current = docRef.current;
      if (current) {
        const next = { ...current, info };
        docRef.current = next;
        setDoc(next);
      }
      setPasswordDialog({});
      setStatus("Permissions unlocked: the password and limits can be changed.");
    });
  }

  // ---- New PDF ----

  async function createNow(spec: CreateSpec, name: string) {
    if (workingRef.current) return;
    // Asked before making anything, as the new PDF replaces the open one.
    if (
      (dirtyRef.current || formDraft.current !== null) &&
      !window.confirm(
        `You have unsaved changes to ${docRef.current?.fileName ?? "this PDF"}.\n\n` +
          "Make a new PDF anyway? Your changes will be lost.",
      )
    ) {
      return;
    }
    workingRef.current = true;
    setBusy(true);
    let bytes: Uint8Array;
    try {
      bytes = await getClient().createPdf(spec);
    } catch (err) {
      if (isFatalEngineError(err)) reportError("make the PDF", err);
      else setCreateDialog({ error: messageOf(err) });
      return;
    } finally {
      workingRef.current = false;
      setBusy(false);
    }
    setCreateDialog(undefined);
    const file = new File([bytes as BlobPart], `${name}.pdf`, { type: "application/pdf" });
    await openFile(file, { fresh: true, confirmed: true });
  }

  // ---- Compress ----

  function openCompress() {
    compressedBytes.current = null;
    setCompressDialog({});
  }

  function closeCompress() {
    compressedBytes.current = null;
    setCompressDialog(undefined);
  }

  function compressNow(preset: CompressPreset) {
    void runTask("compress the file", async (pdf) => {
      try {
        const result = await pdf.compressedCopy(preset);
        compressedBytes.current = result.bytes;
        setCompressDialog({
          outcome: { preset, size: result.bytes.byteLength, images: result.images },
        });
      } catch (err) {
        if (isFatalEngineError(err)) throw err;
        compressedBytes.current = null;
        setCompressDialog({ error: messageOf(err) });
      }
    });
  }

  function saveCompressed() {
    const bytes = compressedBytes.current;
    const fileName = doc?.fileName ?? "document.pdf";
    if (!bytes) return;
    void runTask("save the compressed copy", async () => {
      const destination = await chooseDestination(derivedName(fileName, "compressed"));
      if (!destination) {
        setStatus("Not saved.");
        return;
      }
      const outcome = await writeToDestination(destination, bytes);
      closeCompress();
      setStatus(
        `Saved the compressed copy (${formatSize(bytes.byteLength)}) as ` +
          `${outcome.fileName ?? "a new PDF"}. The open file isn't changed.`,
      );
    });
  }

  // ---- Export ----

  function exportNow(options: ExportOptions, pages: number[]) {
    if (!doc) return;
    const { fileName } = doc;
    const pageCount = doc.info.pageCount;
    const zipped = filePerPage(options.format) && pages.length > 1;
    const kind = zipped ? ZIP_TYPE : EXPORT_TYPES[options.format];
    exportStop.current = false;
    void runTask("export the pages", async (pdf) => {
      // Asked first, while the browser still counts it as part of the click.
      const destination = await chooseDestination(
        exportFileName(fileName, options.format, pages, pageCount),
        undefined,
        kind,
      );
      if (!destination) return;
      const exported: ExportedPage[] = [];
      let total = 0;
      try {
        for (const page of pages) {
          if (exportStop.current) {
            setExportDialog({});
            setStatus("Export stopped. Nothing was saved.");
            return;
          }
          setExportDialog({ progress: { done: exported.length, total: pages.length } });
          const bytes = await pdf.exportPage(page, options);
          total += bytes.byteLength;
          if (total > MAX_EXPORT_BYTES) {
            throw new Error(
              "That's too much to save at once (over 1.5 GB). Choose fewer pages or a lower " +
                "resolution.",
            );
          }
          // Each page's checksum now, while the next one is made, rather than all at the end.
          exported.push({ page, bytes, crc: zipped ? crc32(bytes) : undefined });
        }
        // Stop pressed while the last page was being made.
        if (exportStop.current) {
          setExportDialog({});
          setStatus("Export stopped. Nothing was saved.");
          return;
        }
        const file = assembleExport(fileName, options.format, exported, pageCount);
        const outcome = await writeToDestination(destination, file.bytes);
        setExportDialog(undefined);
        setStatus(
          `Exported ${countPages(pages.length)} as ${outcome.fileName ?? file.name}. ` +
            "The open file isn't changed.",
        );
      } catch (err) {
        if (isFatalEngineError(err)) {
          setExportDialog(undefined);
          throw err;
        }
        setExportDialog({ error: messageOf(err) });
      }
    });
  }

  // ---- Building forms ----

  function pickFormTool(id: NewFieldKind | "edit") {
    if (formTool === id) {
      setFormTool(undefined);
      setStatus("");
      return;
    }
    setTool(undefined);
    setSelecting(false);
    setSelectedAnnot(null);
    setFormTool(id);
    setStatus(
      id === "edit"
        ? "Click a field to change its name, options or default, or to delete it. Press Escape when you're done."
        : `Drag on a page where the ${FIELD_KIND_NAMES[id].toLowerCase()} goes, or click for the usual size. Press Escape when you're done.`,
    );
  }

  /**
   * Open the dialog for a new field whose box was just drawn, with a name no field has yet
   * ("Text field 3"), or for a radio button, the group the last one joined if it's still there.
   */
  function openAddDialog(kind: NewFieldKind, page: number, rect: [number, number, number, number]) {
    void (async () => {
      let names: Set<string>;
      try {
        names = new Set(await getClient().listFieldNames());
      } catch {
        names = new Set();
      }
      let suggestedName = "";
      if (kind === "radio" && lastRadioGroup.current && names.has(lastRadioGroup.current)) {
        suggestedName = lastRadioGroup.current;
      } else {
        const base = kind === "radio" ? "Group" : FIELD_KIND_NAMES[kind];
        for (let n = 1; !suggestedName || names.has(suggestedName); n++)
          suggestedName = `${base} ${n}`;
      }
      setFieldDialog({ mode: "add", kind, page, rect, suggestedName });
    })();
  }

  /** Run a field change from the dialog: an error keeps the dialog open and shows there. */
  function runFieldTask(action: string, task: (pdf: PdfWorkerClient) => Promise<void>) {
    void runTask(action, async (pdf) => {
      try {
        await task(pdf);
      } catch (err) {
        if (isFatalEngineError(err)) throw err;
        setFieldDialog((d) => (d ? { ...d, error: messageOf(err) } : d));
      }
    });
  }

  function addFieldNow(props: FieldProperties) {
    const d = fieldDialog;
    if (d?.mode !== "add") return;
    const noun = FIELD_KIND_NAMES[d.kind].toLowerCase();
    runFieldTask(`add the ${noun}`, async (pdf) => {
      const result = await pdf.addField({
        page: d.page,
        kind: d.kind,
        rect: d.rect,
        name: props.name,
        required: props.required,
        defaultValue: props.defaultValue,
        options: props.options,
        value: props.value,
        multiline: props.multiline,
      });
      if (d.kind === "radio") lastRadioGroup.current = props.name.trim();
      setFieldDialog(undefined);
      applyEdit(result, `Added ${articled(noun)} to page ${d.page + 1}. Undo with Ctrl+Z.`);
    });
  }

  function saveFieldNow(changes: FieldChanges) {
    const d = fieldDialog;
    if (d?.mode !== "edit") return;
    runFieldTask("change the field", async (pdf) => {
      const result = await pdf.updateField(d.page, d.field.id, changes);
      // The group the next radio button is offered follows a rename.
      if (d.field.kind === "radio" && changes.name && lastRadioGroup.current === d.field.name) {
        lastRadioGroup.current = changes.name.trim();
      }
      setFieldDialog(undefined);
      applyEdit(result, `Changed "${changes.name ?? d.field.name}". Undo with Ctrl+Z.`);
    });
  }

  function deleteFieldNow() {
    const d = fieldDialog;
    if (d?.mode !== "edit") return;
    runFieldTask("delete the field", async (pdf) => {
      const result = await pdf.deleteField(d.page, d.field.id);
      setFieldDialog(undefined);
      applyEdit(result, `Deleted "${d.field.name}" from page ${d.page + 1}. Undo with Ctrl+Z.`);
    });
  }

  function addAnnotation(spec: AnnotationSpec) {
    const { noun } = toolById(spec.kind);
    void runTask(`add ${noun}`, async (pdf) => {
      const result = await pdf.addAnnotation(spec);
      applyEdit(result, `Added ${noun} to page ${spec.page + 1}.`);
    });
  }

  function undoOrRedo(which: "undo" | "redo") {
    if (!(which === "undo" ? history.canUndo : history.canRedo)) return;
    const label = which === "undo" ? history.undoLabel : history.redoLabel;
    void runTask(which, async (pdf) => {
      const result = await (which === "undo" ? pdf.undo() : pdf.redo());
      if (!result) return;
      applyEdit(
        result,
        `${which === "undo" ? "Undone" : "Redone"}: ${label ?? "last change"}.`,
        EMPTY_SELECTION,
      );
    });
  }

  function extractSelected() {
    const pages = targets;
    const fileName = doc?.fileName ?? "document.pdf";
    void runTask("extract the pages", async (pdf) => {
      const destination = await chooseDestination(derivedName(fileName, describePages(pages)));
      if (!destination) {
        setStatus("Not saved.");
        return;
      }
      const outcome = await writeToDestination(destination, await pdf.extractPages(pages));
      setStatus(`Extracted ${countPages(pages.length)} into ${outcome.fileName ?? "a new PDF"}.`);
    });
  }

  function split(groups: number[][], names: string[]) {
    const fileName = doc?.fileName ?? "document.pdf";
    setPageDialog(undefined);
    void runTask("split the document", async (pdf) => {
      const folder = await chooseFolder();
      if (!folder) {
        setStatus("Not saved.");
        return;
      }
      setStatus(`Splitting into ${groups.length} files…`);
      const parts = await pdf.splitPages(groups);
      const result = await writeFiles(
        folder,
        parts.map((bytes, i) => ({
          bytes,
          name: derivedName(fileName, names[i] ?? `part-${i + 1}`),
        })),
      );
      setStatus(`${result === "saved" ? "Saved" : "Downloaded"} ${parts.length} files.`);
    });
  }

  async function insertPdfs(files: ChosenPdf[], position: InsertPosition) {
    const current = docRef.current;
    if (!current || workingRef.current) return;
    const count = current.info.pageCount;
    const at = { start: 0, before: page, after: page + 1, end: count }[position];
    workingRef.current = true;
    setBusy(true);
    try {
      const sources = await Promise.all(
        files.map(async (f) => ({
          bytes: new Uint8Array(await f.file.arrayBuffer()),
          password: f.password || undefined,
        })),
      );
      const result = await getClient().insertPdfs(at, sources);
      const added = result.info.pageCount - count;
      setPageDialog(undefined);
      applyEdit(
        result,
        `Added ${countPages(added)} from ${files.length === 1 ? files[0]?.file.name : `${files.length} files`}.`,
        selectRun(at, added),
        at,
      );
    } catch (err) {
      if (isFatalEngineError(err)) {
        setPageDialog(undefined);
        reportError("add the pages", err);
      } else {
        const locked = err instanceof PasswordRequiredError;
        setPageDialog((d) =>
          d?.kind === "insert"
            ? {
                ...d,
                needsPasswords: d.needsPasswords || locked,
                error: locked
                  ? "One of these files is password-protected. Enter its password and try again."
                  : `Could not add the pages: ${messageOf(err)}`,
              }
            : d,
        );
      }
    } finally {
      workingRef.current = false;
      setBusy(false);
    }
  }

  function onThumbClick(index: number, modifiers: { toggle: boolean; range: boolean }) {
    setSelection((s) => clickSelection(s, index, modifiers));
    if (!modifiers.toggle && !modifiers.range) goToPage(index);
  }

  // Warn before leaving with unsaved changes, or an answer still being typed in a form field.
  const unsaved = dirty || formDraftPage !== null;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  // Desktop: open the PDF the app was launched with ("Open with", double-click), once.
  const startupFileHandled = useRef(false);
  useEffect(() => {
    if (!isTauri() || startupFileHandled.current) return;
    startupFileHandled.current = true;
    (async () => {
      const name = await invoke<string | null>("startup_file_name");
      if (!name) return;
      const bytes = await invoke<ArrayBuffer>("read_startup_file");
      await openFile(new File([bytes], name, { type: "application/pdf" }));
    })().catch((err) => setStatus(`Could not open the file: ${messageOf(err)}`));
  });

  // ---- Navigation and zoom ----

  const pageCount = doc?.info.pageCount ?? 0;
  const goToPage = useCallback(
    (index: number) => {
      if (!pageCount) return;
      viewer.current?.scrollToPage(Math.min(pageCount - 1, Math.max(0, index)));
    },
    [pageCount],
  );

  const onCurrentPageChange = useCallback((index: number) => setPage(index), []);
  useEffect(() => setPageInput(String(page + 1)), [page]);

  const zoomBy = useCallback(
    (direction: 1 | -1) => setZoom({ mode: "custom", scale: stepZoom(scale, direction) }),
    [scale],
  );

  // ---- Search ----

  const showHit = useCallback((list: SearchHit[], index: number) => {
    const hit = list[index];
    if (!hit) return;
    setCurrentHit(index);
    viewer.current?.scrollToHit(hit);
  }, []);

  async function runSearch(direction: 1 | -1 = 1) {
    const text = query.trim();
    if (!doc || !text) {
      setHits([]);
      setSearched(null);
      return;
    }
    if (text === searched) {
      if (hits.length) showHit(hits, (currentHit + direction + hits.length) % hits.length);
      return;
    }
    const generation = ++searchGeneration.current;
    setSearching(true);
    try {
      const result = await getClient().search(text);
      // The search was cleared, replaced, or the document changed while it ran.
      if (generation !== searchGeneration.current) return;
      setHits(result.hits);
      setTruncated(result.truncated);
      setSearched(text);
      // Start from the page being read: the first hit on or after it for "next", the last
      // hit on or before it for "previous" (wrapping round if there's none that way).
      const hitsFound = result.hits;
      if (hitsFound.length) {
        let start: number;
        if (direction > 0) {
          start = hitsFound.findIndex((h) => h.page >= page);
          if (start < 0) start = 0;
        } else {
          start = hitsFound.length - 1;
          for (let i = hitsFound.length - 1; i >= 0; i--) {
            if ((hitsFound[i] as SearchHit).page <= page) {
              start = i;
              break;
            }
          }
        }
        showHit(hitsFound, start);
      }
    } catch (err) {
      if (generation === searchGeneration.current) reportError("search this file", err);
    } finally {
      if (generation === searchGeneration.current) setSearching(false);
    }
  }

  function clearSearch() {
    searchGeneration.current++;
    setSearching(false);
    setQuery("");
    setHits([]);
    setSearched(null);
  }

  // ---- Keyboard shortcuts ----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      // No shortcuts while a dialog is open: it has the user's attention (and its own keys).
      if (
        pageDialog ||
        passwordPrompt ||
        showProperties ||
        passwordDialog ||
        compressDialog ||
        exportDialog ||
        createDialog ||
        signDialog ||
        stampDialog ||
        redactDialog ||
        flattenDialog ||
        fieldDialog
      ) {
        return;
      }
      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        fileInput.current?.click();
        return;
      }
      if (!doc) return;
      if (
        (tool || selecting || formTool) &&
        !drafting &&
        e.key === "Escape" &&
        !typingInField(e.target)
      ) {
        // The first Escape lets go of the selection, the next puts the tool down.
        if (selectedAnnot) setSelectedAnnot(null);
        else {
          setTool(undefined);
          setSelecting(false);
          setFormTool(undefined);
        }
        setStatus("");
        return;
      }
      // Delete works on the selection wherever the focus is (it's lost for a moment while the
      // page is redrawn after each change).
      if (
        selectedAnnot &&
        !drafting &&
        !mod &&
        (e.key === "Delete" || e.key === "Backspace") &&
        !typingInField(e.target)
      ) {
        e.preventDefault();
        if (!busy) deleteAnnotation(selectedAnnot.page, selectedAnnot.annotation);
        return;
      }
      const nudge = selectedAnnot && !mod && !e.altKey && arrowDelta(e.key, e.shiftKey);
      if (selectedAnnot && nudge && !drafting && !typingInField(e.target)) {
        e.preventDefault();
        const size = doc.info.pages[selectedAnnot.page];
        const { annotation } = selectedAnnot;
        const rect = size && moveBox(annotation.rect, nudge[0], nudge[1], size);
        if (rect && !busy && !sameBox(rect, annotation.rect)) {
          editAnnotation(selectedAnnot.page, annotation, { rect });
        }
        return;
      }
      // While a stamp is being placed, its keys work wherever the focus is, even when its page
      // has scrolled out of view. Enter on a button is that button's own click.
      if (pending && !mod && !e.altKey && !typingInField(e.target)) {
        const size = doc.info.pages[pending.page];
        const enterOnButton = e.key === "Enter" && e.target instanceof HTMLButtonElement;
        const action =
          size && !enterOnButton ? placementKey(e.key, e.shiftKey, pending.rect, size) : null;
        if (action) {
          e.preventDefault();
          if (action.type === "change") setPending({ ...pending, rect: action.rect });
          else if (action.type === "apply" && !busy) applyPending();
          else if (action.type === "cancel" && !busy) cancelPending();
          return;
        }
      }
      const key = e.key.toLowerCase();
      if (mod && key === "s") {
        e.preventDefault();
        // Not while placing a stamp or typing a note: what's on screen isn't in the file yet.
        if (!pending && !drafting) void onSave(e.shiftKey);
      } else if (mod && !typingInField(e.target) && (key === "z" || key === "y")) {
        e.preventDefault();
        // Undo while placing a stamp means "never mind the stamp" (unless it's being applied).
        if (pending) {
          if (!busy) cancelPending();
        } else if (!drafting) undoOrRedo(key === "y" || e.shiftKey ? "redo" : "undo");
      } else if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomBy(1);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        zoomBy(-1);
      } else if (mod && e.key === "0") {
        e.preventDefault();
        setZoom({ mode: "fit-width", scale });
      } else if (!mod && !e.altKey && !typingInField(e.target)) {
        if (e.key === "Home") {
          e.preventDefault();
          goToPage(0);
        } else if (e.key === "End") {
          e.preventDefault();
          goToPage(pageCount - 1);
        } else if (e.key === "ArrowRight" && !viewer.current?.canScrollHorizontally()) {
          e.preventDefault();
          goToPage(page + 1);
        } else if (e.key === "ArrowLeft" && !viewer.current?.canScrollHorizontally()) {
          e.preventDefault();
          goToPage(page - 1);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- Drag and drop ----

  // Installed once, so the enter/leave counter survives re-renders; it opens files through
  // a ref that always points at the latest openFile.
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  /** Places a dropped picture, while a document is open and nothing else is in progress. */
  const dropPictureRef = useRef<((file: File) => void) | null>(null);
  dropPictureRef.current =
    doc && !locked && !pageDialog && !signDialog && !stampDialog && !redactDialog && !passwordPrompt
      ? (file) => void placePicture(file)
      : null;
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const pdf = files.find(isPdfFile);
      const picture = files.find(isPictureFile);
      // A picture dropped on an open document goes on the page; anything else is opened.
      if (!pdf && picture && dropPictureRef.current) dropPictureRef.current(picture);
      else if (pdf ?? files[0]) void openFileRef.current((pdf ?? files[0]) as File);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  // ---- Render ----

  const percent = scaleToPercent(scale);
  const zoomValue = zoom.mode === "custom" ? `custom` : zoom.mode;
  const progress = engine.status === "loading" ? engine.progress : null;
  const label = doc?.info.labels[page];

  const newButton = (
    <button
      type="button"
      className="tool"
      disabled={busy}
      onClick={() => setCreateDialog({})}
      title="Make a new PDF: blank pages, pictures, or text"
    >
      New
    </button>
  );

  const openButton = (
    <label className="button" aria-disabled={busy}>
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        accept="application/pdf,.pdf"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so choosing the same file again (e.g. to retry) still fires.
          e.target.value = "";
          if (file) void openFile(file);
        }}
      />
      Open
    </label>
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span aria-hidden="true">🐙</span> PDFoctopus
        </div>
        <div className="toolbar" role="toolbar" aria-label="Document">
          {doc && (
            <button
              type="button"
              className="tool"
              aria-pressed={sidebar}
              onClick={() => setSidebar((s) => !s)}
              title="Show or hide page thumbnails"
            >
              Pages
            </button>
          )}
          {openButton}
          {newButton}
          {doc && (
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={() => onSave(false)}
              title="Save (Ctrl+S)"
            >
              Save
              {dirty && (
                <span className="unsaved-dot" title="Unsaved changes">
                  <span aria-hidden="true">•</span>
                  <span className="visually-hidden">(unsaved changes)</span>
                </span>
              )}
            </button>
          )}
          {doc && (
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={() => onSave(true)}
              title="Save a copy under a new name (Ctrl+Shift+S)"
            >
              Save as
            </button>
          )}
          {doc && (
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={() => setExportDialog({})}
              title="Save pages as pictures, SVG drawings, text or a web page"
            >
              Export
            </button>
          )}
          {doc && (
            <>
              <span className="divider" />
              <button
                type="button"
                className="tool icon"
                onClick={() => goToPage(page - 1)}
                disabled={page === 0}
                aria-label="Previous page"
              >
                ‹
              </button>
              <form
                className="page-nav"
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = Number.parseInt(pageInput, 10);
                  if (Number.isFinite(n)) goToPage(n - 1);
                  else setPageInput(String(page + 1));
                }}
              >
                <input
                  aria-label="Page number"
                  inputMode="numeric"
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onBlur={() => setPageInput(String(page + 1))}
                  size={Math.max(2, String(pageCount).length)}
                />
                <span>
                  / {pageCount}
                  {label ? ` (${label})` : ""}
                </span>
              </form>
              <button
                type="button"
                className="tool icon"
                onClick={() => goToPage(page + 1)}
                disabled={page >= pageCount - 1}
                aria-label="Next page"
              >
                ›
              </button>
              <span className="divider" />
              <button
                type="button"
                className="tool icon"
                onClick={() => zoomBy(-1)}
                aria-label="Zoom out"
                title="Zoom out (Ctrl+-)"
              >
                −
              </button>
              <select
                aria-label="Zoom"
                value={zoomValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "fit-width" || v === "fit-page") setZoom({ mode: v, scale });
                  else if (v !== "custom") {
                    setZoom({ mode: "custom", scale: percentToScale(Number(v)) });
                  }
                }}
              >
                <option value="fit-width">Fit width</option>
                <option value="fit-page">Fit page</option>
                <option value="custom" hidden>
                  {percent}%
                </option>
                {ZOOM_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p}%
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="tool icon"
                onClick={() => zoomBy(1)}
                aria-label="Zoom in"
                title="Zoom in (Ctrl++)"
              >
                +
              </button>
              <span className="divider" />
              <form
                className="search"
                aria-label="Find in document"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runSearch(1);
                }}
              >
                <input
                  ref={searchInput}
                  type="search"
                  placeholder="Find in document"
                  aria-label="Find in document"
                  value={query}
                  onChange={(e) => {
                    if (e.target.value === "") {
                      clearSearch();
                      return;
                    }
                    setQuery(e.target.value);
                    // The text changed: a search still running is for the old text.
                    if (searching) {
                      searchGeneration.current++;
                      setSearching(false);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") clearSearch();
                    else if (e.key === "Enter" && e.shiftKey) {
                      e.preventDefault();
                      void runSearch(-1);
                    }
                  }}
                />
                <button
                  type="button"
                  className="tool icon"
                  onClick={() => void runSearch(-1)}
                  disabled={!query.trim()}
                  aria-label="Previous match"
                >
                  ↑
                </button>
                <button
                  type="submit"
                  className="tool icon"
                  disabled={!query.trim()}
                  aria-label="Next match"
                >
                  ↓
                </button>
                <span className="search-count" aria-live="polite">
                  {searching
                    ? "Searching…"
                    : searched === null
                      ? ""
                      : hits.length
                        ? `${currentHit + 1} of ${hits.length}${truncated ? "+" : ""}`
                        : "No matches"}
                </span>
                {/* Only for the search shown: not for results of an earlier one after the box changed. */}
                {hits.length > 0 && !searching && query.trim() === searched && (
                  <button
                    type="button"
                    className="tool"
                    disabled={locked}
                    onClick={redactSearchHits}
                    title={
                      truncated
                        ? "Too many matches to mark them all: search for something more specific"
                        : "Mark every match for redaction"
                    }
                  >
                    Redact all
                  </button>
                )}
              </form>
              <span className="divider" />
              <button type="button" className="tool" onClick={() => setShowProperties(true)}>
                Properties
              </button>
            </>
          )}
          <button
            type="button"
            className="tool theme-toggle"
            onClick={() => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] as Theme)}
            title={`${THEME_LABEL[theme]} (click to change)`}
            aria-label={`Theme: ${THEME_LABEL[theme]}. Click to change.`}
          >
            <span aria-hidden="true">{THEME_ICON[theme]}</span>
          </button>
        </div>
        {doc && (
          <div className="toolbar page-tools" role="toolbar" aria-label="Page tools">
            <button
              type="button"
              className="tool icon"
              disabled={locked || !history.canUndo}
              onClick={() => undoOrRedo("undo")}
              aria-label={history.undoLabel ? `Undo ${history.undoLabel}` : "Undo"}
              title={history.undoLabel ? `Undo ${history.undoLabel} (Ctrl+Z)` : "Nothing to undo"}
            >
              ↶
            </button>
            <button
              type="button"
              className="tool icon"
              disabled={locked || !history.canRedo}
              onClick={() => undoOrRedo("redo")}
              aria-label={history.redoLabel ? `Redo ${history.redoLabel}` : "Redo"}
              title={history.redoLabel ? `Redo ${history.redoLabel} (Ctrl+Y)` : "Nothing to redo"}
            >
              ↷
            </button>
            <span className="divider" />
            <span className="page-target" aria-live="polite">
              {selection.pages.length > 1
                ? `${selection.pages.length} pages selected`
                : `Page ${(targets[0] as number) + 1}`}
            </span>
            <button
              type="button"
              className="tool icon"
              disabled={locked}
              onClick={() => rotate(-90)}
              aria-label="Rotate left"
              title="Rotate left"
            >
              ⟲
            </button>
            <button
              type="button"
              className="tool icon"
              disabled={locked}
              onClick={() => rotate(90)}
              aria-label="Rotate right"
              title="Rotate right"
            >
              ⟳
            </button>
            <button
              type="button"
              className="tool"
              disabled={locked || targets.length >= pageCount}
              onClick={deleteSelected}
              title="Delete (Delete key in the page list)"
            >
              Delete
            </button>
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={extractSelected}
              title="Save these pages as a new PDF"
            >
              Extract
            </button>
            <span className="divider" />
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={insertBlank}
              title="Insert a blank page after these pages"
            >
              Blank page
            </button>
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={() =>
                setPageDialog({
                  kind: "insert",
                  title: "Insert pages from a PDF",
                  defaultPosition: "after",
                })
              }
            >
              Insert PDF
            </button>
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={() =>
                setPageDialog({ kind: "insert", title: "Merge PDFs", defaultPosition: "end" })
              }
              title="Add other PDFs to this one"
            >
              Merge
            </button>
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={() => setPageDialog({ kind: "split" })}
              title="Split into separate PDFs"
            >
              Split
            </button>
            <span className="divider" />
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={() => setSignDialog("signature")}
              title="Draw, type or upload your signature and place it on the page"
            >
              Sign
            </button>
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={() => setSignDialog("initials")}
              title="Add your initials"
            >
              Initials
            </button>
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={addDate}
              title="Add today's date"
            >
              Date
            </button>
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={() => setStampDialog(true)}
              title="Add a stamp such as Approved or Draft"
            >
              Stamp
            </button>
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={() => imageInput.current?.click()}
              title="Add a picture, such as a logo or a photo (you can also drop one on the page)"
            >
              Image
            </button>
            <span className="divider" />
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={() => setPasswordDialog({})}
              title="Protect the file with a password, or limit what people can do with it"
            >
              {doc.info.security.encrypted || doc.info.security.pending === "protect"
                ? "🔒 Password"
                : "Password"}
            </button>
            <button
              type="button"
              className="tool"
              disabled={locked}
              onClick={openCompress}
              title="Save a smaller copy of the file"
            >
              Compress
            </button>
            <input
              ref={imageInput}
              className="visually-hidden"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void placePicture(file);
              }}
            />
          </div>
        )}
        {doc && (
          <div className="toolbar annotate-tools" role="toolbar" aria-label="Annotate">
            <span className="toolbar-label">Annotate</span>
            <button
              type="button"
              className="tool icon"
              disabled={locked}
              aria-pressed={selecting}
              aria-label="Select, move or delete annotations"
              title="Select, move or delete annotations"
              onClick={pickSelect}
            >
              <span aria-hidden="true">⬚</span>
            </button>
            <span className="divider" />
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                className="tool icon"
                disabled={locked}
                aria-pressed={tool === t.id}
                aria-label={t.label}
                title={t.label}
                onClick={() => pickTool(t.id)}
              >
                <span aria-hidden="true">{t.icon}</span>
              </button>
            ))}
            {tool && hasColor(tool) && (
              <>
                <span className="divider" />
                <fieldset className="pdfo-fieldset pdfo-colours">
                  <legend className="visually-hidden">Colour</legend>
                  {PALETTE.map((c) => {
                    const current = toolColors[tool] ?? toolById(tool).defaultColor;
                    return (
                      <label key={c.label} className="pdfo-colour" title={c.label}>
                        <input
                          type="radio"
                          name="annotation-colour"
                          checked={current.join() === c.value.join()}
                          onChange={() => setToolColors((m) => ({ ...m, [tool]: c.value }))}
                        />
                        <span className="pdfo-swatch" style={{ background: cssColor(c.value) }} />
                        <span className="visually-hidden">{c.label}</span>
                      </label>
                    );
                  })}
                </fieldset>
              </>
            )}
            {tool && toolById(tool).hasWidth && (
              <select
                aria-label="Line width"
                value={lineWidth}
                onChange={(e) => setLineWidth(Number(e.target.value))}
              >
                {WIDTHS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </select>
            )}
            {doc.info.form.fields > 0 && (
              <>
                <span className="divider" />
                <button
                  type="button"
                  className="tool"
                  disabled={locked}
                  onClick={() => setFlattenDialog(true)}
                  title="Turn the form's fields into ordinary page content"
                >
                  Flatten form
                </button>
              </>
            )}
            {doc.info.redactionMarks > 0 && (
              <>
                <span className="divider" />
                <button
                  type="button"
                  className="tool redact-apply"
                  disabled={locked}
                  onClick={() => setRedactDialog(true)}
                  title="Remove what's under the redaction marks for good"
                >
                  Apply redactions ({doc.info.redactionMarks})
                </button>
              </>
            )}
          </div>
        )}
        {doc && (
          <div className="toolbar form-tools" role="toolbar" aria-label="Form">
            <span className="toolbar-label">Form</span>
            {FORM_TOOLS.map((kind) => (
              <button
                key={kind}
                type="button"
                className="tool"
                disabled={locked}
                aria-pressed={formTool === kind}
                title={`Add ${articled(FIELD_KIND_NAMES[kind].toLowerCase())}`}
                onClick={() => pickFormTool(kind)}
              >
                {FIELD_KIND_NAMES[kind]}
              </button>
            ))}
            <span className="divider" />
            <button
              type="button"
              className="tool"
              // Still enabled while picked, so it can be put down after deleting the last field.
              disabled={locked || (doc.info.form.fields === 0 && formTool !== "edit")}
              aria-pressed={formTool === "edit"}
              title="Change or delete a field"
              onClick={() => pickFormTool("edit")}
            >
              Edit fields
            </button>
          </div>
        )}
      </header>

      {(engine.status !== "ready" || status) && (
        <div className="notices">
          {engine.status === "loading" && (
            <div className="engine-loading">
              <progress
                value={progress?.total ? Math.min(progress.loaded, progress.total) : undefined}
                max={progress?.total ?? undefined}
                aria-label="PDF engine download"
              />
              <span className="status">{formatProgress(progress)}</span>
            </div>
          )}
          {engine.status === "failed" && (
            <div className="engine-loading" role="alert">
              <span className="status" title={engine.message}>
                The PDF engine could not be loaded. Check your connection and try again.
              </span>
              <button type="button" className="button secondary" onClick={startEngine}>
                Try again
              </button>
            </div>
          )}
          <p className="status" role="status" aria-live="polite">
            {status}
          </p>
        </div>
      )}

      <main className="app-main">
        {doc ? (
          // Keyed by document, so a newly opened file starts with fresh views and caches.
          <div className="workspace" key={doc.id}>
            {sidebar && (
              <Thumbnails
                pages={doc.info.pages}
                labels={doc.info.labels}
                renderer={doc.renderer}
                current={page}
                selected={selection.pages}
                onClickPage={onThumbClick}
                onMovePages={locked ? undefined : movePages}
                onKeyDown={(e) => {
                  const mod = e.ctrlKey || e.metaKey;
                  if (e.key === "Delete" || e.key === "Backspace") {
                    e.preventDefault();
                    if (!locked && targets.length < pageCount) deleteSelected();
                  } else if (mod && e.key.toLowerCase() === "a") {
                    e.preventDefault();
                    setSelection(selectAll(pageCount));
                  } else if (e.key === "Escape") {
                    setSelection(EMPTY_SELECTION);
                  }
                }}
              />
            )}
            <Viewer
              ref={viewer}
              pages={doc.info.pages}
              labels={doc.info.labels}
              renderer={doc.renderer}
              zoom={zoom}
              onZoomChange={setZoom}
              onScaleChange={setScale}
              onCurrentPageChange={onCurrentPageChange}
              hits={hits}
              currentHit={currentHit}
              onPageClick={pending && !busy ? movePendingTo : undefined}
              // A draft, or the selection (so it stays up to date), keeps its page loaded.
              keepPage={draftPage ?? formDraftPage ?? selectedAnnot?.page}
              renderPageOverlay={(index, viewScale) => {
                const size = doc.info.pages[index] ?? { width: 1, height: 1 };
                if (pending) {
                  return pending.page === index ? (
                    <Placement
                      rect={pending.rect}
                      page={size}
                      scale={viewScale}
                      imageUrl={pending.image.dataUrl}
                      noun={STAMP_NOUN[pending.kind]}
                      busy={busy}
                      onChange={(rect) => setPending((p) => (p ? { ...p, rect } : p))}
                      onApply={applyPending}
                      onCancel={cancelPending}
                    />
                  ) : null;
                }
                if (selecting) {
                  return (
                    <SelectLayer
                      key={`${editVersion}:${index}`}
                      pageIndex={index}
                      page={size}
                      scale={viewScale}
                      busy={busy}
                      blocked={drafting && draftPage !== index}
                      selectedId={
                        selectedAnnot?.page === index ? selectedAnnot.annotation.id : null
                      }
                      list={() => getClient().listAnnotations(index)}
                      onSelect={(a) => selectAnnotation(index, a)}
                      onRefresh={(annotation) => setSelectedAnnot({ page: index, annotation })}
                      onEdit={(a, change) => editAnnotation(index, a, change)}
                      onDelete={(a) => deleteAnnotation(index, a)}
                      onDraftChange={setDraftPage}
                    />
                  );
                }
                if (formTool === "edit") {
                  return (
                    <FieldEditLayer
                      key={`${editVersion}:${index}`}
                      scale={viewScale}
                      busy={busy}
                      list={() => getClient().listFields(index)}
                      onPick={(field) => setFieldDialog({ mode: "edit", page: index, field })}
                    />
                  );
                }
                if (formTool) {
                  return (
                    <FieldDrawLayer
                      kind={formTool}
                      page={size}
                      scale={viewScale}
                      busy={busy}
                      onDraw={(rect) => openAddDialog(formTool, index, rect)}
                    />
                  );
                }
                if (!tool) {
                  if (doc.info.form.fields === 0) return null;
                  return (
                    <FormLayer
                      key={`${editVersion}:${index}`}
                      pageIndex={index}
                      scale={viewScale}
                      busy={busy || drafting}
                      list={() => getClient().listFields(index)}
                      onSet={(field, value) => setField(index, field, value)}
                      onDraft={(field, value) => setFormDraftValue(index, field, value)}
                      focusId={focusedField}
                      onFocusField={setFocusedField}
                    />
                  );
                }
                const picked = toolById(tool);
                return (
                  <AnnotateLayer
                    // A fresh layer after every edit, so nothing half-done carries over to
                    // whatever page now has this index.
                    key={`${editVersion}:${index}`}
                    pageIndex={index}
                    page={size}
                    scale={viewScale}
                    tool={picked}
                    color={toolColors[tool] ?? picked.defaultColor}
                    width={lineWidth}
                    busy={busy}
                    selectText={(from, to) => getClient().selectText(index, from, to)}
                    onCommit={addAnnotation}
                    onDraftChange={setDraftPage}
                    blocked={drafting && draftPage !== index}
                  />
                );
              }}
            />
          </div>
        ) : (
          <div className="empty-state">
            <p className="empty-title">Open a PDF to get started</p>
            <p className="status">Drag a file here, or</p>
            {openButton}
            <p className="status">or</p>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setCreateDialog({})}
            >
              Make a new PDF
            </button>
            <p className="status">Your files stay on your device.</p>
          </div>
        )}
      </main>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          {dropPictureRef.current
            ? "Drop a PDF to open it, or a picture to put it on the page"
            : "Drop a PDF to open it"}
        </div>
      )}

      {passwordPrompt && (
        <PasswordDialog
          fileName={passwordPrompt.fileName}
          onSubmit={async (password) => {
            try {
              const info = await getClient().authenticate(password);
              if (info) passwordPrompt.resolve(info);
              return info !== null;
            } catch (err) {
              reportError("unlock this file", err);
              passwordPrompt.resolve("failed");
              return true;
            }
          }}
          onCancel={() => passwordPrompt.resolve(null)}
        />
      )}

      {createDialog && (
        <CreateDialog
          busy={busy}
          error={createDialog.error}
          onCreate={(spec, name) => void createNow(spec, name)}
          onCancel={() => setCreateDialog(undefined)}
        />
      )}
      {compressDialog && doc && (
        <CompressDialog
          sizeNow={doc.fileSize}
          edited={dirty}
          outcome={compressDialog.outcome}
          error={compressDialog.error}
          busy={busy}
          onCompress={compressNow}
          onSave={saveCompressed}
          onClose={closeCompress}
        />
      )}
      {exportDialog && doc && (
        <ExportDialog
          fileName={doc.fileName}
          pageCount={doc.info.pageCount}
          current={page}
          selected={selection.pages}
          progress={exportDialog.progress}
          error={exportDialog.error}
          onExport={exportNow}
          onStop={() => {
            exportStop.current = true;
          }}
          onClose={() => setExportDialog(undefined)}
        />
      )}
      {passwordDialog && doc && (
        <SecurityDialog
          security={doc.info.security}
          error={passwordDialog.error}
          busy={busy}
          onProtect={protectNow}
          onRemove={removePasswordNow}
          onUnlock={unlockPermissionsNow}
          onCancel={() => setPasswordDialog(undefined)}
        />
      )}
      {showProperties && doc && (
        <PropertiesDialog
          fileName={doc.fileName}
          fileSize={doc.fileSize}
          info={doc.info}
          onClose={() => setShowProperties(false)}
        />
      )}

      {pageDialog?.kind === "split" && doc && (
        <SplitDialog
          pageCount={pageCount}
          initialRanges={selection.pages.length ? formatRanges(selection.pages) : ""}
          onSplit={split}
          onCancel={() => setPageDialog(undefined)}
        />
      )}

      {pageDialog?.kind === "insert" && doc && (
        <InsertPdfDialog
          title={pageDialog.title}
          defaultPosition={pageDialog.defaultPosition}
          error={pageDialog.error}
          needsPasswords={pageDialog.needsPasswords}
          busy={busy}
          onInsert={(files, position) => void insertPdfs(files, position)}
          onCancel={() => setPageDialog(undefined)}
        />
      )}

      {redactDialog && doc && (
        <RedactDialog
          marks={doc.info.redactionMarks}
          onApply={applyRedactionsNow}
          onCancel={() => setRedactDialog(false)}
        />
      )}
      {fieldDialog?.mode === "add" && doc && (
        <FieldDialog
          // A fresh dialog for each box drawn.
          key={`add:${fieldDialog.page}:${fieldDialog.rect.join(",")}`}
          mode="add"
          kind={fieldDialog.kind}
          suggestedName={fieldDialog.suggestedName}
          suggestedValue={`Choice${(doc.info.form.fields ?? 0) + 1}`}
          error={fieldDialog.error}
          busy={busy}
          onSubmit={addFieldNow}
          onCancel={() => setFieldDialog(undefined)}
        />
      )}
      {fieldDialog?.mode === "edit" && doc && (
        <FieldDialog
          key={`edit:${fieldDialog.field.id}`}
          mode="edit"
          field={fieldDialog.field}
          error={fieldDialog.error}
          busy={busy}
          onSubmit={saveFieldNow}
          onDelete={deleteFieldNow}
          onCancel={() => setFieldDialog(undefined)}
        />
      )}
      {flattenDialog && doc && (
        <FlattenDialog onFlatten={flattenFormNow} onCancel={() => setFlattenDialog(false)} />
      )}
      {stampDialog && doc && (
        <StampDialog
          onPlace={(chosen) => {
            setStampDialog(false);
            startPlacing("stamp", chosen.image, undefined, {
              text: chosen.text,
              detail: chosen.detail,
              color: chosen.color,
            });
          }}
          onCancel={() => setStampDialog(false)}
        />
      )}
      {signDialog && doc && (
        <SignDialog
          // A fresh dialog for each kind, so a drawn signature isn't offered as initials.
          key={signDialog}
          kind={signDialog}
          onUse={(image) => {
            const kind = signDialog;
            setSignDialog(undefined);
            startPlacing(kind, image);
          }}
          onCancel={() => setSignDialog(undefined)}
        />
      )}

      <Footer />
    </div>
  );
}
