// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a key does in the Edit text boxes. While characters are being chosen with an input
// method (Chinese, Japanese, Korean), Enter and Escape belong to it: Enter picks the
// characters and Escape drops the choice, so neither applies or cancels the edit.

export type EditKey = "apply" | "cancel" | null;

export interface KeyInfo {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** Set by the browser while an input method is composing. */
  isComposing?: boolean;
  /** 229 for a key the input method handles (some browsers, at the end of composing). */
  keyCode?: number;
}

/** Whether an input method has the key: the event says so, or composing hasn't ended yet. */
export function composing(e: KeyInfo, active: boolean): boolean {
  return active || e.isComposing === true || e.keyCode === 229;
}

/** The line box: Enter applies, Escape cancels. */
export function lineKey(e: KeyInfo, active = false): EditKey {
  if (composing(e, active)) return null;
  if (e.key === "Enter") return "apply";
  if (e.key === "Escape") return "cancel";
  return null;
}

/** The paragraph box: Ctrl+Enter (Cmd+Enter) applies, Escape cancels, Enter is a line break. */
export function paragraphKey(e: KeyInfo, active = false): EditKey {
  if (composing(e, active)) return null;
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) return "apply";
  if (e.key === "Escape") return "cancel";
  return null;
}
