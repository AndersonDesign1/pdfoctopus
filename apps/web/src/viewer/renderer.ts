// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Turns page render requests into ImageBitmaps, through one priority queue on the PDF worker
// and two small memory caches (full pages, thumbnails). Old bitmaps are freed as new ones
// arrive, so memory stays bounded even on a 500-page document.

import type { PdfWorkerClient } from "@pdfoctopus/core";
import { RenderQueue } from "./renderQueue";

export type RenderKind = "page" | "thumb";

/** Pages rendered for display are a few MB each; thumbnails are tiny. */
const CACHE_LIMIT: Record<RenderKind, number> = { page: 16, thumb: 400 };
const PRIORITY: Record<RenderKind, number> = { page: 0, thumb: 1 };

interface CachedBitmap {
  bitmap: ImageBitmap;
  scale: number;
}

class BitmapCache {
  /** Insertion order is the LRU order: the first entry is the least recently used. */
  private readonly entries = new Map<string, CachedBitmap>();

  constructor(private readonly limit: number) {}

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
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) {
      const [oldestKey, oldest] = this.entries.entries().next().value as [string, CachedBitmap];
      this.entries.delete(oldestKey);
      oldest.bitmap.close();
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.bitmap.close();
    this.entries.clear();
  }
}

export class PageRenderer {
  private readonly queue: RenderQueue<ImageBitmap>;
  private readonly caches: Record<RenderKind, BitmapCache> = {
    page: new BitmapCache(CACHE_LIMIT.page),
    thumb: new BitmapCache(CACHE_LIMIT.thumb),
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
