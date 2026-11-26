// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Limits for editing text that the app also uses. No MuPDF here, so the app can use them
// without loading the engine on the page (see stampRules.ts).

/** The longest new text for one line, in characters. */
export const MAX_LINE_TEXT = 1000;

/** The longest new text for a paragraph, in characters. */
export const MAX_PARAGRAPH_TEXT = 10_000;
