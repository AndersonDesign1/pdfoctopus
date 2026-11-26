// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Signatures: a banner under the toolbar when the open file is signed, and a dialog listing
// each signature with whether it's intact and what was changed after it. Who signed is shown
// as the certificate says; it isn't checked against a trust list (the browser has none).

import { Modal } from "../ui/Dialogs";
import {
  bannerFor,
  type CheckedSignature,
  coverageOf,
  signerName,
  statusOf,
  type Tone,
  timestampOf,
} from "./summary";

/** The signatures of the open file: being checked, checked, or failed to check. */
export type SignaturesState =
  | { kind: "checking" }
  | { kind: "checked"; signatures: CheckedSignature[]; skipped: number }
  | { kind: "failed"; message: string };

const ICON: Record<Tone, string> = { good: "✓", warn: "!", bad: "✕", unknown: "?" };

function StatusIcon({ tone }: { tone: Tone }) {
  return (
    <span className={`sig-icon sig-${tone}`} aria-hidden="true">
      {ICON[tone]}
    </span>
  );
}

export function SignatureBanner({ state, onShow }: { state: SignaturesState; onShow(): void }) {
  let tone: Tone = "unknown";
  let text: string;
  if (state.kind === "checking") {
    text = "This file is signed. Checking the signatures…";
  } else if (state.kind === "failed") {
    text = "This file is signed, but its signatures couldn't be checked.";
  } else {
    const banner = bannerFor(state.signatures, state.skipped);
    if (!banner) return null;
    tone = banner.tone;
    text = banner.text;
  }
  return (
    <div className={`sig-banner sig-banner-${tone}`} role="status">
      <StatusIcon tone={tone} />
      <span className="sig-banner-text">{text}</span>
      <button type="button" className="button secondary sig-banner-button" onClick={onShow}>
        Signatures
      </button>
    </div>
  );
}

function formatTime(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function SignatureItem({ s, index }: { s: CheckedSignature; index: number }) {
  const state = statusOf(s);
  const cert = s.check.signer;
  const rows: [string, string | undefined][] = [
    ["Signed", formatTime(s.check.signingTime ?? s.time)],
    ["Timestamp", timestampOf(s, (ms) => formatTime(ms) ?? "")],
    ["Reason", s.reason],
    ["Location", s.location],
    ["Contact", s.contactInfo],
    ["Box", s.page === null ? "No visible box" : `On page ${s.page + 1}`],
    ["Covers", coverageOf(s) || undefined],
    [
      "Certificate",
      cert
        ? `${cert.subject || cert.name}, issued by ${cert.issuerName}, valid ${formatDay(cert.notBefore)} to ${formatDay(cert.notAfter)}`
        : undefined,
    ],
    ["Chain", s.check.chain.length > 1 ? s.check.chain.map((c) => c.name).join(" → ") : undefined],
    ["Hash", s.check.digestAlgorithm],
    ["Format", s.subFilter],
  ];
  const notes = [
    // What changed, when it goes beyond the kinds of change the summary already names.
    ...(s.status === "changed" && (s.changes === "other" || s.changes === "unknown")
      ? s.changeNotes
      : []),
    ...(s.status === "broken" ? [...s.problems, ...s.check.problems].slice(1) : []),
    ...s.check.warnings,
  ];
  return (
    <li className="sig-item">
      <div className="sig-item-head">
        <StatusIcon tone={state.tone} />
        <div>
          <div className="sig-item-title">
            {index + 1}. {signerName(s)}
            <span className={`sig-item-status sig-text-${state.tone}`}>{state.title}</span>
          </div>
          <p className="sig-item-detail">{state.detail}</p>
        </div>
      </div>
      {notes.length > 0 && (
        <ul className="sig-notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <dl className="pdfo-properties sig-details">
        {rows
          .filter(([, value]) => value)
          .map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
    </li>
  );
}

export function SignaturesDialog({
  state,
  edited,
  onClose,
}: {
  state: SignaturesState;
  /** Whether the open document has unsaved changes (they aren't part of any signature). */
  edited: boolean;
  onClose(): void;
}) {
  return (
    <Modal title="Signatures" onClose={onClose}>
      <div className="sig-dialog">
        {state.kind === "checking" && <p>Checking the signatures…</p>}
        {state.kind === "failed" && <p className="pdfo-error">{state.message}</p>}
        {state.kind === "checked" && state.signatures.length === 0 && (
          <p>This file has no signatures.</p>
        )}
        {state.kind === "checked" && state.signatures.length > 0 && (
          <>
            <ol className="sig-list">
              {state.signatures.map((s, i) => (
                <SignatureItem key={`${s.field}:${s.byteRange?.join(",")}`} s={s} index={i} />
              ))}
            </ol>
            {state.skipped > 0 && (
              <p className="sig-hint sig-text-warn">
                Only the first {state.signatures.length} signatures were checked; {state.skipped}{" "}
                more weren't.
              </p>
            )}
            <p className="sig-hint">
              Who signed is shown as their certificate says. It isn't checked against a list of
              trusted certificates, so the signer's identity isn't verified.
              {edited
                ? " Changes made since the file was opened aren't included; to check the file as saved, open it again."
                : ""}
            </p>
          </>
        )}
      </div>
      <div className="pdfo-dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
