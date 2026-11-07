// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The main page view: every page stacked in one scrolling column, but only the pages on
// screen (plus one either side) exist in the DOM and get rendered. Zooming keeps the point
// under the pointer (or the middle of the view) in place.

import type { PageSize, SearchHit } from "@pdfoctopus/core";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type Anchor,
  anchorAt,
  clampScale,
  computeLayout,
  currentPage,
  DEFAULT_LAYOUT,
  fitScale,
  type Layout,
  renderScale,
  type Size,
  scrollForAnchor,
  visibleRange,
  type ZoomMode,
} from "./layout";
import { PageCanvas } from "./PageCanvas";
import type { PageRenderer } from "./renderer";

export interface Zoom {
  mode: ZoomMode;
  /** CSS pixels per PDF point; used when mode is "custom". */
  scale: number;
}

export interface ViewerHandle {
  scrollToPage(index: number): void;
  scrollToHit(hit: SearchHit): void;
  /** True when the pages are wider than the view (so arrow keys should scroll sideways). */
  canScrollHorizontally(): boolean;
}

export interface ViewerProps {
  pages: PageSize[];
  labels: (string | null)[];
  renderer: PageRenderer;
  zoom: Zoom;
  /** Pinch and Ctrl+wheel zoom: always reported as a custom scale. */
  onZoomChange(zoom: Zoom): void;
  /** The scale actually in use (fit modes depend on the window size). */
  onScaleChange(scale: number): void;
  onCurrentPageChange(index: number): void;
  hits: SearchHit[];
  currentHit: number;
}

/** Render resolution waits until zooming pauses, so a pinch doesn't queue dozens of renders. */
const SETTLE_MS = 150;

function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

function quadBox(quad: number[], scale: number) {
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
  const left = Math.min(...xs) * scale;
  const top = Math.min(...ys) * scale;
  return {
    left,
    top,
    width: Math.max(...xs) * scale - left,
    height: Math.max(...ys) * scale - top,
  };
}

export const Viewer = forwardRef<ViewerHandle, ViewerProps>(function Viewer(
  {
    pages,
    labels,
    renderer,
    zoom,
    onZoomChange,
    onScaleChange,
    onCurrentPageChange,
    hits,
    currentHit,
  },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });

  // Track the viewport size.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit modes use the largest width and height of any page, so every page fits and the
  // zoom doesn't jump while scrolling through pages of different sizes.
  const largestPage = useMemo(
    () =>
      pages.reduce<Size>(
        (big, p) => ({
          width: Math.max(big.width, p.width),
          height: Math.max(big.height, p.height),
        }),
        { width: 1, height: 1 },
      ),
    [pages],
  );

  const scale = useMemo(() => {
    if (viewport.width === 0 || zoom.mode === "custom") return clampScale(zoom.scale);
    return fitScale(zoom.mode, largestPage, viewport);
  }, [zoom, viewport, largestPage]);

  useEffect(() => onScaleChange(scale), [scale, onScaleChange]);

  const layout = useMemo(() => computeLayout(pages, scale), [pages, scale]);
  // Before the viewport is measured, fit modes can't be computed yet. The first real scale
  // is not a zoom by the user, so the view should stay at the top instead of re-anchoring.
  const measuredRef = useRef(false);
  const layoutRef = useRef<Layout>(layout);
  const anchorRef = useRef<Anchor | null>(null);
  // The scroll position as of the last scroll event. When zooming out, React shrinks the
  // column before our layout effect runs and the browser clamps scrollTop, so the effect
  // must anchor from this value, not from the (possibly clamped) live one.
  const lastScrollRef = useRef({ top: 0, left: 0 });

  /** Remember which point of which page is at (viewportX, viewportY) in the old layout. */
  const recordAnchor = useCallback((viewportX: number, viewportY: number) => {
    const el = scrollRef.current;
    if (!el) return;
    anchorRef.current = anchorAt(
      layoutRef.current,
      { top: el.scrollTop, left: el.scrollLeft },
      el.clientWidth,
      viewportX,
      viewportY,
    );
  }, []);

  // When the scale changes, scroll so the anchored point stays where it was on screen.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const previous = layoutRef.current;
    layoutRef.current = layout;
    const wasMeasured = measuredRef.current;
    measuredRef.current = viewport.width > 0;
    if (!el || previous.scale === layout.scale || layout.tops.length === 0) return;
    if (!wasMeasured) {
      anchorRef.current = null;
      return;
    }
    // Toolbar and fit-mode zooms anchor at the middle of the view. Use the last scroll
    // position seen, since the browser may already have clamped the live one.
    const a =
      anchorRef.current ??
      anchorAt(
        previous,
        lastScrollRef.current,
        el.clientWidth,
        el.clientWidth / 2,
        el.clientHeight / 2,
      );
    anchorRef.current = null;
    if (!a) return;
    const target = scrollForAnchor(layout, a, el.clientWidth);
    el.scrollTop = target.top;
    el.scrollLeft = target.left;
    lastScrollRef.current = { top: el.scrollTop, left: el.scrollLeft };
    setScroll(lastScrollRef.current);
  }, [layout, viewport.width]);

  // Follow scrolling (once per frame).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      lastScrollRef.current = { top: el.scrollTop, left: el.scrollLeft };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScroll({ top: el.scrollTop, left: el.scrollLeft });
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  // The current page, reported to the toolbar.
  useEffect(() => {
    if (layout.tops.length === 0 || viewport.height === 0) return;
    onCurrentPageChange(currentPage(layout, scroll.top, viewport.height));
  }, [layout, scroll.top, viewport.height, onCurrentPageChange]);

  // Ctrl/Cmd + wheel (and trackpad pinch, which browsers report the same way) zooms at the pointer.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const rect = el.getBoundingClientRect();
      recordAnchor(event.clientX - rect.left, event.clientY - rect.top);
      onZoomChange({
        mode: "custom",
        scale: clampScale(scaleRef.current * Math.exp(-delta * 0.002)),
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onZoomChange, recordAnchor]);

  // Two-finger pinch on touch screens.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const touches = new Map<number, { x: number; y: number }>();
    let start: { distance: number; scale: number } | null = null;
    const distance = () => {
      const [a, b] = [...touches.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) start = { distance: distance(), scale: scaleRef.current };
    };
    const move = (e: PointerEvent) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!start || touches.size !== 2 || start.distance === 0) return;
      const [a, b] = [...touches.values()];
      if (!a || !b) return;
      const rect = el.getBoundingClientRect();
      recordAnchor((a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
      onZoomChange({
        mode: "custom",
        scale: clampScale((start.scale * distance()) / start.distance),
      });
    };
    const up = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) start = null;
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, [onZoomChange, recordAnchor]);

  useImperativeHandle(
    ref,
    () => ({
      canScrollHorizontally() {
        const el = scrollRef.current;
        return !!el && el.scrollWidth > el.clientWidth + 1;
      },
      scrollToPage(index: number) {
        const el = scrollRef.current;
        const top = layoutRef.current.tops[index];
        if (el && top !== undefined) el.scrollTop = top - DEFAULT_LAYOUT.padding;
      },
      scrollToHit(hit: SearchHit) {
        const el = scrollRef.current;
        const l = layoutRef.current;
        const top = l.tops[hit.page];
        const quad = hit.quads[0];
        if (!el || top === undefined || !quad) return;
        const box = quadBox(quad, l.scale);
        const y = top + box.top;
        // Only scroll if the hit isn't comfortably on screen already.
        if (y < el.scrollTop + 40 || y + box.height > el.scrollTop + el.clientHeight - 40) {
          el.scrollTop = y - el.clientHeight / 3;
        }
        const contentWidth = Math.max(l.totalWidth, el.clientWidth);
        const left = (contentWidth - (l.widths[hit.page] as number)) / 2 + box.left;
        if (left < el.scrollLeft || left + box.width > el.scrollLeft + el.clientWidth) {
          el.scrollLeft = left - el.clientWidth / 3;
        }
      },
    }),
    [],
  );

  const range = visibleRange(layout, scroll.top, viewport.height);
  const first = Math.max(0, range.first - 1);
  const last = Math.min(pages.length - 1, range.last + 1);

  // Cancel queued renders for pages that scrolled away.
  useEffect(() => {
    renderer.retain("page", (i) => i >= first - 1 && i <= last + 1);
  }, [renderer, first, last]);

  const settledScale = useSettled(scale, SETTLE_MS);
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  const hitsByPage = useMemo(() => {
    const map = new Map<number, { hit: SearchHit; index: number }[]>();
    hits.forEach((hit, index) => {
      const list = map.get(hit.page) ?? [];
      list.push({ hit, index });
      map.set(hit.page, list);
    });
    return map;
  }, [hits]);

  const contentWidth = Math.max(layout.totalWidth, viewport.width);
  const pageViews = [];
  for (let i = first; i <= last; i++) {
    const width = layout.widths[i] as number;
    const height = layout.heights[i] as number;
    const page = pages[i] as PageSize;
    const label = labels[i] ? `Page ${i + 1} (${labels[i]})` : `Page ${i + 1}`;
    pageViews.push(
      <div
        key={i}
        className="pdfo-page"
        style={{ top: layout.tops[i], left: (contentWidth - width) / 2, width, height }}
      >
        <PageCanvas
          renderer={renderer}
          kind="page"
          index={i}
          width={width}
          height={height}
          renderScale={renderScale(page, settledScale, dpr)}
          label={label}
        />
        {hitsByPage.get(i)?.map(({ hit, index }) =>
          hit.quads.map((quad, q) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: quads have no identity of their own
              key={`${index}-${q}`}
              className={index === currentHit ? "pdfo-hit current" : "pdfo-hit"}
              style={quadBox(quad, scale)}
            />
          )),
        )}
      </div>,
    );
  }

  return (
    <div ref={scrollRef} className="pdfo-scroller" tabIndex={-1}>
      <div className="pdfo-column" style={{ height: layout.totalHeight, width: contentWidth }}>
        {pageViews}
      </div>
    </div>
  );
});
