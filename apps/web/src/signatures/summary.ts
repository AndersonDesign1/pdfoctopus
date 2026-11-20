// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plain words for the Signatures panel and banner: what each signature's check found, and one
// line for the whole document. Kept apart from the components so it can be tested.

import type { SignatureReport } from "@pdfoctopus/core";
import type { CryptoCheck, SignatureStatus } from "@pdfoctopus/sign";

export type CheckedSignature = SignatureReport & { check: CryptoCheck; status: SignatureStatus };

/** How a signature looks: good, a warning, bad, or not known. */
export type Tone = "good" | "warn" | "bad" | "unknown";

export function signerName(s: CheckedSignature): string {
  return s.check.signer?.name || s.name || "an unknown signer";
}

/** The signature's state in a few words, and how it should look. */
export function statusOf(s: CheckedSignature): { tone: Tone; title: string; detail: string } {
  if (s.status === "broken") {
    return {
      tone: "bad",
      title: "Signature broken",
      detail: [...s.problems, ...s.check.problems][0] ?? "The signature doesn't check out.",
    };
  }
  if (s.status === "unknown") {
    return {
      tone: "unknown",
      title: "Couldn't check the signature",
      detail: s.check.problems[0] ?? "It uses a format that can't be checked yet.",
    };
  }
  if (s.status === "intact") {
    return {
      tone: "good",
      title: "Signature intact",
      detail: "Nothing was changed after it was signed.",
    };
  }
  switch (s.changes) {
    case "none":
      return {
        tone: "good",
        title: "Signature intact",
        detail: "The file was saved again after signing, without changes.",
      };
    case "signatures":
      return {
        tone: "good",
        title: "Signature intact",
        detail: "More signatures were added after it.",
      };
    case "form":
      return {
        tone: "warn",
        title: "Signature intact, form filled in later",
        detail: "Form fields were filled in after it was signed.",
      };
    case "annotations":
      return {
        tone: "warn",
        title: "Signature intact, comments added later",
        detail: "Comments or mark-up were added or changed after it was signed.",
      };
    case "other":
      return {
        tone: "bad",
        title: "Changed after signing",
        detail:
          "The document was changed after it was signed, beyond comments and form filling. What you see isn't what was signed.",
      };
    default:
      return {
        tone: "bad",
        title: "Changed after signing",
        detail: "Something was added after it was signed, and it couldn't be worked out what.",
      };
  }
}

const TONE_RANK: Record<Tone, number> = { good: 0, warn: 1, unknown: 2, bad: 3 };

/**
 * One line for the whole document, for the banner. `skipped`: signatures that weren't checked
 * (past the limit). A known bad result still wins; otherwise the banner says the check is
 * incomplete, and is never green.
 */
export function bannerFor(
  signatures: CheckedSignature[],
  skipped = 0,
): { tone: Tone; text: string } | null {
  if (signatures.length === 0) return null;
  const states = signatures.map((s) => ({ s, state: statusOf(s) }));
  const worst = states.reduce((a, b) =>
    TONE_RANK[b.state.tone] > TONE_RANK[a.state.tone] ? b : a,
  );
  const first = signerName(signatures[0] as CheckedSignature);
  const others = signatures.length - 1 + skipped;
  const who = others === 0 ? first : `${first} and ${others} other${others === 1 ? "" : "s"}`;
  if (skipped > 0 && worst.state.tone !== "bad") {
    const count = `${skipped} signature${skipped === 1 ? " wasn't" : "s weren't"}`;
    return { tone: "warn", text: `Signed by ${who}. Check incomplete: ${count} checked.` };
  }
  const subject = others === 0 ? "signature" : "signatures";
  switch (worst.state.tone) {
    case "good":
      return { tone: "good", text: `Signed by ${who}. ${capital(subject)} intact.` };
    case "warn":
      return {
        tone: "warn",
        text: `Signed by ${who}. ${capital(subject)} intact; ${lower(worst.state.detail)}`,
      };
    case "unknown":
      return { tone: "unknown", text: `Signed by ${who}. A signature couldn't be checked.` };
    default:
      return {
        tone: "bad",
        text:
          worst.s.status === "broken"
            ? `Signed by ${who}, but ${signerName(worst.s)}'s signature is broken.`
            : `Signed by ${who}, but the document was changed after signing.`,
      };
  }
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** What part of the file the signature covers. */
export function coverageOf(s: CheckedSignature): string {
  if (!s.byteRange || s.status === "broken") return "";
  const pages =
    s.signedPages === null ? "" : `, ${s.signedPages} page${s.signedPages === 1 ? "" : "s"}`;
  if (s.coversWholeFile) return `The whole file${pages}.`;
  return `Version ${s.revision} of ${s.revisions} of the file${pages}. The later versions were added after signing.`;
}
