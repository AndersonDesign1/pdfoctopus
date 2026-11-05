// SPDX-License-Identifier: AGPL-3.0-or-later

import { PdfWorkerClient, type RenderedPage } from "@pdfoctopus/core";
import { Footer, PageImage } from "@pdfoctopus/ui";
import { useEffect, useRef, useState } from "react";

export function App() {
  const client = useRef<PdfWorkerClient | null>(null);
  const [fileName, setFileName] = useState<string>();
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState<RenderedPage>();
  const [status, setStatus] = useState("Open a PDF to get started.");

  useEffect(() => {
    client.current = new PdfWorkerClient();
    return () => client.current?.terminate();
  }, []);

  async function onFile(file: File) {
    const pdf = client.current;
    if (!pdf) return;
    setStatus("Loading…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { pageCount } = await pdf.open(bytes);
      setFileName(file.name);
      setPageCount(pageCount);
      setPage(await pdf.renderPage(0));
      setStatus("");
    } catch (err) {
      setStatus(`Could not open this file: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>🐙 PDFoctopus</h1>
        <span className="badge">Work in progress</span>
      </header>
      <main className="app-main">
        <label className="file-picker">
          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
            }}
          />
          Open PDF
        </label>
        {status && <p className="status">{status}</p>}
        {page && (
          <>
            <p className="status">
              {fileName} · page 1 of {pageCount}
            </p>
            <PageImage
              png={page.png}
              width={page.width}
              height={page.height}
              alt="Page 1 of the PDF"
            />
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
