// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DocumentInfo } from "@pdfoctopus/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
