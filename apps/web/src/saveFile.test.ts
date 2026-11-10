// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { derivedName, unusedName } from "./saveFile";

describe("unusedName", () => {
  it("keeps a free name and numbers one that's taken", async () => {
    const onDisk = new Set(["report (page-1).pdf", "report (page-1) 2.pdf"]);
    const exists = async (n: string) => onDisk.has(n);
    expect(await unusedName("report (page-2).pdf", exists)).toBe("report (page-2).pdf");
    expect(await unusedName("report (page-1).pdf", exists)).toBe("report (page-1) 3.pdf");
  });

  it("avoids names already chosen in the same batch, ignoring case", async () => {
    const none = async () => false;
    expect(await unusedName("a.pdf", none, new Set(["a.pdf"]))).toBe("a 2.pdf");
    expect(await unusedName("A.PDF", none, new Set(["a.pdf"]))).toBe("A 2.pdf");
  });
});

describe("derivedName", () => {
  it("adds a suffix before the extension", () => {
    expect(derivedName("report.pdf", "pages-1-3")).toBe("report (pages-1-3).pdf");
    expect(derivedName("Scan.PDF", "page-2")).toBe("Scan (page-2).pdf");
  });
});
