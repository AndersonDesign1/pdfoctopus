// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layers drawn over a page while building a form. FieldDrawLayer: drag a box where a new field
// goes (or click, for a box of the usual size). FieldEditLayer: every field outlined, to click
// one and change its properties.

import type { FormField, NewFieldKind, PageSize } from "@pdfoctopus/core";
import { useEffect, useRef, useState } from "react";
import { FIELD_KIND_NAMES } from "./FieldDialog";

type Rect = [number, number, number, number];

/** The box a click (rather than a drag) gives each kind of field, in points. */
const DEFAULT_SIZE: Record<NewFieldKind, [number, number]> = {
  text: [180, 22],
  checkbox: [14, 14],
  radio: [14, 14],
  combobox: [150, 22],
  date: [100, 22],
  signature: [200, 50],
};

/** A drag shorter than this (in points) counts as a click. */
const CLICK = 4;

export function FieldDrawLayer({
  kind,
  page,
  scale,
  busy,
  onDraw,
}: {
  kind: NewFieldKind;
  page: PageSize;
  /** CSS pixels per point. */
  scale: number;
  busy: boolean;
  onDraw(rect: Rect): void;
}) {
  const [start, setStart] = useState<[number, number] | null>(null);
  const [end, setEnd] = useState<[number, number] | null>(null);
  const layer = useRef<HTMLDivElement>(null);

  const point = (e: React.PointerEvent): [number, number] => {
    const box = layer.current?.getBoundingClientRect();
    if (!box) return [0, 0];
    const x = Math.min(Math.max((e.clientX - box.left) / scale, 0), page.width);
    const y = Math.min(Math.max((e.clientY - box.top) / scale, 0), page.height);
    return [x, y];
  };

  const finish = (a: [number, number], b: [number, number]) => {
    let rect: Rect;
    if (Math.abs(b[0] - a[0]) < CLICK && Math.abs(b[1] - a[1]) < CLICK) {
      // No bigger than the page (a small label, a ticket).
      const w = Math.min(DEFAULT_SIZE[kind][0], page.width);
      const h = Math.min(DEFAULT_SIZE[kind][1], page.height);
      // The click is the box's top-left corner, kept on the page.
      const x = Math.min(a[0], page.width - w);
      const y = Math.min(a[1], page.height - h);
      rect = [Math.max(0, x), Math.max(0, y), Math.max(0, x) + w, Math.max(0, y) + h];
    } else {
      rect = [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
      ];
    }
    onDraw(rect);
  };

  const preview =
    start && end
      ? {
          left: Math.min(start[0], end[0]) * scale,
          top: Math.min(start[1], end[1]) * scale,
          width: Math.abs(end[0] - start[0]) * scale,
          height: Math.abs(end[1] - start[1]) * scale,
        }
      : null;

  return (
    <div
      ref={layer}
      className="pdfo-field-draw-layer"
      onPointerDown={(e) => {
        if (busy || e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = point(e);
        setStart(p);
        setEnd(p);
      }}
      onPointerMove={(e) => {
        if (start) setEnd(point(e));
      }}
      onPointerUp={(e) => {
        if (!start) return;
        const p = point(e);
        setStart(null);
        setEnd(null);
        finish(start, p);
      }}
      onPointerCancel={() => {
        setStart(null);
        setEnd(null);
      }}
    >
      {preview && <div className="pdfo-field-draft" style={preview} />}
    </div>
  );
}

export function FieldEditLayer({
  scale,
  busy,
  list,
  onPick,
}: {
  scale: number;
  busy: boolean;
  /** Reads this page's fields; called once each time the layer appears. */
  list(): Promise<FormField[]>;
  onPick(field: FormField): void;
}) {
  const [fields, setFields] = useState<FormField[] | null>(null);
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    let live = true;
    listRef
      .current()
      .then((found) => {
        if (live) setFields(found);
      })
      .catch(() => {
        if (live) setFields([]);
      });
    return () => {
      live = false;
    };
  }, []);

  if (!fields) return null;
  return (
    <div className="pdfo-field-edit-layer">
      {fields.map((field) => {
        const [x0, y0, x1, y1] = field.rect;
        return (
          <button
            key={field.id}
            type="button"
            className="pdfo-field-outline"
            style={{
              left: x0 * scale,
              top: y0 * scale,
              width: (x1 - x0) * scale,
              height: (y1 - y0) * scale,
            }}
            disabled={busy}
            title={`${FIELD_KIND_NAMES[field.kind]}: ${field.name}`}
            aria-label={`Edit ${FIELD_KIND_NAMES[field.kind].toLowerCase()} "${field.name}"`}
            onClick={() => onPick(field)}
          />
        );
      })}
    </div>
  );
}
