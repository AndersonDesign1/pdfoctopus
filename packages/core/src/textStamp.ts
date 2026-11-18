// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Text stamps ("APPROVED", "DRAFT", or the user's own words): a rounded border with bold
// text, and an optional smaller second line such as a date. They're drawn as vector graphics
// with the standard Helvetica fonts, so they stay sharp at any zoom and in print, and every
// PDF viewer has the fonts.

import * as mupdf from "mupdf";
import { BORDER, layoutStamp, RADIUS, type StampLayout } from "./stampRules";

/** Width of a line of text at size 1, from the font's own metrics. */
export function textWidth(font: mupdf.Font, text: string): number {
  let width = 0;
  for (const ch of text) width += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0) ?? 32));
  return width;
}

/** Text as a PDF hex string in WinAnsi (the same as Latin-1 for the characters allowed). */
function hexString(text: string): string {
  let hex = "";
  for (const ch of text) hex += (ch.codePointAt(0) ?? 32).toString(16).padStart(2, "0");
  return `<${hex}>`;
}

const num = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** A rounded rectangle path, inset by half the border so the border stays inside. */
function roundedRect(w: number, h: number): string {
  const i = BORDER / 2;
  const [x0, y0, x1, y1] = [i, i, w - i, h - i];
  const r = Math.min(RADIUS, (x1 - x0) / 2, (y1 - y0) / 2);
  const k = r * 0.5523; // How far a Bézier's control points sit for a quarter circle.
  return [
    `${num(x0 + r)} ${num(y0)} m`,
    `${num(x1 - r)} ${num(y0)} l`,
    `${num(x1 - r + k)} ${num(y0)} ${num(x1)} ${num(y0 + r - k)} ${num(x1)} ${num(y0 + r)} c`,
    `${num(x1)} ${num(y1 - r)} l`,
    `${num(x1)} ${num(y1 - r + k)} ${num(x1 - r + k)} ${num(y1)} ${num(x1 - r)} ${num(y1)} c`,
    `${num(x0 + r)} ${num(y1)} l`,
    `${num(x0 + r - k)} ${num(y1)} ${num(x0)} ${num(y1 - r + k)} ${num(x0)} ${num(y1 - r)} c`,
    `${num(x0)} ${num(y0 + r)} l`,
    `${num(x0)} ${num(y0 + r - k)} ${num(x0 + r - k)} ${num(y0)} ${num(x0 + r)} ${num(y0)} c`,
    "h",
  ].join("\n");
}

/**
 * The stamp's appearance: a form XObject `boxWidth` × `boxHeight` points (the stamp's box as
 * the page is shown), with the stamp scaled to fit it and centred. `rotation` turns it back by
 * the page's rotation, so it reads the right way up on a rotated page.
 */
export function stampAppearance(
  pdf: mupdf.PDFDocument,
  { text, detail, color }: { text: string; detail: string | null; color: [number, number, number] },
  boxWidth: number,
  boxHeight: number,
  rotation: number,
): mupdf.PDFObject {
  const bold = new mupdf.Font("Helvetica-Bold");
  const regular = new mupdf.Font("Helvetica");
  let layout: StampLayout;
  try {
    layout = layoutStamp(textWidth(bold, text), detail ? textWidth(regular, detail) : null);
  } finally {
    bold.destroy();
    regular.destroy();
  }
  const k = Math.min(boxWidth / layout.width, boxHeight / layout.height);
  const dx = (boxWidth - layout.width * k) / 2;
  const dy = (boxHeight - layout.height * k) / 2;
  const [r, g, b] = color.map(num);
  const ops = [
    "q",
    `${num(k)} 0 0 ${num(k)} ${num(dx)} ${num(dy)} cm`,
    `${r} ${g} ${b} RG ${BORDER} w`,
    roundedRect(layout.width, layout.height),
    "S",
    `BT /F1 ${layout.main.size} Tf ${r} ${g} ${b} rg ${num(layout.main.x)} ${num(layout.main.y)} Td ${hexString(text)} Tj ET`,
  ];
  if (detail && layout.detail) {
    ops.push(
      `BT /F2 ${layout.detail.size} Tf ${r} ${g} ${b} rg ${num(layout.detail.x)} ${num(layout.detail.y)} Td ${hexString(detail)} Tj ET`,
    );
  }
  ops.push("Q");

  const font = (base: string) => {
    const dict = pdf.newDictionary();
    dict.put("Type", pdf.newName("Font"));
    dict.put("Subtype", pdf.newName("Type1"));
    dict.put("BaseFont", pdf.newName(base));
    dict.put("Encoding", pdf.newName("WinAnsiEncoding"));
    return pdf.addObject(dict);
  };
  const fonts = pdf.newDictionary();
  fonts.put("F1", font("Helvetica-Bold"));
  if (detail) fonts.put("F2", font("Helvetica"));
  const resources = pdf.newDictionary();
  resources.put("Font", fonts);

  const form = pdf.newDictionary();
  form.put("Type", pdf.newName("XObject"));
  form.put("Subtype", pdf.newName("Form"));
  const bbox = pdf.newArray();
  for (const v of [0, 0, boxWidth, boxHeight]) bbox.push(v);
  form.put("BBox", bbox);
  form.put("Resources", resources);
  if (rotation !== 0) {
    const t = (rotation * Math.PI) / 180;
    const c = Math.round(Math.cos(t));
    const s = Math.round(Math.sin(t));
    const matrix = pdf.newArray();
    for (const v of [c, s, -s, c, 0, 0]) matrix.push(v);
    form.put("Matrix", matrix);
  }
  return pdf.addStream(ops.join("\n"), form);
}
