// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";
import { signatureBoxLines, signingTimeText } from "./certificate";

describe("signingTimeText", () => {
  test("local time with its offset from UTC", () => {
    const date = new Date(2026, 10, 19, 9, 5);
    const offset = -date.getTimezoneOffset();
    const sign = offset < 0 ? "-" : "+";
    const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
    const mm = String(Math.abs(offset) % 60).padStart(2, "0");
    expect(signingTimeText(date)).toBe(`2026-11-19 09:05 ${sign}${hh}:${mm}`);
  });
});

describe("signatureBoxLines", () => {
  test("reason and location only when given", () => {
    expect(signatureBoxLines("Ada", "2026-11-19", " ", "").map((l) => l.text)).toEqual([
      "Digitally signed by",
      "Ada",
      "Date: 2026-11-19",
    ]);
    const lines = signatureBoxLines("", "d", "Approved", "Leeds");
    expect(lines.map((l) => l.text)).toEqual([
      "Digitally signed by",
      "Unknown signer",
      "Date: d",
      "Reason: Approved",
      "Location: Leeds",
    ]);
    expect(lines.filter((l) => l.bold)).toHaveLength(1);
  });
});
