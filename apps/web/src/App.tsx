// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DocumentInfo,
  EngineCrashedError,
  EngineLoadError,
  IncrementalSaveError,
  type LoadProgress,
  PdfWorkerClient,
  type SearchHit,
} from "@pdfoctopus/core";
import { Footer } from "@pdfoctopus/ui";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { saveFile } from "./saveFile";
import { PasswordDialog, PropertiesDialog } from "./ui/Dialogs";
import { THEMES, type Theme, useTheme } from "./ui/theme";
import { percentToScale, scaleToPercent, stepZoom } from "./viewer/layout";
import { PageRenderer } from "./viewer/renderer";
import { Thumbnails } from "./viewer/Thumbnails";
import { Viewer, type ViewerHandle, type Zoom } from "./viewer/Viewer";

interface OpenDocument {
  /** Changes for every opened file, so per-document state resets. */
  id: number;
  fileName: string;
  fileSize: number;
  info: DocumentInfo;
  renderer: PageRenderer;
}

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

let nextDocId = 1;

export function App() {
  const client = useRef<PdfWorkerClient | null>(null);
  const viewer = useRef<ViewerHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const [engine, setEngine] = useState<EngineState>({ status: "loading", progress: null });
  const [doc, setDoc] = useState<OpenDocument>();
  const [busy, setBusy] = useState(false);
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
    setQuery("");
    setHits([]);
    setSearched(null);
    setCurrentHit(0);
    setPage(0);
    setShowProperties(false);
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
    if (busy) return;
    if (!isPdfFile(file)) {
      setStatus(`${file.name} isn't a PDF.`);
      return;
    }
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
      setBusy(false);
    }
  }

  async function onSave() {
    if (busy || !doc) return;
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
      const result = await saveFile(bytes, doc.fileName);
      setStatus(
        result === "saved"
          ? "Saved."
          : result === "downloaded"
            ? `Downloaded ${doc.fileName}.`
            : "Not saved.",
      );
    } catch (err) {
      reportError("save this file", err);
    } finally {
      setBusy(false);
    }
  }

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
      if (!doc) return;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void onSave();
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
      if (file) void openFile(file);
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
  });

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
              onClick={onSave}
              title="Save (Ctrl+S)"
            >
              Save
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
                onSelect={goToPage}
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

      <Footer />
    </div>
  );
}
