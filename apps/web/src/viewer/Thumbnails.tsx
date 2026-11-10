// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sidebar of page thumbnails. Virtualised like the main view, and rendered at low priority
// so the pages being read always render first.
//
// It's also where pages are selected for the page tools (click, Ctrl/Cmd-click, Shift-click)
// and reordered by dragging.

import type { PageSize } from "@pdfoctopus/core";
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { computeLayout, renderScale, visibleRange } from "./layout";
import { PageCanvas } from "./PageCanvas";
import type { PageRenderer } from "./renderer";
import { dropIndexAt } from "./selection";

const THUMB_WIDTH = 112;
const LAYOUT = { gap: 32, padding: 12 };
/** Marks a drag as pages from this sidebar, so it isn't mistaken for a file being opened. */
const DRAG_TYPE = "application/x-pdfoctopus-pages";
/** How close to the edge (px) a drag starts scrolling the sidebar. */
const EDGE = 40;

export interface ThumbnailsProps {
  pages: PageSize[];
  labels: (string | null)[];
  renderer: PageRenderer;
  current: number;
  /** Selected pages, sorted. */
  selected: readonly number[];
  /** A thumbnail was clicked; the modifier keys decide how the selection changes. */
  onClickPage(index: number, modifiers: { toggle: boolean; range: boolean }): void;
  /** Pages were dragged and dropped in front of page `dropBefore` (pageCount: at the end). */
  onMovePages?(pages: number[], dropBefore: number): void;
  /** Keys pressed while the sidebar has focus (Delete, Ctrl+A). */
  onKeyDown?(event: KeyboardEvent<HTMLElement>): void;
}

export function Thumbnails({
  pages,
  labels,
  renderer,
  current,
  selected,
  onClickPage,
  onMovePages,
  onKeyDown,
}: ThumbnailsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  /** Pages being dragged, and the gap they'd be dropped into. */
  const dragPages = useRef<number[] | null>(null);
  const [dropBefore, setDropBefore] = useState<number | null>(null);

  // reduce, not Math.max(...spread): spreading tens of thousands of pages can overflow the stack.
  const widest = useMemo(() => pages.reduce((w, p) => Math.max(w, p.width), 1), [pages]);
  const scale = THUMB_WIDTH / widest;
  const layout = useMemo(() => computeLayout(pages, scale, LAYOUT), [pages, scale]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

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

  // Hidden (e.g. on narrow screens) means zero height: render nothing.
  const range = height > 0 ? visibleRange(layout, scrollTop, height) : { first: 0, last: -1 };
  const first = Math.max(0, range.first - 2);
  const last = Math.min(pages.length - 1, range.last + 2);

  useEffect(() => {
    renderer.retain("thumb", (i) => i >= first && i <= last);
  }, [renderer, first, last]);

  // When the sidebar is closed, drop any thumbnails still waiting to render.
  useEffect(() => () => renderer.retain("thumb", () => false), [renderer]);

  // ---- Dragging pages ----

  const isPageDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(DRAG_TYPE);

  function onDragStart(e: DragEvent<HTMLButtonElement>, index: number) {
    if (!onMovePages) return;
    // Drag the whole selection when the page is part of it, otherwise just this page.
    const moving = selectedSet.has(index) ? [...selected] : [index];
    dragPages.current = moving;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(DRAG_TYPE, moving.join(","));
    e.dataTransfer.setData("text/plain", "");
  }

  function onDragOver(e: DragEvent<HTMLElement>) {
    if (!dragPages.current || !isPageDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Scroll while hovering near the top or bottom edge.
    if (e.clientY < rect.top + EDGE) el.scrollTop -= 12;
    else if (e.clientY > rect.bottom - EDGE) el.scrollTop += 12;
    const y = e.clientY - rect.top + el.scrollTop;
    const index = dropIndexAt(y, layout.tops, layout.heights);
    if (index !== dropBefore) setDropBefore(index);
  }

  function endDrag() {
    dragPages.current = null;
    setDropBefore(null);
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    const moving = dragPages.current;
    if (!moving || !isPageDrag(e)) return;
    e.preventDefault();
    const target = dropBefore;
    endDrag();
    if (target !== null) onMovePages?.(moving, target);
  }

  function onClick(e: MouseEvent<HTMLButtonElement>, index: number) {
    onClickPage(index, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
  }

  // Where the drop marker goes: in the gap above page `dropBefore`.
  let markerTop: number | null = null;
  if (dropBefore !== null) {
    markerTop =
      dropBefore < pages.length
        ? Math.max(0, (layout.tops[dropBefore] as number) - LAYOUT.gap / 2)
        : layout.totalHeight - LAYOUT.padding / 2;
  }

  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const items = [];
  for (let i = first; i <= last; i++) {
    const width = layout.widths[i] as number;
    const h = layout.heights[i] as number;
    const name = labels[i] ?? String(i + 1);
    const isSelected = selectedSet.has(i);
    const classes = ["pdfo-thumb"];
    if (i === current) classes.push("current");
    if (isSelected) classes.push("selected");
    items.push(
      <button
        key={i}
        type="button"
        className={classes.join(" ")}
        style={{ top: layout.tops[i], width: width + 8 }}
        draggable={!!onMovePages}
        onDragStart={(e) => onDragStart(e, i)}
        onDragEnd={endDrag}
        onClick={(e) => onClick(e, i)}
        aria-label={labels[i] ? `Page ${i + 1} (${labels[i]})` : `Page ${i + 1}`}
        aria-current={i === current ? "page" : undefined}
        aria-pressed={isSelected}
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
    <nav
      ref={scrollRef}
      className="pdfo-thumbs"
      aria-label="Pages"
      aria-describedby="pdfo-thumbs-help"
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        // Only when leaving the sidebar itself, not when moving between thumbnails.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropBefore(null);
      }}
      onDrop={onDrop}
      onKeyDown={onKeyDown}
    >
      <p id="pdfo-thumbs-help" className="visually-hidden">
        Click a page to select it. Hold Ctrl or Shift to select more. Drag to reorder. Delete
        removes the selected pages.
      </p>
      <div style={{ height: layout.totalHeight, position: "relative" }}>
        {items}
        {markerTop !== null && (
          <div className="pdfo-drop-marker" style={{ top: markerTop }} aria-hidden="true" />
        )}
      </div>
    </nav>
  );
}
