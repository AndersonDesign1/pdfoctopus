// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What to tell the user before a line of text is changed: a stand-in font, text that runs into
// the next thing on the line, a line that had more than one font, and a signed file.

import type { TextEditCheck } from "@pdfoctopus/core";

/** Plain sentences, one per thing worth knowing; empty when the edit can go ahead quietly. */
export function editWarnings(check: TextEditCheck, signed: boolean, lineFont: string): string[] {
  const out: string[] = [];
  if (check.fallback) {
    const chars = check.missing.map((c) => `“${c}”`);
    const list =
      chars.length <= 1
        ? (chars[0] ?? "some characters")
        : `${chars.slice(0, -1).join(", ")} and ${chars[chars.length - 1]}`;
    const which = check.font === check.fallback ? "the line will use" : "those characters will use";
    out.push(
      `${lineFont} in this file doesn't include ${list}, so ${which} ${check.fallback} instead. It may look a little different.`,
    );
  }
  if (check.tooWide) {
    out.push(
      "The new text is longer than the space it has: it will run into what comes next on the line, or off the page. Nothing else moves to make room.",
    );
  }
  if (check.mixedFonts) {
    out.push(
      "This line used more than one font or size. All of the new text will use the first one.",
    );
  }
  if (signed) {
    out.push(
      "This file is digitally signed. Changing its text will show as a change made after signing, and some apps will say the signature is no longer valid for the file as it is now.",
    );
  }
  return out;
}
