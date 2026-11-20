// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";
import { savedServer, saveServer, serverName, timestampsAvailable } from "./timestamp";

function memory() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
}

describe("the timestamp server choice", () => {
  test("is DigiCert until another is chosen, then remembered", () => {
    const store = memory();
    expect(savedServer(store)).toBe("digicert");
    saveServer("sectigo", store);
    expect(savedServer(store)).toBe("sectigo");
  });

  test("ignores anything else stored, and storage that throws", () => {
    const store = memory();
    store.setItem("pdfoctopus.timestampServer", "https://example.com");
    expect(savedServer(store)).toBe("digicert");
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(savedServer(broken)).toBe("digicert");
    expect(() => saveServer("sectigo", broken)).not.toThrow();
    expect(savedServer(null)).toBe("digicert");
  });

  test("names for messages", () => {
    expect(serverName("digicert")).toBe("DigiCert's timestamp server");
    expect(serverName("sectigo")).toBe("Sectigo's timestamp server");
  });

  test("timestamps are only offered in the desktop app", () => {
    expect(timestampsAvailable()).toBe(false);
  });
});
