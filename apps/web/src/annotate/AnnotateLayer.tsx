// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drawn over a page while an annotation tool is picked: it turns a drag (or click) into an
// annotation, showing a preview as you go. Notes and text boxes open a small editor first.

import type { AnnotationSpec, PagePoint, RgbColor } from "@pdfoctopus/core";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  clampPoint,
  cssColor,
  defaultTextRect,
  dragRect,
  isClick,
  TEXT_SIZE,
  type Tool,
  thinStroke,
} from "./tools";

export interface AnnotateLayerProps {
  pageIndex: number;
  page: { width: number; height: number };
  /** CSS pixels per point. */
  scale: number;
  tool: Tool;
  color: RgbColor;
  width: number;
  busy: boolean;
  /** The text a drag from `from` to `to` would mark, as quads in page points. */
  selectText(from: PagePoint, to: PagePoint): Promise<number[][]>;
  onCommit(spec: AnnotationSpec): void;
  /**
   * Told which page has a note or text box being typed (or null once it's added or
   * cancelled), so other edits wait for it and its page stays loaded.
   */
  onDraftChange?(page: number | null): void;
  /** True while another page has a draft open: this page then ignores new drawing. */
  blocked?: boolean;
}

type Drag = { start: PagePoint; current: PagePoint; points: PagePoint[]; pointer: number };

export type Editor =
  | { kind: "note"; at: PagePoint }
  | { kind: "text"; rect: [number, number, number, number] };

export function AnnotateLayer({
  pageIndex,
  page,
  scale,
  tool,
  color,
  width,
  busy,
  selectText,
  onCommit,
  onDraftChange,
  blocked = false,
}: AnnotateLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [quads, setQuads] = useState<number[][]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  // Each page has its own layer, so the arrowhead needs an id of its own.
  const markerId = `pdfo-arrow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  /** Bumped whenever a gesture starts or ends, so replies for an older one are ignored. */
  const gesture = useRef(0);

  // A different tool starts afresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the tool changes
  useEffect(() => {
    gesture.current++;
    setDrag(null);
    setQuads([]);
    setEditor(null);
  }, [tool.id]);

  // Let the app know while a note or text box is being typed here. Only the layer with an open
  // editor reports, so another page's layer appearing doesn't clear it.
  const draftOpen = editor !== null;
  useEffect(() => {
    if (!draftOpen) return;
    onDraftChange?.(pageIndex);
    return () => onDraftChange?.(null);
  }, [draftOpen, onDraftChange, pageIndex]);

  // Text selection preview: one request at a time, always for the latest drag. A reply that
  // comes back after its drag has ended is dropped, so no stale selection stays on the page.
  const want = useRef<{ from: PagePoint; to: PagePoint; gesture: number } | null>(null);
  const asking = useRef(false);
  function previewText(from: PagePoint, to: PagePoint) {
    want.current = { from, to, gesture: gesture.current };
    if (asking.current) return;
    asking.current = true;
    const ask = async () => {
      while (want.current) {
        const next = want.current;
        want.current = null;
        let quads: number[][] = [];
        try {
          quads = await selectText(next.from, next.to);
        } catch {
          // No preview this time; the drag still works.
        }
        if (next.gesture === gesture.current) setQuads(quads);
      }
      asking.current = false;
    };
    void ask();
  }

  function point(e: ReactPointerEvent): PagePoint {
    const box = (layerRef.current as HTMLDivElement).getBoundingClientRect();
    return clampPoint([(e.clientX - box.left) / scale, (e.clientY - box.top) / scale], page);
  }

  function down(e: ReactPointerEvent) {
    if (e.button !== 0 || busy || blocked || drag || editor) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    gesture.current++;
    setDrag({ start: p, current: p, points: [p], pointer: e.pointerId });
    setQuads([]);
  }

  function move(e: ReactPointerEvent) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const events = tool.gesture === "ink" ? (e.nativeEvent.getCoalescedEvents?.() ?? []) : [];
    const added = events.length
      ? events.map((ev) => {
          const box = (layerRef.current as HTMLDivElement).getBoundingClientRect();
          return clampPoint(
            [(ev.clientX - box.left) / scale, (ev.clientY - box.top) / scale],
            page,
          );
        })
      : [point(e)];
    const current = added[added.length - 1] as PagePoint;
    setDrag({
      ...drag,
      current,
      points: tool.gesture === "ink" ? [...drag.points, ...added] : drag.points,
    });
    if (tool.gesture === "text") previewText(drag.start, current);
  }

  function up(e: ReactPointerEvent) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const end = point(e);
    const { start } = drag;
    const click = isClick(start, end);
    gesture.current++;
    setDrag(null);
    want.current = null;
    setQuads([]);
    const base = { page: pageIndex };
    switch (tool.gesture) {
      case "text":
        if (!click) {
          const kind = tool.id as "highlight" | "underline" | "strikeout";
          onCommit({ ...base, kind, from: start, to: end, color });
        }
        break;
      case "ink":
        onCommit({
          ...base,
          kind: "ink",
          strokes: [thinStroke([...drag.points, end])],
          color,
          width,
        });
        break;
      case "line":
        if (!click) {
          onCommit({
            ...base,
            kind: tool.id as "line" | "arrow",
            from: start,
            to: end,
            color,
            width,
          });
        }
        break;
      case "box":
        if (tool.id === "text") {
          setEditor({
            kind: "text",
            rect: click ? defaultTextRect(start, page) : dragRect(start, end, page),
          });
        } else if (!click) {
          const rect = dragRect(start, end, page);
          if (tool.id === "whiteout") onCommit({ ...base, kind: "whiteout", rect });
          else onCommit({ ...base, kind: tool.id as "rectangle" | "ellipse", rect, color, width });
        }
        break;
      case "point":
        // A note goes where you click; a drag isn't a click.
        if (click) setEditor({ kind: "note", at: start });
        break;
    }
  }

  function cancel(e: ReactPointerEvent) {
    if (drag && e.pointerId === drag.pointer) {
      gesture.current++;
      setDrag(null);
      setQuads([]);
    }
  }

  const s = scale;
  const stroke = cssColor(color);
  const strokeWidth = Math.max(1, width * s);
  let preview: ReactNode = null;
  if (drag) {
    const [x0, y0, x1, y1] = dragRect(drag.start, drag.current, page);
    if (tool.gesture === "box") {
      preview =
        tool.id === "ellipse" ? (
          <ellipse
            cx={((x0 + x1) / 2) * s}
            cy={((y0 + y1) / 2) * s}
            rx={((x1 - x0) / 2) * s}
            ry={((y1 - y0) / 2) * s}
            fill="none"
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
        ) : (
          <rect
            x={x0 * s}
            y={y0 * s}
            width={(x1 - x0) * s}
            height={(y1 - y0) * s}
            fill={tool.id === "whiteout" ? "#ffffff" : "none"}
            stroke={tool.id === "rectangle" ? stroke : "#8a8fa3"}
            strokeDasharray={tool.id === "rectangle" ? undefined : "4 3"}
            strokeWidth={tool.id === "rectangle" ? strokeWidth : 1}
          />
        );
    } else if (tool.gesture === "line") {
      preview = (
        <line
          x1={drag.start[0] * s}
          y1={drag.start[1] * s}
          x2={drag.current[0] * s}
          y2={drag.current[1] * s}
          stroke={stroke}
          strokeWidth={strokeWidth}
          markerEnd={tool.id === "arrow" ? `url(#${markerId})` : undefined}
        />
      );
    } else if (tool.gesture === "ink") {
      preview = (
        <polyline
          points={drag.points.map(([x, y]) => `${x * s},${y * s}`).join(" ")}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    }
  }

  return (
    <div
      ref={layerRef}
      className={`pdfo-annotate-layer gesture-${tool.gesture}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
    >
      <svg className="pdfo-annotate-preview" aria-hidden="true">
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill={stroke} />
          </marker>
        </defs>
        {quads.map((q, i) => (
          <polygon
            // biome-ignore lint/suspicious/noArrayIndexKey: quads have no identity of their own
            key={i}
            points={`${(q[0] ?? 0) * s},${(q[1] ?? 0) * s} ${(q[2] ?? 0) * s},${(q[3] ?? 0) * s} ${(q[6] ?? 0) * s},${(q[7] ?? 0) * s} ${(q[4] ?? 0) * s},${(q[5] ?? 0) * s}`}
            fill={stroke}
            fillOpacity={tool.id === "highlight" ? 0.35 : 0.15}
          />
        ))}
        {preview}
      </svg>
      {editor && (
        <TextEditor
          editor={editor}
          page={page}
          scale={scale}
          busy={busy}
          onCancel={() => setEditor(null)}
          onDone={(text) => {
            setEditor(null);
            if (editor.kind === "note") {
              onCommit({ page: pageIndex, kind: "note", at: editor.at, text, color });
            } else {
              onCommit({
                page: pageIndex,
                kind: "text",
                rect: editor.rect,
                text,
                color,
                size: TEXT_SIZE,
              });
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Where a note's or text box's text is typed. Ctrl/Cmd+Enter adds it (or saves the change, when
 * editing text that's already there), Escape cancels.
 */
export function TextEditor({
  editor,
  page,
  scale,
  busy,
  onCancel,
  onDone,
  initialText = "",
  submitLabel = "Add",
}: {
  editor: Editor;
  page: { width: number; height: number };
  scale: number;
  busy: boolean;
  onCancel(): void;
  onDone(text: string): void;
  initialText?: string;
  submitLabel?: string;
}) {
  const [text, setText] = useState(initialText);
  const id = useId();
  // Keep the editor on the page: near the right edge it moves left, and near the bottom it
  // opens above the spot instead of below.
  const pageWidth = page.width * scale;
  const pageHeight = page.height * scale;
  const width = Math.min(
    pageWidth,
    editor.kind === "text" ? Math.max(200, (editor.rect[2] - editor.rect[0]) * scale) : 260,
  );
  const x = (editor.kind === "text" ? editor.rect[0] : editor.at[0]) * scale;
  const y = (editor.kind === "text" ? editor.rect[1] : editor.at[1]) * scale;
  const below = y + (editor.kind === "note" ? 8 : 0);
  const approxHeight = 150;
  const style = {
    left: Math.max(0, Math.min(x, pageWidth - width)),
    top: below + approxHeight > pageHeight ? Math.max(0, y - approxHeight) : below,
    width,
  };
  return (
    <div
      className="pdfo-annotate-editor"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <label className="visually-hidden" htmlFor={id}>
        {editor.kind === "note" ? "Note text" : "Text box text"}
      </label>
      <textarea
        id={id}
        // biome-ignore lint/a11y/noAutofocus: the user just asked to type here
        autoFocus
        rows={editor.kind === "note" ? 4 : 2}
        value={text}
        placeholder={editor.kind === "note" ? "Write a note…" : "Type the text…"}
        style={editor.kind === "text" ? { fontSize: TEXT_SIZE * scale } : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            // Like the Add button: wait while something else is being done.
            if (text.trim() && !busy) onDone(text);
          }
        }}
      />
      <div className="pdfo-annotate-editor-actions">
        <span className="pdfo-hint">Ctrl+Enter to {submitLabel.toLowerCase()}</span>
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || !text.trim()}
          onClick={() => onDone(text)}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
