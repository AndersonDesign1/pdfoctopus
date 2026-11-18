// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A picture of a text stamp ("APPROVED") for the dialog and for placing it. The engine draws
// the real stamp as vector graphics with the same layout; this only has to look the same.

import { layoutStamp, type RgbColor, STAMP_BORDER, STAMP_RADIUS } from "@pdfoctopus/core";
import { cssColor } from "../annotate/tools";
import type { StampImage } from "./stampImage";

/** Helvetica where it's installed, otherwise the closest the system has. */
const BOLD = "bold 100px Helvetica, Arial, 'Liberation Sans', sans-serif";
const REGULAR = "100px Helvetica, Arial, 'Liberation Sans', sans-serif";

/** Pixels per point: enough to stay sharp while it's dragged into place at high zoom. */
const SCALE = 4;

/** The stamp presets offered, with the colours they usually come in. */
export const STAMP_PRESETS: { text: string; color: RgbColor }[] = [
  { text: "APPROVED", color: [0.1, 0.5, 0.2] },
  { text: "NOT APPROVED", color: [0.8, 0.1, 0.1] },
  { text: "DRAFT", color: [0.15, 0.3, 0.75] },
  { text: "CONFIDENTIAL", color: [0.8, 0.1, 0.1] },
  { text: "FINAL", color: [0.1, 0.5, 0.2] },
  { text: "REVIEWED", color: [0.15, 0.3, 0.75] },
  { text: "PAID", color: [0.1, 0.5, 0.2] },
  { text: "RECEIVED", color: [0.15, 0.3, 0.75] },
];

/** Colours offered for stamps. */
export const STAMP_COLOURS: { label: string; value: RgbColor }[] = [
  { label: "Red", value: [0.8, 0.1, 0.1] },
  { label: "Green", value: [0.1, 0.5, 0.2] },
  { label: "Blue", value: [0.15, 0.3, 0.75] },
  { label: "Black", value: [0.1, 0.1, 0.1] },
];

/** A picture of the stamp, or null when there's no text. */
export function textStampPreview(text: string, detail: string, color: RgbColor): StampImage | null {
  const main = text.trim();
  const second = detail.trim();
  if (!main) return null;
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) return null;
  measure.font = BOLD;
  const mainWidth = measure.measureText(main).width / 100;
  measure.font = REGULAR;
  const detailWidth = second ? measure.measureText(second).width / 100 : null;
  const layout = layoutStamp(mainWidth, detailWidth);

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(layout.width * SCALE);
  canvas.height = Math.ceil(layout.height * SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(SCALE, SCALE);
  const css = cssColor(color);
  ctx.strokeStyle = css;
  ctx.fillStyle = css;
  ctx.lineWidth = STAMP_BORDER;
  const inset = STAMP_BORDER / 2;
  ctx.beginPath();
  ctx.roundRect(
    inset,
    inset,
    layout.width - STAMP_BORDER,
    layout.height - STAMP_BORDER,
    STAMP_RADIUS,
  );
  ctx.stroke();
  // The layout measures up from the bottom, as PDF does; the canvas measures down.
  ctx.font = BOLD.replace("100px", `${layout.main.size}px`);
  ctx.fillText(main, layout.main.x, layout.height - layout.main.y);
  if (second && layout.detail) {
    ctx.font = REGULAR.replace("100px", `${layout.detail.size}px`);
    ctx.fillText(second, layout.detail.x, layout.height - layout.detail.y);
  }
  const dataUrl = canvas.toDataURL("image/png");
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const png = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) png[i] = binary.charCodeAt(i);
  return { png, dataUrl, width: canvas.width, height: canvas.height };
}

/**
 * Why a stamp's text can't be used, or null if it's fine: the stamp is drawn with the
 * standard PDF fonts, which have Latin letters, digits and common punctuation only.
 */
export function stampTextProblem(text: string): string | null {
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (!((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff))) {
      return `Stamps can't show "${ch}" yet: use Latin letters, digits and common punctuation.`;
    }
  }
  return null;
}
