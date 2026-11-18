// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Choose a stamp ("APPROVED", "DRAFT", or your own words), its colour and an optional second
// line such as today's date, then place it on the page like a signature.

import { cleanStampText, MAX_STAMP_DETAIL, MAX_STAMP_TEXT, type RgbColor } from "@pdfoctopus/core";
import { useMemo, useState } from "react";
import { cssColor } from "../annotate/tools";
import { Modal } from "../ui/Dialogs";
import { formatToday } from "./ink";
import type { StampImage } from "./stampImage";
import {
  STAMP_COLOURS,
  STAMP_PRESETS,
  stampTextProblem,
  textStampPreview,
} from "./textStampPreview";

export interface ChosenStamp {
  text: string;
  detail: string;
  color: RgbColor;
  image: StampImage;
}

/**
 * Today's date in the user's own format, unless that uses characters the stamp's fonts don't
 * have (Arabic digits, for example): then in English.
 */
function todayForStamp(): string {
  const local = formatToday();
  return stampTextProblem(local) ? formatToday(new Date(), "en-GB") : local;
}

const sameColour = (a: RgbColor, b: RgbColor) =>
  a.every((v, i) => Math.abs(v - (b[i] ?? 0)) < 0.01);

export function StampDialog({
  onPlace,
  onCancel,
}: {
  onPlace(stamp: ChosenStamp): void;
  onCancel(): void;
}) {
  const first = STAMP_PRESETS[0] as (typeof STAMP_PRESETS)[number];
  const [text, setText] = useState(first.text);
  const [color, setColor] = useState<RgbColor>(first.color);
  const [detail, setDetail] = useState("");
  const problem = stampTextProblem(text) ?? stampTextProblem(detail);
  const preview = useMemo(
    () => (problem ? null : textStampPreview(text, detail, color)),
    [text, detail, color, problem],
  );

  return (
    <Modal title="Add a stamp" onClose={onCancel}>
      <form
        className="pdfo-stamp-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (preview) {
            onPlace({
              text: cleanStampText(text),
              detail: cleanStampText(detail),
              color,
              image: preview,
            });
          }
        }}
      >
        <fieldset className="pdfo-fieldset">
          <legend>Stamp</legend>
          <div className="pdfo-stamp-presets">
            {STAMP_PRESETS.map((p) => (
              <button
                key={p.text}
                type="button"
                className="pdfo-stamp-preset"
                aria-pressed={text === p.text && sameColour(color, p.color)}
                style={{ color: cssColor(p.color) }}
                onClick={() => {
                  setText(p.text);
                  setColor(p.color);
                }}
              >
                {p.text}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="pdfo-field">
          Text
          <input
            value={text}
            maxLength={MAX_STAMP_TEXT}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={stampTextProblem(text) !== null}
          />
        </label>
        <div className="pdfo-field">
          <label htmlFor="pdfo-stamp-detail">Second line (optional)</label>
          <span className="pdfo-stamp-detail">
            <input
              id="pdfo-stamp-detail"
              value={detail}
              maxLength={MAX_STAMP_DETAIL}
              placeholder="A date, a name, a reference…"
              onChange={(e) => setDetail(e.target.value)}
              aria-invalid={stampTextProblem(detail) !== null}
            />
            <button
              type="button"
              className="button secondary"
              onClick={() => setDetail(todayForStamp())}
            >
              Today's date
            </button>
          </span>
        </div>
        <fieldset className="pdfo-fieldset pdfo-colours">
          <legend>Colour</legend>
          {STAMP_COLOURS.map((c) => (
            <label key={c.label} className="pdfo-colour" title={c.label}>
              <input
                type="radio"
                name="stamp-colour"
                checked={sameColour(color, c.value)}
                onChange={() => setColor(c.value)}
              />
              <span className="pdfo-swatch" style={{ background: cssColor(c.value) }} />
              <span className="visually-hidden">{c.label}</span>
            </label>
          ))}
        </fieldset>
        <div className="pdfo-stamp-preview" aria-live="polite">
          {preview ? (
            <img src={preview.dataUrl} alt={`Preview: ${text.trim()} ${detail.trim()}`.trim()} />
          ) : (
            <p className={problem ? "pdfo-error" : "status"}>
              {problem ?? "Type what the stamp should say."}
            </p>
          )}
        </div>
        <div className="pdfo-dialog-actions">
          <button type="button" className="button secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={!preview}>
            Place stamp
          </button>
        </div>
      </form>
    </Modal>
  );
}
