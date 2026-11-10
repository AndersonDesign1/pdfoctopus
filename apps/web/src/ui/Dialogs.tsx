// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type DocumentInfo,
  describePages,
  parsePageRanges,
  splitEvery,
  splitSingle,
} from "@pdfoctopus/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, formatPageSize, formatPdfDate } from "./format";

/**
 * A native modal <dialog>: focus moves to its first control (the password field, or the
 * Close button), stays inside while it's open, and Escape closes it.
 */
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="pdfo-dialog"
      aria-labelledby="pdfo-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="pdfo-dialog-title">{title}</h2>
      {children}
    </dialog>
  );
}

export function PasswordDialog({
  fileName,
  onSubmit,
  onCancel,
}: {
  fileName: string;
  /** Resolves to false if the password was wrong. */
  onSubmit(password: string): Promise<boolean>;
  onCancel(): void;
}) {
  const [password, setPassword] = useState("");
  const [wrong, setWrong] = useState(false);
  const [checking, setChecking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // The field is disabled during the check, which drops focus; put it back after a wrong
  // password so the user can simply type again.
  useEffect(() => {
    if (wrong && !checking) inputRef.current?.focus();
  }, [wrong, checking]);
  return (
    <Modal title="Password required" onClose={onCancel}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setChecking(true);
          const ok = await onSubmit(password);
          setChecking(false);
          if (!ok) {
            setWrong(true);
            setPassword("");
          }
        }}
      >
        <p>
          <strong>{fileName}</strong> is protected. Enter its password to open it.
        </p>
        <label className="pdfo-field">
          Password
          <input
            ref={inputRef}
            type="password"
            value={password}
            disabled={checking}
            onChange={(e) => {
              setPassword(e.target.value);
              setWrong(false);
            }}
            aria-invalid={wrong}
            aria-describedby={wrong ? "pdfo-password-error" : undefined}
          />
        </label>
        {wrong && (
          <p id="pdfo-password-error" className="pdfo-error" role="alert">
            That password isn't right. Try again.
          </p>
        )}
        <div className="pdfo-dialog-actions">
          <button type="button" className="button secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={checking || password === ""}>
            Open
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PropertiesDialog({
  fileName,
  fileSize,
  info,
  onClose,
}: {
  fileName: string;
  fileSize: number;
  info: DocumentInfo;
  onClose(): void;
}) {
  const m = info.metadata;
  const first = info.pages[0];
  const mixedSizes =
    !!first &&
    info.pages.some(
      (p) => Math.abs(p.width - first.width) > 1 || Math.abs(p.height - first.height) > 1,
    );
  const rows: [string, string | undefined][] = [
    ["File", fileName],
    ["Size", formatBytes(fileSize)],
    ["Pages", String(info.pageCount)],
    [
      "Page size",
      first
        ? `${mixedSizes ? "Mixed sizes; first page " : ""}${formatPageSize(first.width, first.height)}`
        : undefined,
    ],
    ["Title", m.title],
    ["Author", m.author],
    ["Subject", m.subject],
    ["Keywords", m.keywords],
    ["Created", formatPdfDate(m.creationDate)],
    ["Modified", formatPdfDate(m.modificationDate)],
    ["Application", m.creator],
    ["PDF producer", m.producer],
    ["Format", m.format],
    ["Encryption", m.encryption ?? "None"],
  ];
  return (
    <Modal title="Document properties" onClose={onClose}>
      <dl className="pdfo-properties">
        {rows
          .filter(([, value]) => value)
          .map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      <div className="pdfo-dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

type SplitMode = "ranges" | "every" | "single";

/** Choose how to split the document. Resolves to the groups of 0-based pages. */
export function SplitDialog({
  pageCount,
  initialRanges,
  onSplit,
  onCancel,
}: {
  pageCount: number;
  /** Prefilled ranges, e.g. the selected pages. */
  initialRanges: string;
  onSplit(groups: number[][], names: string[]): void;
  onCancel(): void;
}) {
  const [mode, setMode] = useState<SplitMode>("ranges");
  const [ranges, setRanges] = useState(initialRanges);
  const [every, setEvery] = useState("1");

  const plan = useMemo((): { groups: number[][] } | { error: string } => {
    try {
      if (mode === "ranges") return { groups: parsePageRanges(ranges, pageCount) };
      if (mode === "every") return { groups: splitEvery(Number(every), pageCount) };
      return { groups: splitSingle(pageCount) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [mode, ranges, every, pageCount]);

  const groups = "groups" in plan ? plan.groups : [];
  return (
    <Modal title="Split into separate PDFs" onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (groups.length) onSplit(groups, groups.map(describePages));
        }}
      >
        <fieldset className="pdfo-fieldset">
          <legend className="visually-hidden">How to split</legend>
          <label className="pdfo-choice">
            <input
              type="radio"
              name="split-mode"
              checked={mode === "ranges"}
              onChange={() => setMode("ranges")}
            />
            Pages
            <input
              type="text"
              value={ranges}
              placeholder="e.g. 1-3, 5, 8-"
              aria-label="Page ranges, one file per range"
              onFocus={() => setMode("ranges")}
              onChange={(e) => setRanges(e.target.value)}
            />
          </label>
          <label className="pdfo-choice">
            <input
              type="radio"
              name="split-mode"
              checked={mode === "every"}
              onChange={() => setMode("every")}
            />
            Every
            <input
              type="number"
              min={1}
              max={pageCount}
              value={every}
              aria-label="Pages per file"
              onFocus={() => setMode("every")}
              onChange={(e) => setEvery(e.target.value)}
            />
            pages
          </label>
          <label className="pdfo-choice">
            <input
              type="radio"
              name="split-mode"
              checked={mode === "single"}
              onChange={() => setMode("single")}
            />
            Every page as its own file
          </label>
        </fieldset>
        <p className={"error" in plan ? "pdfo-error" : "pdfo-hint"} aria-live="polite">
          {"error" in plan
            ? plan.error
            : `Creates ${groups.length} file${groups.length === 1 ? "" : "s"}.` +
              (mode === "ranges" ? " Separate ranges with commas; each becomes one file." : "")}
        </p>
        <div className="pdfo-dialog-actions">
          <button type="button" className="button secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={groups.length === 0}>
            Split
          </button>
        </div>
      </form>
    </Modal>
  );
}

export interface ChosenPdf {
  /** Stable key for the list, since the same file can be chosen twice. */
  id: number;
  file: File;
  password: string;
}

let nextFileId = 1;

export type InsertPosition = "start" | "before" | "after" | "end";

const POSITION_LABEL: Record<InsertPosition, string> = {
  start: "At the start",
  before: "Before the current page",
  after: "After the current page",
  end: "At the end",
};

/**
 * Choose PDFs to add to the document: used for both "Merge" (default: at the end) and
 * "Insert from PDF" (default: after the current page). Files can be reordered and removed.
 */
export function InsertPdfDialog({
  title,
  defaultPosition,
  error,
  needsPasswords,
  busy,
  onInsert,
  onCancel,
}: {
  title: string;
  defaultPosition: InsertPosition;
  /** A problem from the last attempt, shown in the dialog. */
  error?: string;
  /** Show password fields: one of the files turned out to be protected. */
  needsPasswords?: boolean;
  /** True while the pages are being added. */
  busy: boolean;
  onInsert(files: ChosenPdf[], position: InsertPosition): void;
  onCancel(): void;
}) {
  const [files, setFiles] = useState<ChosenPdf[]>([]);
  const [position, setPosition] = useState(defaultPosition);

  const move = (from: number, to: number) =>
    setFiles((list) => {
      if (to < 0 || to >= list.length) return list;
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item as ChosenPdf);
      return next;
    });

  // Adding can't be stopped half-way, so the dialog can't be closed while it runs.
  const cancel = () => {
    if (!busy) onCancel();
  };

  return (
    <Modal title={title} onClose={cancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (files.length && !busy) onInsert(files, position);
        }}
      >
        <label className="button secondary">
          <input
            className="visually-hidden"
            type="file"
            multiple
            accept="application/pdf,.pdf"
            onChange={(e) => {
              const chosen = Array.from(e.target.files ?? []);
              e.target.value = "";
              setFiles((list) => [
                ...list,
                ...chosen.map((file) => ({ id: nextFileId++, file, password: "" })),
              ]);
            }}
          />
          Choose PDFs…
        </label>
        {files.length > 0 && (
          <ol className="pdfo-file-list" aria-label="Files to add, in order">
            {files.map((item, i) => (
              <li key={item.id}>
                <span className="pdfo-file-name" title={item.file.name}>
                  {item.file.name}
                </span>
                <span className="pdfo-hint">{formatBytes(item.file.size)}</span>
                <button
                  type="button"
                  className="tool icon"
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                  aria-label={`Move ${item.file.name} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="tool icon"
                  disabled={i === files.length - 1}
                  onClick={() => move(i, i + 1)}
                  aria-label={`Move ${item.file.name} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="tool icon"
                  onClick={() => setFiles((list) => list.filter((_, j) => j !== i))}
                  aria-label={`Remove ${item.file.name}`}
                >
                  ✕
                </button>
                {needsPasswords && (
                  <input
                    type="password"
                    placeholder="Password, if it has one"
                    aria-label={`Password for ${item.file.name}`}
                    value={item.password}
                    onChange={(e) =>
                      setFiles((list) =>
                        list.map((f, j) => (j === i ? { ...f, password: e.target.value } : f)),
                      )
                    }
                  />
                )}
              </li>
            ))}
          </ol>
        )}
        <label className="pdfo-field">
          Where
          <select value={position} onChange={(e) => setPosition(e.target.value as InsertPosition)}>
            {(Object.keys(POSITION_LABEL) as InsertPosition[]).map((p) => (
              <option key={p} value={p}>
                {POSITION_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="pdfo-error" role="alert">
            {error}
          </p>
        )}
        <div className="pdfo-dialog-actions">
          <button type="button" className="button secondary" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy || files.length === 0}>
            {busy ? "Adding…" : "Add pages"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
