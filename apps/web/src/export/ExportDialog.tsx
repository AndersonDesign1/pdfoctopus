// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Export: save pages as pictures (PNG, JPEG), drawings (SVG), plain text or a web page.
// Pictures and drawings are one file per page, in a ZIP when there are several; text and web
// pages are one file. Everything happens on this device.

import {
  DEFAULT_EXPORT_DPI,
  DEFAULT_JPEG_QUALITY,
  type ExportFormat,
  type ExportOptions,
  exportFileName,
  filePerPage,
  parsePageRanges,
} from "@pdfoctopus/core";
import { useState } from "react";
import { Modal } from "../ui/Dialogs";

const FORMATS: { id: ExportFormat; label: string; detail: string }[] = [
  { id: "png", label: "PNG pictures", detail: "Sharp, lossless pictures of the pages." },
  { id: "jpeg", label: "JPEG pictures", detail: "Smaller pictures, good for photos and scans." },
  {
    id: "svg",
    label: "SVG drawings",
    detail: "Drawings that stay sharp at any size, for design programs and web pages.",
  },
  {
    id: "text",
    label: "Plain text",
    detail: "The text of the pages, in reading order. Scanned pages have no text to export.",
  },
  {
    id: "html",
    label: "Web page (HTML)",
    detail: "The text and pictures of each page, placed as on the page, in one web page.",
  },
];

const RESOLUTIONS = [
  { dpi: 72, label: "72 dpi (screen)" },
  { dpi: 150, label: "150 dpi" },
  { dpi: 300, label: "300 dpi (print)" },
  { dpi: 600, label: "600 dpi" },
];

const QUALITIES = [
  { quality: 95, label: "High" },
  { quality: 85, label: "Medium" },
  { quality: 70, label: "Low (smaller files)" },
];

export type PageChoice = "all" | "current" | "selected" | "range";

/**
 * The pages (0-based, in order, each once) a choice means. Throws a readable error for a
 * range that can't be read.
 */
export function chosenPages(
  choice: PageChoice,
  options: { pageCount: number; current: number; selected: readonly number[]; range: string },
): number[] {
  const { pageCount, current, selected, range } = options;
  let pages: number[];
  if (choice === "all") pages = Array.from({ length: pageCount }, (_, i) => i);
  else if (choice === "current") pages = [current];
  else if (choice === "selected") pages = [...selected].sort((a, b) => a - b);
  else pages = parsePageRanges(range, pageCount).flat();
  return [...new Set(pages)].filter((p) => p >= 0 && p < pageCount);
}

export interface ExportProgress {
  done: number;
  total: number;
}

export function ExportDialog({
  fileName,
  pageCount,
  current,
  selected,
  progress,
  error,
  onExport,
  onStop,
  onClose,
}: {
  fileName: string;
  pageCount: number;
  /** The page shown now (0-based). */
  current: number;
  /** The pages selected in the sidebar (0-based); offered when there are several. */
  selected: readonly number[];
  /** While exporting: how far it has got. */
  progress?: ExportProgress;
  error?: string;
  onExport(options: ExportOptions, pages: number[]): void;
  onStop(): void;
  onClose(): void;
}) {
  const [format, setFormat] = useState<ExportFormat>("png");
  const [choice, setChoice] = useState<PageChoice>(selected.length > 1 ? "selected" : "all");
  const [range, setRange] = useState("");
  const [dpi, setDpi] = useState(DEFAULT_EXPORT_DPI);
  const [quality, setQuality] = useState(DEFAULT_JPEG_QUALITY);
  const [problem, setProblem] = useState<string | null>(null);
  const working = progress !== undefined;
  const pictures = format === "png" || format === "jpeg";

  let pages: number[] = [];
  let rangeProblem: string | null = null;
  try {
    pages = chosenPages(choice, { pageCount, current, selected, range });
  } catch (err) {
    rangeProblem = err instanceof Error ? err.message : String(err);
  }
  const output =
    pages.length > 0 && !(choice === "range" && rangeProblem)
      ? exportFileName(fileName, format, pages, pageCount)
      : null;

  const exportNow = () => {
    if (working) return;
    if (choice === "range" && rangeProblem) return setProblem(rangeProblem);
    if (pages.length === 0) return setProblem("Choose at least one page.");
    setProblem(null);
    onExport(
      {
        format,
        ...(pictures ? { dpi } : {}),
        ...(format === "jpeg" ? { quality } : {}),
      },
      pages,
    );
  };

  const pageCountText = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;

  return (
    <Modal
      title="Export"
      onClose={() => {
        if (!working) onClose();
      }}
    >
      <div className="pdfo-field-form">
        <fieldset className="pdfo-fieldset pdfo-presets">
          <legend>Export as</legend>
          {FORMATS.map((f) => (
            <label key={f.id} className="pdfo-choice pdfo-preset">
              <input
                type="radio"
                name="pdfo-export-format"
                checked={format === f.id}
                disabled={working}
                onChange={() => setFormat(f.id)}
              />
              <span>
                <strong>{f.label}</strong>
                <span className="status">{f.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="pdfo-fieldset">
          <legend>Pages</legend>
          <label className="pdfo-choice">
            <input
              type="radio"
              name="pdfo-export-pages"
              checked={choice === "all"}
              disabled={working}
              onChange={() => setChoice("all")}
            />
            All ({pageCountText(pageCount)})
          </label>
          <label className="pdfo-choice">
            <input
              type="radio"
              name="pdfo-export-pages"
              checked={choice === "current"}
              disabled={working}
              onChange={() => setChoice("current")}
            />
            This page (page {current + 1})
          </label>
          {selected.length > 1 && (
            <label className="pdfo-choice">
              <input
                type="radio"
                name="pdfo-export-pages"
                checked={choice === "selected"}
                disabled={working}
                onChange={() => setChoice("selected")}
              />
              The selected pages ({pageCountText(selected.length)})
            </label>
          )}
          <div className="pdfo-choice">
            <input
              id="pdfo-export-range-choice"
              type="radio"
              name="pdfo-export-pages"
              checked={choice === "range"}
              disabled={working}
              onChange={() => setChoice("range")}
            />
            <label htmlFor="pdfo-export-range-choice">Pages</label>
            <input
              type="text"
              aria-label="Pages to export, such as 1-3, 5"
              placeholder="e.g. 1-3, 5"
              value={range}
              disabled={working}
              onFocus={() => setChoice("range")}
              onChange={(e) => setRange(e.target.value)}
            />
          </div>
        </fieldset>

        {pictures && (
          <div className="pdfo-create-paper">
            <label className="pdfo-field">
              Resolution
              <select
                value={dpi}
                disabled={working}
                onChange={(e) => setDpi(Number(e.target.value))}
              >
                {RESOLUTIONS.map((r) => (
                  <option key={r.dpi} value={r.dpi}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            {format === "jpeg" && (
              <label className="pdfo-field">
                Quality
                <select
                  value={quality}
                  disabled={working}
                  onChange={(e) => setQuality(Number(e.target.value))}
                >
                  {QUALITIES.map((q) => (
                    <option key={q.quality} value={q.quality}>
                      {q.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        <p className="status" aria-live="polite">
          {working
            ? `Exporting page ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
            : output &&
              `Saves ${output}${
                filePerPage(format) && pages.length > 1
                  ? ` (${pages.length} files in a ZIP archive)`
                  : ""
              }. The open file isn't changed.`}
        </p>
        {(problem || error) && (
          <p className="pdfo-error" role="alert">
            {problem ?? error}
          </p>
        )}
        <div className="pdfo-dialog-actions">
          <button type="button" className="button secondary" onClick={working ? onStop : onClose}>
            {working ? "Stop" : "Cancel"}
          </button>
          <button type="button" className="button" disabled={working} onClick={exportNow}>
            {working ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
