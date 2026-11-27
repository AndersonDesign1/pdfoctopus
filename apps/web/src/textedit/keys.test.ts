// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { lineKey, paragraphKey } from "./keys";

describe("keys in the Edit text boxes", () => {
  it("applies and cancels a line with Enter and Escape", () => {
    expect(lineKey({ key: "Enter" })).toBe("apply");
    expect(lineKey({ key: "Escape" })).toBe("cancel");
    expect(lineKey({ key: "a" })).toBeNull();
  });

  it("leaves Enter and Escape to an input method while it's choosing characters", () => {
    // The browser says so, the key is the input method's (229), or composing hasn't ended.
    expect(lineKey({ key: "Enter", isComposing: true })).toBeNull();
    expect(lineKey({ key: "Enter", keyCode: 229 })).toBeNull();
    expect(lineKey({ key: "Enter" }, true)).toBeNull();
    expect(lineKey({ key: "Escape", isComposing: true })).toBeNull();
    expect(paragraphKey({ key: "Enter", ctrlKey: true, isComposing: true })).toBeNull();
    expect(paragraphKey({ key: "Enter", metaKey: true, keyCode: 229 })).toBeNull();
    expect(paragraphKey({ key: "Escape" }, true)).toBeNull();
  });

  it("applies a paragraph with Ctrl+Enter or Cmd+Enter only", () => {
    expect(paragraphKey({ key: "Enter" })).toBeNull();
    expect(paragraphKey({ key: "Enter", ctrlKey: true })).toBe("apply");
    expect(paragraphKey({ key: "Enter", metaKey: true })).toBe("apply");
    expect(paragraphKey({ key: "Escape" })).toBe("cancel");
  });
});
