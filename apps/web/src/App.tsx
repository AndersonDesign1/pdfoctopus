// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DocumentInfo,
  describePages,
  type EditResult,
  EngineCrashedError,
  EngineLoadError,
  type HistoryState,
  IncrementalSaveError,
  isFatalEngineError,
  type LoadProgress,
  PasswordRequiredError,
  PdfWorkerClient,
  type RotationDelta,
  type SearchHit,
} from "@pdfoctopus/core";
import { Footer } from "@pdfoctopus/ui";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { derivedName, type SaveTarget, saveFile, saveFiles } from "./saveFile";
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

function countPages(n: number): string {
  return `${n} page${n === 1 ? "" : "s"}`;
}

let nextDocId = 1;

export function App() {
  const client = useRef<PdfWorkerClient | null>(null);
  const viewer = useRef<ViewerHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
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
  const [pageDialog, setPageDialog] = useState<PageDialog>();
  /** A page to scroll to once the viewer has the edited document. */
  const pendingScroll = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  /** True while a file is being opened or saved; one operation at a time. */
  const workingRef = useRef(false);
  const [status, setStatus] = useState("");
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt>();
  const [showProperties, setShowProperties] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [theme, setTheme] = useTheme();

  const [zoom, setZoom] = useState<Zoom>({ mode: "fit-width", scale: 1 });
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState(0);
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
    setSelection(EMPTY_SELECTION);
    setHistory(NO_HISTORY);
    setDirty(false);
    setPageDialog(undefined);
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

  async function openFile(file: File) {
    // A ref, not the `busy` state: callbacks holding an older render's openFile (the
    // desktop startup file, a drop) would otherwise see a stale `busy` and run in parallel
    // with another open or a save.
    if (workingRef.current) return;
    if (!isPdfFile(file)) {
      setStatus(`${file.name} isn't a PDF.`);
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
      setStatus("");
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
    if (workingRef.current || !doc) return;
    workingRef.current = true;
    const pdf = getClient();
    setBusy(true);
    setStatus("Saving…");
    try {
      let bytes: Uint8Array;
      try {
        bytes = await pdf.save(true);
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
      const outcome = await saveFile(bytes, doc.fileName, saveAs ? undefined : doc.saveTarget);
      if (outcome.result === "cancelled") {
        setStatus("Not saved.");
        return;
      }
      const savedId = doc.id;
      setDoc((prev) =>
        prev && prev.id === savedId
          ? {
              ...prev,
              fileName: outcome.fileName ?? prev.fileName,
              saveTarget: outcome.target ?? prev.saveTarget,
            }
          : prev,
      );
      setDirty(false);
      const name = outcome.fileName ?? doc.fileName;
      setStatus(outcome.result === "saved" ? `Saved ${name}.` : `Downloaded ${name}.`);
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
  function applyEdit(result: EditResult, message: string, select?: Selection, scrollTo?: number) {
    const current = docRef.current;
    if (!current) return;
    const renderer = new PageRenderer(getClient());
    current.renderer.dispose();
    const next = { ...current, info: result.info, renderer };
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
  async function runTask(action: string, task: (pdf: PdfWorkerClient) => Promise<void>) {
    if (workingRef.current || !docRef.current) return;
    workingRef.current = true;
    setBusy(true);
    try {
      await task(getClient());
    } catch (err) {
      reportError(action, err);
    } finally {
      workingRef.current = false;
      setBusy(false);
    }
  }

  const targets = targetPages(selection, page);

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
      const bytes = await pdf.extractPages(pages);
      const outcome = await saveFile(bytes, derivedName(fileName, describePages(pages)));
      setStatus(
        outcome.result === "cancelled"
          ? "Not saved."
          : `Extracted ${countPages(pages.length)} into ${outcome.fileName ?? "a new PDF"}.`,
      );
    });
  }

  function split(groups: number[][], names: string[]) {
    const fileName = doc?.fileName ?? "document.pdf";
    setPageDialog(undefined);
    void runTask("split the document", async (pdf) => {
      setStatus(`Splitting into ${groups.length} files…`);
      const parts = await pdf.splitPages(groups);
      const result = await saveFiles(
        parts.map((bytes, i) => ({
          bytes,
          name: derivedName(fileName, names[i] ?? `part-${i + 1}`),
        })),
      );
      setStatus(
        result === "cancelled"
          ? "Not saved."
          : `${result === "saved" ? "Saved" : "Downloaded"} ${parts.length} files.`,
      );
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

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

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
      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        fileInput.current?.click();
        return;
      }
      if (!doc || pageDialog || passwordPrompt || showProperties) return;
      const key = e.key.toLowerCase();
      if (mod && key === "s") {
        e.preventDefault();
        void onSave(e.shiftKey);
      } else if (mod && !typingInField(e.target) && (key === "z" || key === "y")) {
        e.preventDefault();
        undoOrRedo(key === "y" || e.shiftKey ? "redo" : "undo");
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
      const file = files.find(isPdfFile) ?? files[0];
      if (file) void openFileRef.current(file);
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
          {doc && (
            <button
              type="button"
              className="tool"
              disabled={busy}
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
              disabled={busy}
              onClick={() => onSave(true)}
              title="Save a copy under a new name (Ctrl+Shift+S)"
            >
              Save as
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
              disabled={busy || !history.canUndo}
              onClick={() => undoOrRedo("undo")}
              aria-label={history.undoLabel ? `Undo ${history.undoLabel}` : "Undo"}
              title={history.undoLabel ? `Undo ${history.undoLabel} (Ctrl+Z)` : "Nothing to undo"}
            >
              ↶
            </button>
            <button
              type="button"
              className="tool icon"
              disabled={busy || !history.canRedo}
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
              disabled={busy}
              onClick={() => rotate(-90)}
              aria-label="Rotate left"
              title="Rotate left"
            >
              ⟲
            </button>
            <button
              type="button"
              className="tool icon"
              disabled={busy}
              onClick={() => rotate(90)}
              aria-label="Rotate right"
              title="Rotate right"
            >
              ⟳
            </button>
            <button
              type="button"
              className="tool"
              disabled={busy || targets.length >= pageCount}
              onClick={deleteSelected}
              title="Delete (Delete key in the page list)"
            >
              Delete
            </button>
            <button
              type="button"
              className="tool"
              disabled={busy}
              onClick={extractSelected}
              title="Save these pages as a new PDF"
            >
              Extract
            </button>
            <span className="divider" />
            <button
              type="button"
              className="tool"
              disabled={busy}
              onClick={insertBlank}
              title="Insert a blank page after these pages"
            >
              Blank page
            </button>
            <button
              type="button"
              className="tool"
              disabled={busy}
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
              disabled={busy}
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
              disabled={busy}
              onClick={() => setPageDialog({ kind: "split" })}
              title="Split into separate PDFs"
            >
              Split
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
                onMovePages={busy ? undefined : movePages}
                onKeyDown={(e) => {
                  const mod = e.ctrlKey || e.metaKey;
                  if (e.key === "Delete" || e.key === "Backspace") {
                    e.preventDefault();
                    if (targets.length < pageCount) deleteSelected();
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
            />
          </div>
        ) : (
          <div className="empty-state">
            <p className="empty-title">Open a PDF to get started</p>
            <p className="status">Drag a file here, or</p>
            {openButton}
            <p className="status">Your files stay on your device.</p>
          </div>
        )}
      </main>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          Drop a PDF to open it
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

      <Footer />
    </div>
  );
}
