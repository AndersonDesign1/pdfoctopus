// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Turns page render requests into ImageBitmaps, through one priority queue on the PDF worker
// and two small memory caches (full pages, thumbnails). Old bitmaps are freed as new ones
// arrive, so memory stays bounded even on a 500-page document.

import type { PdfWorkerClient } from "@pdfoctopus/core";
import { RenderQueue } from "./renderQueue";

export type RenderKind = "page" | "thumb";

/**
 * Memory budgets for cached bitmaps (4 bytes per pixel). A page at normal zoom is a few MB,
 * but at deep zoom one page can reach 64 MB, so limiting by count alone isn't safe.
 */
const CACHE_BYTES: Record<RenderKind, number> = {
  page: 256 * 1024 * 1024,
  thumb: 48 * 1024 * 1024,
};
const PRIORITY: Record<RenderKind, number> = { page: 0, thumb: 1 };

interface CachedBitmap {
  bitmap: ImageBitmap;
  scale: number;
}

const bytesOf = (bitmap: ImageBitmap) => bitmap.width * bitmap.height * 4;

export class BitmapCache {
  /** Insertion order is the LRU order: the first entry is the least recently used. */
  private readonly entries = new Map<string, CachedBitmap>();
  private bytes = 0;

  /** `keep` entries are never evicted, so the pages on screen always stay drawable. */
  constructor(
    private readonly limitBytes: number,
    private readonly keep = 2,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  get(key: string): CachedBitmap | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** The best bitmap for `index` at any scale (closest to `scale`), without marking it used. */
  closest(index: number, scale: number): CachedBitmap | undefined {
    let best: CachedBitmap | undefined;
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${index}@`)) continue;
      if (!best || Math.abs(entry.scale - scale) < Math.abs(best.scale - scale)) best = entry;
    }
    return best;
  }

  set(key: string, entry: CachedBitmap): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.bytes -= bytesOf(existing.bitmap);
      if (existing.bitmap !== entry.bitmap) existing.bitmap.close();
    }
    this.entries.set(key, entry);
    this.bytes += bytesOf(entry.bitmap);
    while (this.bytes > this.limitBytes && this.entries.size > this.keep) {
      const [oldestKey, oldest] = this.entries.entries().next().value as [string, CachedBitmap];
      this.entries.delete(oldestKey);
      this.bytes -= bytesOf(oldest.bitmap);
      oldest.bitmap.close();
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.bitmap.close();
    this.entries.clear();
    this.bytes = 0;
  }
}

export class PageRenderer {
  private readonly queue: RenderQueue<ImageBitmap>;
  private readonly caches: Record<RenderKind, BitmapCache> = {
    page: new BitmapCache(CACHE_BYTES.page),
    thumb: new BitmapCache(CACHE_BYTES.thumb),
  };

  constructor(private readonly client: PdfWorkerClient) {
    this.queue = new RenderQueue(async (index, scale) => {
      const page = await this.client.renderPage(index, scale);
      const image = new ImageData(
        page.pixels as Uint8ClampedArray<ArrayBuffer>,
        page.width,
        page.height,
      );
      return createImageBitmap(image);
    });
  }

  private static key(index: number, scale: number): string {
    return `${index}@${scale}`;
  }

  /** A bitmap at exactly this scale, if one is cached. */
  cached(kind: RenderKind, index: number, scale: number): ImageBitmap | undefined {
    return this.caches[kind].get(PageRenderer.key(index, scale))?.bitmap;
  }

  /** The cached bitmap closest to this scale, to show (stretched) while the exact one renders. */
  placeholder(kind: RenderKind, index: number, scale: number): ImageBitmap | undefined {
    return (
      this.caches[kind].closest(index, scale)?.bitmap ??
      // A thumbnail is better than a blank page while a big render is in progress.
      (kind === "page" ? this.caches.thumb.closest(index, 0)?.bitmap : undefined)
    );
  }

  /** Render (or reuse) the page at this scale. Rejects with RenderCancelledError if dropped. */
  async render(kind: RenderKind, index: number, scale: number): Promise<ImageBitmap> {
    const key = PageRenderer.key(index, scale);
    const hit = this.caches[kind].get(key);
    if (hit) return hit.bitmap;
    const bitmap = await this.queue.request({
      key: `${kind}:${key}`,
      index,
      scale,
      priority: PRIORITY[kind],
    });
    this.caches[kind].set(key, { bitmap, scale });
    return bitmap;
  }

  /** Drop queued renders of this kind for pages outside `keep`. */
  retain(kind: RenderKind, keep: (index: number) => boolean): void {
    this.queue.retain((job) => !job.key.startsWith(`${kind}:`) || keep(job.index));
  }

  /** Forget everything, e.g. when the document changes. */
  dispose(): void {
    this.queue.clear();
    this.caches.page.clear();
    this.caches.thumb.clear();
  }
}
