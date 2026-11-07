// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { formatBytes, formatPageSize, parsePdfDate } from "./format";

describe("parsePdfDate", () => {
  it("parses full dates with time zones", () => {
    expect(parsePdfDate("D:20261103142000+01'00'")?.toISOString()).toBe("2026-11-03T13:20:00.000Z");
    expect(parsePdfDate("D:20261103142000Z")?.toISOString()).toBe("2026-11-03T14:20:00.000Z");
    expect(parsePdfDate("D:20261103142000-05'30")?.toISOString()).toBe("2026-11-03T19:50:00.000Z");
  });

  it("fills in missing parts", () => {
    expect(parsePdfDate("D:2026")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects text that isn't a date", () => {
    expect(parsePdfDate("yesterday")).toBeNull();
  });
});

describe("formatting", () => {
  it("formats sizes", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatPageSize(595, 842)).toBe("210 × 297 mm (A4)");
    expect(formatPageSize(842, 595)).toBe("297 × 210 mm (A4, landscape)");
    expect(formatPageSize(612, 792)).toBe("216 × 279 mm (Letter)");
  });
});
