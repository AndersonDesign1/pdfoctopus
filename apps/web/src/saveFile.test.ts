// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { type DirectoryHandle, derivedName, unusedName, writeFiles } from "./saveFile";

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

/** An in-memory folder: `entries` maps names to "file" or "folder". */
function fakeFolder(entries: Record<string, "file" | "folder">) {
  const written: Record<string, number> = {};
  const handle: DirectoryHandle = {
    async getFileHandle(name, { create }) {
      const kind = entries[name];
      if (kind === "folder") throw new DOMException("folder", "TypeMismatchError");
      if (!kind && !create) throw new DOMException("missing", "NotFoundError");
      entries[name] = "file";
      return {
        async createWritable() {
          return {
            async write(data: Blob) {
              written[name] = data.size;
            },
            async close() {},
          };
        },
      };
    },
  };
  return { handle, written };
}

describe("writeFiles into a folder", () => {
  it("never replaces existing files or folders, and numbers repeats in one batch", async () => {
    const { handle, written } = fakeFolder({ "a.pdf": "file", "b.pdf": "folder" });
    const result = await writeFiles({ kind: "handle", handle }, [
      { name: "a.pdf", bytes: new Uint8Array(1) },
      { name: "b.pdf", bytes: new Uint8Array(2) },
      { name: "c.pdf", bytes: new Uint8Array(3) },
      { name: "c.pdf", bytes: new Uint8Array(4) },
    ]);
    expect(result).toBe("saved");
    expect(written).toEqual({ "a 2.pdf": 1, "b 2.pdf": 2, "c.pdf": 3, "c 2.pdf": 4 });
  });
});
