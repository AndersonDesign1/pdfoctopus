// SPDX-License-Identifier: AGPL-3.0-or-later

import { PdfWorkerClient, type RenderedPage } from "@pdfoctopus/core";
import { Footer, PageImage } from "@pdfoctopus/ui";
import { useEffect, useRef, useState } from "react";

interface OpenDocument {
  fileName: string;
  pageCount: number;
  firstPage: RenderedPage;
}

export function App() {
  const client = useRef<PdfWorkerClient | null>(null);
  const [doc, setDoc] = useState<OpenDocument>();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("Open a PDF to get started.");

  useEffect(() => {
    client.current = new PdfWorkerClient();
    return () => client.current?.terminate();
  }, []);

  async function onFile(file: File) {
    const pdf = client.current;
    if (!pdf || loading) return;
    setLoading(true);
    setStatus("Loading…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { pageCount } = await pdf.open(bytes);
      const firstPage = await pdf.renderPage(0);
      // Update everything together, only once the whole open succeeded.
      setDoc({ fileName: file.name, pageCount, firstPage });
      setStatus("");
    } catch (err) {
      setStatus(`Could not open this file: ${err instanceof Error ? err.message : err}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>🐙 PDFoctopus</h1>
        <span className="badge">Work in progress</span>
      </header>
      <main className="app-main">
        <label className="file-picker" aria-disabled={loading}>
          <input
            className="visually-hidden"
            type="file"
            accept="application/pdf,.pdf"
            disabled={loading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset so choosing the same file again (e.g. to retry) still fires.
              e.target.value = "";
              if (file) void onFile(file);
            }}
          />
          Open PDF
        </label>
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
