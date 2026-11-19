// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { defaultPaper, textKindOf } from "./CreateDialog";

describe("defaultPaper", () => {
  it("is US Letter where that's the usual paper, and A4 elsewhere", () => {
    expect(defaultPaper("en-US")).toBe("letter");
    expect(defaultPaper("fr-CA")).toBe("letter");
    expect(defaultPaper("es-MX")).toBe("letter");
    expect(defaultPaper("en-GB")).toBe("a4");
    expect(defaultPaper("de-DE")).toBe("a4");
    expect(defaultPaper("en")).toBe("a4");
  });
});

describe("textKindOf", () => {
  it("tells Markdown and HTML files from plain text by their names", () => {
    expect(textKindOf("README.md")).toBe("markdown");
    expect(textKindOf("notes.MARKDOWN")).toBe("markdown");
    expect(textKindOf("page.html")).toBe("html");
    expect(textKindOf("page.htm")).toBe("html");
    expect(textKindOf("notes.txt")).toBe("text");
    expect(textKindOf("no-extension")).toBe("text");
  });
});
