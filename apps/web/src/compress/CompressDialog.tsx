// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Compress: pick how hard to try, see the size before and after, and save the smaller copy as
// a new file. The document that's open isn't changed.

import type { CompressPreset } from "@pdfoctopus/core";
import { useState } from "react";
import { Modal } from "../ui/Dialogs";

const PRESETS: { id: CompressPreset; label: string; detail: string }[] = [
  {
    id: "high",
    label: "High quality",
    detail: "Pictures stay exactly as they are; the file is rebuilt and tidied up.",
  },
  {
    id: "balanced",
    label: "Balanced",
    detail: "Large pictures are scaled to 200 dpi. Good for sharing and printing.",
  },
  {
    id: "smallest",
    label: "Smallest",
    detail: "Pictures are scaled to 120 dpi and compressed more. Good for email and screens.",
  },
];

/** "1.4 MB", "820 KB". */
export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

export interface CompressOutcome {
  preset: CompressPreset;
  size: number;
  images: number;
}

export function CompressDialog({
  sizeNow,
  edited,
  outcome,
  error,
  busy,
  onCompress,
  onSave,
  onClose,
}: {
  /** The file's size as it was opened or last saved. */
  sizeNow: number;
  /** Whether there are unsaved changes (they're in the compressed copy too). */
  edited: boolean;
  /** The last compressed copy, if one was made. */
  outcome?: CompressOutcome;
  error?: string;
  busy: boolean;
  onCompress(preset: CompressPreset): void;
  onSave(): void;
  onClose(): void;
}) {
  const [preset, setPreset] = useState<CompressPreset>(outcome?.preset ?? "balanced");
  const ready = outcome && outcome.preset === preset;
  // Rounded down, so a copy is never called "100% smaller", and not worth saving unless it
  // saves at least 1%.
  const saving = ready ? Math.floor((1 - outcome.size / sizeNow) * 100) : 0;
  const smaller = ready && saving >= 1;

  return (
    <Modal
      title="Compress"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="pdfo-field-form">
        <fieldset className="pdfo-fieldset pdfo-presets">
          <legend>How small?</legend>
          {PRESETS.map((p) => (
            <label key={p.id} className="pdfo-choice pdfo-preset">
              <input
                type="radio"
                name="pdfo-compress-preset"
                checked={preset === p.id}
                disabled={busy}
                onChange={() => setPreset(p.id)}
              />
              <span>
                <strong>{p.label}</strong>
                <span className="status">{p.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="status">
          Now: <strong>{formatSize(sizeNow)}</strong>
          {edited ? " (before your unsaved changes, which the copy includes)" : ""}. The file you
          have open isn't changed: the smaller copy is saved as a new file.
        </p>
        {ready && (
          <p className="pdfo-compress-result" role="status">
            {smaller ? (
              <>
                Compressed: <strong>{formatSize(outcome.size)}</strong>, {saving}% smaller
                {outcome.images > 0
                  ? ` (${outcome.images} ${outcome.images === 1 ? "picture" : "pictures"} made smaller)`
                  : ""}
                .
              </>
            ) : (
              <>
                This file can't be made smaller this way (the copy would be{" "}
                {formatSize(outcome.size)}).
                {preset !== "smallest" ? " Try Smallest." : ""}
              </>
            )}
          </p>
        )}
        {error && (
          <p className="pdfo-error" role="alert">
            {error}
          </p>
        )}
        <div className="pdfo-dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            {smaller ? "Close" : "Cancel"}
          </button>
          {smaller ? (
            <button type="button" className="button" disabled={busy} onClick={onSave}>
              Save compressed copy…
            </button>
          ) : (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => onCompress(preset)}
            >
              {busy ? "Compressing…" : "Compress"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
