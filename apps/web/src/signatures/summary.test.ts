// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";
import { bannerFor, type CheckedSignature, coverageOf, statusOf, timestampOf } from "./summary";

function signature(over: Partial<CheckedSignature> = {}): CheckedSignature {
  return {
    field: "Signature1",
    page: 0,
    byteRange: [0, 10, 20, 30],
    contents: new Uint8Array(1),
    problems: [],
    revision: 2,
    revisions: 2,
    coversWholeFile: true,
    changes: "none",
    changeNotes: [],
    signedPages: 1,
    status: "intact",
    check: {
      intact: true,
      problems: [],
      warnings: [],
      chain: [],
      chainLinked: true,
      validAtSigning: true,
      timestamped: false,
      signer: {
        name: "Ada Lovelace",
        subject: "CN=Ada Lovelace",
        issuerName: "Test CA",
        issuer: "CN=Test CA",
        serial: "01",
        notBefore: 0,
        notAfter: 1,
        selfSigned: false,
      },
    },
    ...over,
  };
}

describe("signature summaries", () => {
  test("intact", () => {
    expect(statusOf(signature())).toMatchObject({ tone: "good", title: "Signature intact" });
    expect(bannerFor([signature()])).toEqual({
      tone: "good",
      text: "Signed by Ada Lovelace. Signature intact.",
    });
    expect(coverageOf(signature())).toBe("The whole file, 1 page.");
  });

  test("more signatures added later is still good; other changes aren't", () => {
    const first = signature({ status: "changed", coversWholeFile: false, changes: "signatures" });
    expect(bannerFor([first, signature()])).toEqual({
      tone: "good",
      text: "Signed by Ada Lovelace and 1 other. Signatures intact.",
    });
    expect(coverageOf(first)).toBe(
      "Version 2 of 2 of the file, 1 page. The later versions were added after signing.",
    );
    const changed = signature({ status: "changed", coversWholeFile: false, changes: "other" });
    expect(statusOf(changed)).toMatchObject({ tone: "bad", title: "Changed after signing" });
    expect(bannerFor([changed])?.text).toBe(
      "Signed by Ada Lovelace, but the document was changed after signing.",
    );
    const unknown = signature({ status: "changed", coversWholeFile: false, changes: "unknown" });
    expect(statusOf(unknown).tone).toBe("bad");
  });

  test("comments added later are a warning", () => {
    const s = signature({ status: "changed", coversWholeFile: false, changes: "annotations" });
    expect(bannerFor([s])).toEqual({
      tone: "warn",
      text: "Signed by Ada Lovelace. Signature intact; comments or mark-up were added or changed after it was signed.",
    });
  });

  test("broken, with the reason", () => {
    const s = signature({
      status: "broken",
      check: { ...signature().check, intact: false, problems: ["The document was changed."] },
    });
    expect(statusOf(s)).toEqual({
      tone: "bad",
      title: "Signature broken",
      detail: "The document was changed.",
    });
    expect(bannerFor([signature(), s])?.text).toBe(
      "Signed by Ada Lovelace and 1 other, but Ada Lovelace's signature is broken.",
    );
    expect(coverageOf(s)).toBe("");
  });

  test("signatures past the limit make the check incomplete, never green", () => {
    expect(bannerFor([signature()], 3)).toEqual({
      tone: "warn",
      text: "Signed by Ada Lovelace and 3 others. Check incomplete: 3 signatures weren't checked.",
    });
    expect(bannerFor([signature()], 1)?.text).toContain("1 signature wasn't checked.");
    // A known bad result still wins.
    const changed = signature({ status: "changed", coversWholeFile: false, changes: "other" });
    expect(bannerFor([changed], 3)?.tone).toBe("bad");
  });

  test("no certificate: the name from the signature, or unknown", () => {
    const check = { ...signature().check, signer: undefined };
    expect(bannerFor([signature({ check, name: "Bob" })])?.text).toContain("Signed by Bob.");
    expect(bannerFor([signature({ check })])?.text).toContain("Signed by an unknown signer.");
    expect(bannerFor([])).toBeNull();
  });
});

describe("timestampOf", () => {
  const format = (ms: number) => new Date(ms).toISOString();
  const timestamp = {
    time: Date.UTC(2026, 10, 20, 9),
    authority: "DigiCert Timestamp Responder",
    valid: true,
    trusted: true,
    problems: [],
    chain: [],
  };

  test("a timestamp that checks out, from a known server", () => {
    const s = signature({ check: { ...signature().check, timestamped: true, timestamp } });
    expect(timestampOf(s, format)).toBe(
      "Timestamped by DigiCert Timestamp Responder at 2026-11-20T09:00:00.000Z.",
    );
  });

  test("from an unknown server: present, but not verified", () => {
    const unknown = { ...timestamp, trusted: false };
    const s = signature({ check: { ...signature().check, timestamped: true, timestamp: unknown } });
    expect(timestampOf(s, format)).toBe(
      "A timestamp from DigiCert Timestamp Responder at 2026-11-20T09:00:00.000Z is present, but not verified against a trust list.",
    );
  });

  test("one that doesn't, and none", () => {
    const bad = {
      ...timestamp,
      valid: false,
      trusted: false,
      problems: ["It's for a different signature."],
    };
    const s = signature({ check: { ...signature().check, timestamped: true, timestamp: bad } });
    expect(timestampOf(s, format)).toMatch(/but the timestamp doesn't check out\.$/);
    expect(timestampOf(signature(), format)).toBeUndefined();
  });
});
