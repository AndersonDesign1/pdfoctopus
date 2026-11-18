// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  addSaved,
  type KeyValueStore,
  loadSaved,
  MAX_PER_KIND,
  removeSaved,
  STORAGE_KEY,
} from "./savedSignatures";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

const png = "data:image/png;base64,iVBORw0KGgo=";
const item = (kind: "signature" | "initials" = "signature") => ({
  kind,
  dataUrl: png,
  width: 300,
  height: 100,
});

describe("saved signatures", () => {
  it("starts empty, and lists what was added, newest first", () => {
    const store = memoryStore();
    expect(loadSaved(store)).toEqual([]);
    addSaved(item(), store, 1000);
    addSaved(item("initials"), store, 2000);
    expect(loadSaved(store).map((s) => [s.kind, s.savedAt])).toEqual([
      ["initials", 2000],
      ["signature", 1000],
    ]);
  });

  it("keeps only the newest few of each kind", () => {
    const store = memoryStore();
    for (let i = 0; i < MAX_PER_KIND + 3; i++) addSaved(item(), store, i);
    addSaved(item("initials"), store, 100);
    const list = loadSaved(store);
    expect(list.filter((s) => s.kind === "signature")).toHaveLength(MAX_PER_KIND);
    expect(list.filter((s) => s.kind === "initials")).toHaveLength(1);
    expect(Math.min(...list.map((s) => s.savedAt))).toBe(3);
  });

  it("removes one", () => {
    const store = memoryStore();
    addSaved(item(), store, 1);
    const [kept] = addSaved(item(), store, 2) ?? [];
    const list = removeSaved(kept?.id ?? "", store);
    expect(list.map((s) => s.savedAt)).toEqual([1]);
  });

  it("forgets the oldest ones when storage is full, to make room for the new one", () => {
    const store = memoryStore();
    for (let i = 0; i < 4; i++) addSaved(item(), store, i);
    // Storage that only fits three entries from now on.
    const limited: KeyValueStore = {
      getItem: store.getItem,
      setItem: (k, v) => {
        if ((JSON.parse(v) as unknown[]).length > 3) throw new Error("QuotaExceededError");
        store.setItem(k, v);
      },
    };
    const list = addSaved(item("initials"), limited, 10);
    expect(list?.map((s) => s.savedAt)).toEqual([10, 3, 2]);
    expect(loadSaved(store).map((s) => s.savedAt)).toEqual([10, 3, 2]);
  });

  it("copes with no storage, full storage and damaged data", () => {
    expect(loadSaved(null)).toEqual([]);
    expect(addSaved(item(), null)).toBeNull();
    const full: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(addSaved(item(), full)).toBeNull();
    const store = memoryStore();
    store.data.set(STORAGE_KEY, "{not json");
    expect(loadSaved(store)).toEqual([]);
    store.data.set(STORAGE_KEY, JSON.stringify([{ id: 1 }, { ...item(), id: "a", savedAt: 5 }]));
    expect(loadSaved(store).map((s) => s.id)).toEqual(["a"]);
    // Something that isn't a PNG data URL (say, a script URL) is never loaded.
    store.data.set(
      STORAGE_KEY,
      JSON.stringify([{ ...item(), dataUrl: "javascript:alert(1)", id: "x", savedAt: 1 }]),
    );
    expect(loadSaved(store)).toEqual([]);
    // A damaged payload, or one that isn't really a PNG, is ignored rather than offered.
    for (const dataUrl of ["data:image/png;base64,%%%", "data:image/png;base64,R0lGODlh"]) {
      store.data.set(STORAGE_KEY, JSON.stringify([{ ...item(), dataUrl, id: "x", savedAt: 1 }]));
      expect(loadSaved(store)).toEqual([]);
    }
  });
});
