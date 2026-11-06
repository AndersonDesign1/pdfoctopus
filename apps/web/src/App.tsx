// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  EngineCrashedError,
  EngineLoadError,
  IncrementalSaveError,
  type LoadProgress,
  PdfWorkerClient,
  type RenderedPage,
} from "@pdfoctopus/core";
import { Footer, PageImage } from "@pdfoctopus/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { saveFile } from "./saveFile";

interface OpenDocument {
  fileName: string;
  pageCount: number;
  firstPage: RenderedPage;
}

type EngineState =
  | { status: "loading"; progress: LoadProgress | null }
  | { status: "ready" }
  | { status: "failed"; message: string };

const MB = 1024 * 1024;

function formatProgress(progress: LoadProgress | null): string {
  if (!progress) return "Loading the PDF engine…";
  const loaded = (progress.loaded / MB).toFixed(1);
  if (progress.total === null) return `Loading the PDF engine… ${loaded} MB`;
  return `Loading the PDF engine… ${loaded} of ${(progress.total / MB).toFixed(1)} MB`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function App() {
  const client = useRef<PdfWorkerClient | null>(null);
  const [engine, setEngine] = useState<EngineState>({ status: "loading", progress: null });
  const [doc, setDoc] = useState<OpenDocument>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Open a PDF to get started.");

  /** Start a fresh worker and begin loading MuPDF in the background. */
  const startEngine = useCallback(() => {
    client.current?.terminate();
    const pdf = new PdfWorkerClient({
      onLoadProgress: (progress) => {
        if (client.current === pdf) setEngine({ status: "loading", progress });
      },
    });
    client.current = pdf;
    setEngine({ status: "loading", progress: null });
    pdf.init().then(
      () => client.current === pdf && setEngine({ status: "ready" }),
      (err) => client.current === pdf && setEngine({ status: "failed", message: messageOf(err) }),
    );
    return pdf;
  }, []);

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
      // The document lived inside the crashed worker, so it's gone too.
      setDoc(undefined);
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

  async function onFile(file: File) {
    if (busy) return;
    const pdf = getClient();
    setBusy(true);
    setStatus(`Opening ${file.name}…`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { pageCount } = await pdf.open(bytes);
      const firstPage = await pdf.renderPage(0);
      // Update everything together, only once the whole open succeeded.
      setDoc({ fileName: file.name, pageCount, firstPage });
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

  const engineLoading = engine.status === "loading";
  const progress = engine.status === "loading" ? engine.progress : null;

  return (
    <div className="app">
      <header className="app-header">
        <h1>🐙 PDFoctopus</h1>
        <span className="badge">Work in progress</span>
      </header>
      <main className="app-main">
        <div className="toolbar">
          <label className="button" aria-disabled={busy}>
            <input
              className="visually-hidden"
              type="file"
              accept="application/pdf,.pdf"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Reset so choosing the same file again (e.g. to retry) still fires.
                e.target.value = "";
                if (file) void onFile(file);
              }}
            />
            Open PDF
          </label>
          {doc && (
            <button type="button" className="button" disabled={busy} onClick={onSave}>
              Save
            </button>
          )}
        </div>

        {engineLoading && (
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
        {doc && (
          <>
            <p className="status">
              {doc.fileName} · page 1 of {doc.pageCount}
            </p>
            <PageImage
              png={doc.firstPage.png}
              width={doc.firstPage.width}
              height={doc.firstPage.height}
              alt="Page 1 of the PDF"
            />
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
