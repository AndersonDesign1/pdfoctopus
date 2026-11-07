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

  it("keeps years before 100 as written", () => {
    expect(parsePdfDate("D:00500615000000Z")?.getUTCFullYear()).toBe(50);
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

describe("parsePdfDate rejects malformed dates", () => {
  it.each([
    "D:20261303000000Z", // month 13
    "D:20260231000000Z", // 31 February
    "D:20261103250000Z", // hour 25
    "D:20261103142000+99'99'", // impossible offset
    "D:20261103142000 trailing junk",
  ])("%s", (value) => {
    expect(parsePdfDate(value)).toBeNull();
  });

  it("still accepts the trailing apostrophe some producers write", () => {
    expect(parsePdfDate("D:20261103142000+01'00'")?.toISOString()).toBe("2026-11-03T13:20:00.000Z");
    expect(parsePdfDate("D:20261103142000+0100")?.toISOString()).toBe("2026-11-03T13:20:00.000Z");
  });
});
