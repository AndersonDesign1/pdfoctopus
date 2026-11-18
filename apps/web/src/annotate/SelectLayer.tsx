// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drawn over a page while the Select tool is picked: click an annotation to select it, then
// drag it to move it, drag its corner to resize it, or use its buttons (colour, edit text,
// delete). The keyboard works on the selection too. Nothing changes in the file until a
// gesture ends, and each change is one undoable step.

import type { AnnotationChange, AnnotationInfo, PagePoint, RgbColor } from "@pdfoctopus/core";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { TextEditor } from "./AnnotateLayer";
import { arrowDelta, type Box, hitTest, keepsAspect, moveBox, resizeBox, sameBox } from "./edit";
import { clampPoint, cssColor, PALETTE } from "./tools";

export interface SelectLayerProps {
  pageIndex: number;
  page: { width: number; height: number };
  /** CSS pixels per point. */
  scale: number;
  busy: boolean;
  /** True while another page has a draft open: this page then ignores clicks. */
  blocked?: boolean;
  /** The selected annotation's id, if it's on this page. */
  selectedId: number | null;
  /** Reads this page's annotations; called once each time the layer appears. */
  list(): Promise<AnnotationInfo[]>;
  onSelect(annotation: AnnotationInfo | null): void;
  /** The selection as it is now, after a change (moved, recoloured), without announcing it. */
  onRefresh(annotation: AnnotationInfo): void;
  onEdit(annotation: AnnotationInfo, change: AnnotationChange): void;
  onDelete(annotation: AnnotationInfo): void;
  /** Told while text is being edited here (null once done), like AnnotateLayer's drafts. */
  onDraftChange?(page: number | null): void;
}

type Drag = {
  mode: "move" | "resize";
  target: AnnotationInfo;
  pointer: number;
  start: PagePoint;
  /** The box when the drag started, and as it would be now. */
  from: Box;
  box: Box;
};

export function SelectLayer({
  pageIndex,
  page,
  scale,
  busy,
  blocked = false,
  selectedId,
  list,
  onSelect,
  onRefresh,
  onEdit,
  onDelete,
  onDraftChange,
}: SelectLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLButtonElement>(null);
  const [annotations, setAnnotations] = useState<AnnotationInfo[] | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hovering, setHovering] = useState(false);
  const [editingText, setEditingText] = useState(false);

  // Read the page's annotations once. The layer is replaced after every edit, so it's never
  // out of date for long.
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    let live = true;
    listRef
      .current()
      .then((found) => {
        if (live) setAnnotations(found);
      })
      .catch(() => {
        if (live) setAnnotations([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const selected =
    selectedId === null ? null : (annotations?.find((a) => a.id === selectedId) ?? null);

  // The selection is gone from this page (undone, or deleted): let the app know.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  useEffect(() => {
    if (!annotations || selectedId === null) return;
    if (selected) onRefreshRef.current(selected);
    else onSelectRef.current(null);
  }, [annotations, selectedId, selected]);

  // Keyboard focus follows the selection, so Delete and the arrow keys work straight away.
  useEffect(() => {
    if (selected && !editingText) boxRef.current?.focus({ preventScroll: true });
  }, [selected, editingText]);

  useEffect(() => {
    if (!editingText) return;
    onDraftChange?.(pageIndex);
    return () => onDraftChange?.(null);
  }, [editingText, onDraftChange, pageIndex]);

  function point(e: { clientX: number; clientY: number }): PagePoint {
    const box = (layerRef.current as HTMLDivElement).getBoundingClientRect();
    return clampPoint([(e.clientX - box.left) / scale, (e.clientY - box.top) / scale], page);
  }

  function startDrag(e: ReactPointerEvent, target: AnnotationInfo, mode: Drag["mode"]) {
    e.preventDefault();
    e.stopPropagation();
    layerRef.current?.setPointerCapture(e.pointerId);
    setDrag({
      mode,
      target,
      pointer: e.pointerId,
      start: point(e),
      from: target.rect,
      box: target.rect,
    });
  }

  function down(e: ReactPointerEvent) {
    if (e.button !== 0 || busy || blocked || drag || editingText || !annotations) return;
    const hit = hitTest(annotations, point(e));
    onSelect(hit);
    // Press and drag moves straight away, without a separate click to select first.
    if (hit) startDrag(e, hit, "move");
  }

  function move(e: ReactPointerEvent) {
    if (!drag) {
      if (annotations) setHovering(hitTest(annotations, point(e)) !== null);
      return;
    }
    if (e.pointerId !== drag.pointer) return;
    const p = point(e);
    const box =
      drag.mode === "move"
        ? moveBox(drag.from, p[0] - drag.start[0], p[1] - drag.start[1], page)
        : resizeBox(drag.from, p, page, keepsAspect(drag.target));
    setDrag({ ...drag, box });
  }

  function up(e: ReactPointerEvent) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const done = drag;
    setDrag(null);
    if (!sameBox(done.box, done.from)) onEdit(done.target, { rect: done.box });
  }

  function cancel() {
    setDrag(null);
  }

  function key(e: React.KeyboardEvent) {
    if (!selected || e.ctrlKey || e.metaKey || e.altKey) return;
    const step = arrowDelta(e.key, e.shiftKey);
    let handled = true;
    if (step) {
      if (!busy) {
        const box = moveBox(selected.rect, step[0], step[1], page);
        if (!sameBox(box, selected.rect)) onEdit(selected, { rect: box });
      }
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (!busy) onDelete(selected);
    } else if (e.key === "Escape") {
      onSelect(null);
    } else if (e.key === "Enter" && selected.canEditText) {
      // Not while a change is being made: the layer is replaced when it's done.
      if (!busy) setEditingText(true);
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  const s = scale;
  const shown = selected ? (drag ? drag.box : selected.rect) : null;
  // Keep the buttons on screen: above the box when it's near the bottom of the page.
  const nearBottom = shown ? (page.height - shown[3]) * s < 56 : false;
  // And lined up with the box's right edge when it's near the right of the page.
  const nearRight = shown ? (page.width - shown[0]) * s < 280 : false;
  const actionsClass = ["pdfo-selection-actions", nearBottom && "above", nearRight && "right"]
    .filter(Boolean)
    .join(" ");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: double-click is a shortcut; Enter on the focused selection and its Edit text button do the same
    <div
      ref={layerRef}
      className={`pdfo-select-layer${hovering || drag ? " over" : ""}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onPointerLeave={() => setHovering(false)}
      // On the layer: a press on the selection captures the pointer here, so clicks land here.
      onDoubleClick={(e) => {
        if (!selected?.canEditText || busy || blocked) return;
        if (hitTest([selected], point(e)) !== null) setEditingText(true);
      }}
    >
      {selected && shown && (
        <div
          className="pdfo-selection"
          style={{
            left: shown[0] * s,
            top: shown[1] * s,
            width: (shown[2] - shown[0]) * s,
            height: (shown[3] - shown[1]) * s,
          }}
        >
          <button
            type="button"
            ref={boxRef}
            className="pdfo-selection-box"
            aria-label={
              `Selected ${selected.label}. Drag or use the arrow keys to move it, ` +
              `Delete to remove it${selected.canEditText ? ", Enter to edit its text" : ""}, ` +
              "Escape to deselect."
            }
            onPointerDown={(e) => {
              if (e.button !== 0 || busy || blocked || editingText) return;
              startDrag(e, selected, "move");
            }}
            onKeyDown={key}
          >
            {selected.canResize && (
              <span
                className="pdfo-selection-handle"
                aria-hidden="true"
                onPointerDown={(e) => {
                  if (e.button !== 0 || busy || blocked || editingText) return;
                  startDrag(e, selected, "resize");
                }}
              />
            )}
          </button>
          {!drag && !editingText && (
            <div className={actionsClass} onPointerDown={(e) => e.stopPropagation()}>
              {selected.canRecolor && (
                <fieldset className="pdfo-fieldset pdfo-colours">
                  <legend className="visually-hidden">Colour</legend>
                  {PALETTE.map((c) => (
                    <label key={c.label} className="pdfo-colour" title={c.label}>
                      <input
                        type="radio"
                        name={`selection-colour-${pageIndex}`}
                        disabled={busy}
                        checked={sameColor(selected.color, c.value)}
                        onChange={() => onEdit(selected, { color: c.value })}
                      />
                      <span className="pdfo-swatch" style={{ background: cssColor(c.value) }} />
                      <span className="visually-hidden">{c.label}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              {selected.canEditText && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setEditingText(true)}
                >
                  Edit text
                </button>
              )}
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={() => onDelete(selected)}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      )}
      {selected && editingText && (
        <TextEditor
          editor={
            selected.label === "note"
              ? { kind: "note", at: [selected.rect[0], selected.rect[3]] }
              : { kind: "text", rect: selected.rect }
          }
          page={page}
          scale={scale}
          busy={busy}
          initialText={selected.text ?? ""}
          submitLabel="Save"
          onCancel={() => setEditingText(false)}
          onDone={(text) => {
            setEditingText(false);
            if (text !== selected.text) onEdit(selected, { text });
          }}
        />
      )}
    </div>
  );
}

function sameColor(a: RgbColor | null, b: RgbColor): boolean {
  return a?.every((v, i) => Math.abs(v - (b[i] as number)) < 0.01) ?? false;
}
