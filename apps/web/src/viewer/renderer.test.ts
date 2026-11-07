// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { BitmapCache } from "./renderer";

/** Enough of an ImageBitmap for the cache: a size and a close() we can observe. */
function fakeBitmap(width: number, height: number) {
  return {
    width,
    height,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}
type Fake = ReturnType<typeof fakeBitmap>;
const asBitmap = (f: Fake) => f as unknown as ImageBitmap;

describe("BitmapCache", () => {
  it("evicts by memory, least recently used first, and frees evicted bitmaps", () => {
    const mb = 1024 * 1024;
    const cache = new BitmapCache(10 * mb, 1);
    // Each bitmap is 1024 x 1024 x 4 bytes = 4 MB.
    const a = fakeBitmap(1024, 1024);
    const b = fakeBitmap(1024, 1024);
    const c = fakeBitmap(1024, 1024);
    cache.set("0@1", { bitmap: asBitmap(a), scale: 1 });
    cache.set("1@1", { bitmap: asBitmap(b), scale: 1 });
    cache.get("0@1"); // a is now the most recently used
    cache.set("2@1", { bitmap: asBitmap(c), scale: 1 });
    expect(cache.totalBytes).toBe(8 * mb);
    expect(b.closed).toBe(true);
    expect(a.closed).toBe(false);
    expect(cache.get("1@1")).toBeUndefined();
  });

  it("always keeps the newest entries, even over budget", () => {
    const cache = new BitmapCache(1, 2);
    const a = fakeBitmap(100, 100);
    const b = fakeBitmap(100, 100);
    cache.set("0@1", { bitmap: asBitmap(a), scale: 1 });
    cache.set("1@1", { bitmap: asBitmap(b), scale: 1 });
    expect(cache.size).toBe(2);
    expect(a.closed || b.closed).toBe(false);
  });

  it("finds the closest scale for a placeholder", () => {
    const cache = new BitmapCache(1024 * 1024 * 1024);
    cache.set("3@1", { bitmap: asBitmap(fakeBitmap(10, 10)), scale: 1 });
    cache.set("3@2", { bitmap: asBitmap(fakeBitmap(20, 20)), scale: 2 });
    cache.set("30@1.6", { bitmap: asBitmap(fakeBitmap(16, 16)), scale: 1.6 });
    expect(cache.closest(3, 1.7)?.scale).toBe(2);
    expect(cache.closest(3, 0.5)?.scale).toBe(1);
    expect(cache.closest(4, 1)).toBeUndefined();
  });
});
