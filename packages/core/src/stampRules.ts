// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a text stamp may say and what it's called. No MuPDF here, so the app can use these
// limits without loading the engine.

export const MAX_STAMP_TEXT = 40;
export const MAX_STAMP_DETAIL = 60;

/**
 * Standard stamp names (PDF 1.7, 12.5.6.12), for stamps that say one of them, so other apps
 * recognise what they are. Other stamps get a name of our own.
 */
const STANDARD_NAMES: Record<string, string> = {
  APPROVED: "Approved",
  "NOT APPROVED": "NotApproved",
  DRAFT: "Draft",
  CONFIDENTIAL: "Confidential",
  FINAL: "Final",
  EXPERIMENTAL: "Experimental",
  EXPIRED: "Expired",
  "FOR COMMENT": "ForComment",
  "TOP SECRET": "TopSecret",
  "AS IS": "AsIs",
  SOLD: "Sold",
  DEPARTMENTAL: "Departmental",
  "FOR PUBLIC RELEASE": "ForPublicRelease",
  "NOT FOR PUBLIC RELEASE": "NotForPublicRelease",
};

/** The /Name for a stamp that says `text`. */
export function stampName(text: string): string {
  return STANDARD_NAMES[cleanStampText(text).toUpperCase()] ?? "PDFoctopusStamp";
}

/** Stamp text as it's drawn: trimmed, with runs of spaces (and line breaks) made one space. */
export function cleanStampText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Check stamp text: not empty, not too long, and only characters the standard fonts have
 * (printable Latin-1, which is the same in WinAnsi, the fonts' encoding).
 */
export function checkStampText(text: string, max: number, what: string): string {
  const t = cleanStampText(text);
  if (t.length > max) throw new Error(`The ${what} is too long (${max} characters at most)`);
  for (const ch of t) {
    const code = ch.codePointAt(0) as number;
    if (!((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff))) {
      throw new Error(
        `The ${what} can't include "${ch}". Stamps can use Latin letters, digits and common punctuation.`,
      );
    }
  }
  return t;
}

// Layout, in points at the stamp's natural size (before it's scaled to fit its box).
const MAIN_SIZE = 24;
const DETAIL_SIZE = 9;
/** Height of capital letters as a share of the font size, for Helvetica. */
const CAP_HEIGHT = 0.72;
const PAD_X = 10;
const PAD_Y = 7;
const LINE_GAP = 4;
export const BORDER = 2.5;
export const RADIUS = 6;

export interface StampLayout {
  width: number;
  height: number;
  main: { x: number; y: number; size: number };
  detail: { x: number; y: number; size: number } | null;
}

/** Where everything goes, given the width of each line at size 1. */
export function layoutStamp(mainWidth: number, detailWidth: number | null): StampLayout {
  const mainW = mainWidth * MAIN_SIZE;
  const detailW = detailWidth === null ? 0 : detailWidth * DETAIL_SIZE;
  const width = Math.max(mainW, detailW) + 2 * PAD_X;
  const mainCap = MAIN_SIZE * CAP_HEIGHT;
  const detailCap = DETAIL_SIZE * CAP_HEIGHT;
  const height = PAD_Y * 2 + mainCap + (detailWidth === null ? 0 : LINE_GAP + detailCap);
  return {
    width,
    height,
    main: { x: (width - mainW) / 2, y: height - PAD_Y - mainCap, size: MAIN_SIZE },
    detail: detailWidth === null ? null : { x: (width - detailW) / 2, y: PAD_Y, size: DETAIL_SIZE },
  };
}
