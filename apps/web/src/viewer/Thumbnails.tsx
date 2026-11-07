// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sidebar of page thumbnails. Virtualised like the main view, and rendered at low priority
// so the pages being read always render first.

import type { PageSize } from "@pdfoctopus/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { computeLayout, renderScale, visibleRange } from "./layout";
import { PageCanvas } from "./PageCanvas";
import type { PageRenderer } from "./renderer";

const THUMB_WIDTH = 112;
const LAYOUT = { gap: 32, padding: 12 };

export interface ThumbnailsProps {
  pages: PageSize[];
  labels: (string | null)[];
  renderer: PageRenderer;
  current: number;
  onSelect(index: number): void;
}

export function Thumbnails({ pages, labels, renderer, current, onSelect }: ThumbnailsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);

  const widest = useMemo(() => Math.max(1, ...pages.map((p) => p.width)), [pages]);
  const scale = THUMB_WIDTH / widest;
  const layout = useMemo(() => computeLayout(pages, scale, LAYOUT), [pages, scale]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setHeight(el.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrollTop(el.scrollTop);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  // Keep the current page's thumbnail in view as the reader scrolls the document.
  useEffect(() => {
    const el = scrollRef.current;
    const top = layout.tops[current];
    const h = layout.heights[current];
    if (!el || top === undefined || h === undefined) return;
    if (top < el.scrollTop || top + h + LAYOUT.gap > el.scrollTop + el.clientHeight) {
      el.scrollTop = top - el.clientHeight / 3;
    }
  }, [current, layout]);

  const range = visibleRange(layout, scrollTop, height);
  const first = Math.max(0, range.first - 2);
  const last = Math.min(pages.length - 1, range.last + 2);

  useEffect(() => {
    renderer.retain("thumb", (i) => i >= first && i <= last);
  }, [renderer, first, last]);

  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const items = [];
  for (let i = first; i <= last; i++) {
    const width = layout.widths[i] as number;
    const h = layout.heights[i] as number;
    const name = labels[i] ?? String(i + 1);
    items.push(
      <button
        key={i}
        type="button"
        className={i === current ? "pdfo-thumb current" : "pdfo-thumb"}
        style={{ top: layout.tops[i], width: width + 8 }}
        onClick={() => onSelect(i)}
        aria-label={`Go to page ${i + 1}`}
        aria-current={i === current ? "page" : undefined}
      >
        <PageCanvas
          renderer={renderer}
          kind="thumb"
          index={i}
          width={width}
          height={h}
          renderScale={renderScale(pages[i] as PageSize, scale, dpr)}
          className="pdfo-thumb-canvas"
          label=""
        />
        <span className="pdfo-thumb-label">{name}</span>
      </button>,
    );
  }

  return (
    <nav ref={scrollRef} className="pdfo-thumbs" aria-label="Pages">
      <div style={{ height: layout.totalHeight, position: "relative" }}>{items}</div>
    </nav>
  );
}
