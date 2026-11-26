// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What to tell the user before text is changed: a stand-in font, text that runs into the next
// thing on the line, a line that had more than one font, a paragraph that no longer fits its
// space, and a signed file.

import type { ParagraphEditCheck, TextEditCheck } from "@pdfoctopus/core";

function fallbackWarning(
  check: { font: string; fallback: string | null; missing: string[] },
  font: string,
  noun: "line" | "paragraph",
): string | null {
  if (!check.fallback) return null;
  const chars = check.missing.map((c) => `“${c}”`);
  const list =
    chars.length <= 1
      ? (chars[0] ?? "some characters")
      : `${chars.slice(0, -1).join(", ")} and ${chars[chars.length - 1]}`;
  const which =
    check.font === check.fallback ? `the ${noun} will use` : "those characters will use";
  return `${font} in this file doesn't include ${list}, so ${which} ${check.fallback} instead. It may look a little different.`;
}

const SIGNED =
  "This file is digitally signed. Changing its text will show as a change made after signing, and some apps will say the signature is no longer valid for the file as it is now.";

/** Plain sentences, one per thing worth knowing; empty when the edit can go ahead quietly. */
export function editWarnings(check: TextEditCheck, signed: boolean, lineFont: string): string[] {
  const out: string[] = [];
  const font = fallbackWarning(check, lineFont, "line");
  if (font) out.push(font);
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
  if (signed) out.push(SIGNED);
  return out;
}

/** The same for a paragraph: a stand-in font, text that doesn't fit, a word too wide. */
export function paragraphWarnings(
  check: ParagraphEditCheck,
  signed: boolean,
  font: string,
): string[] {
  const out: string[] = [];
  const fallback = fallbackWarning(check, font, "paragraph");
  if (fallback) out.push(fallback);
  if (check.overflow) {
    const extra = check.lines - check.fit;
    out.push(
      `The new text needs ${check.lines} lines, but only ${check.fit} fit in the paragraph's space. If you apply it anyway, the last ${
        extra === 1 ? "line" : `${extra} lines`
      } will overlap what's below the paragraph. Nothing else on the page moves to make room.`,
    );
  }
  if (check.tooWide) {
    out.push(
      "A word is wider than the paragraph, so it will stick out past the paragraph's right edge.",
    );
  }
  if (signed) out.push(SIGNED);
  return out;
}
