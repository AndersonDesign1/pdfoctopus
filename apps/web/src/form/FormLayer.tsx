// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Drawn over a page that has form fields: a real input over each field, so it can be clicked,
// typed in and tabbed through. The page underneath shows each field as the PDF draws it; an
// input shows its own text only while it has the focus, so the two never overlap. A field's
// new value goes into the document when the input loses the focus (or on Enter), as one
// undoable step. Text typed but not yet in the document is reported with onDraft, so saving
// can put it in first and its page stays loaded.

import type { FormField } from "@pdfoctopus/core";
import { useEffect, useRef, useState } from "react";

export interface FormLayerProps {
  pageIndex: number;
  /** CSS pixels per point. */
  scale: number;
  busy: boolean;
  /** Reads this page's fields; called once each time the layer appears. */
  list(): Promise<FormField[]>;
  onSet(field: FormField, value: string | boolean): void;
  /** Text typed in a field that isn't in the document yet, or null once it is (or is undone). */
  onDraft(field: FormField, value: string | null): void;
  /** The field to put the focus back on when the layer appears (after a change redraws it). */
  focusId: number | null;
  onFocusField(id: number | null): void;
}

export function FormLayer({
  pageIndex,
  scale,
  busy,
  list,
  onSet,
  onDraft,
  focusId,
  onFocusField,
}: FormLayerProps) {
  const [fields, setFields] = useState<FormField[] | null>(null);
  const elements = useRef(new Map<number, HTMLElement>());

  // Read the page's fields once. The layer is replaced after every change.
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

  // Tabbing from one field to the next saves the first, which redraws the page and replaces
  // this layer: put the focus back where it was going.
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  useEffect(() => {
    if (!fields || focusRef.current === null) return;
    elements.current.get(focusRef.current)?.focus({ preventScroll: true });
  }, [fields]);

  if (!fields || fields.length === 0) return null;
  const s = scale;
  return (
    <div className="pdfo-form-layer">
      {fields.map((field) => {
        if (field.readOnly || field.kind === "signature" || field.kind === "button") return null;
        const [x0, y0, x1, y1] = field.rect;
        const style = {
          left: x0 * s,
          top: y0 * s,
          width: (x1 - x0) * s,
          height: (y1 - y0) * s,
        };
        const register = (el: HTMLElement | null) => {
          if (el) elements.current.set(field.id, el);
          else elements.current.delete(field.id);
        };
        const common = {
          ref: register,
          style,
          "aria-label": field.label,
          "aria-required": field.required || undefined,
          onFocus: () => onFocusField(field.id),
          onBlur: () => {
            if (focusRef.current === field.id) onFocusField(null);
          },
        };
        if (field.kind === "checkbox" || field.kind === "radio") {
          return (
            <input
              key={field.id}
              type={field.kind}
              name={field.kind === "radio" ? `pdfo-field-${field.name}` : undefined}
              className="pdfo-form-field pdfo-form-toggle"
              checked={field.checked}
              disabled={busy}
              onChange={(e) => onSet(field, field.kind === "radio" ? true : e.target.checked)}
              {...common}
            />
          );
        }
        if (field.kind === "listbox" || (field.kind === "combobox" && !field.editable)) {
          return (
            <select
              key={field.id}
              className="pdfo-form-field pdfo-form-choice"
              value={field.value}
              disabled={busy}
              onChange={(e) => onSet(field, e.target.value)}
              {...common}
            >
              {/* A field with no value yet shows nothing chosen. */}
              {!field.options.some((o) => o.value === field.value) && (
                <option value={field.value} />
              )}
              {field.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          );
        }
        return (
          <TextField
            key={field.id}
            field={field}
            busy={busy}
            fontSize={Math.max(8, Math.min((y1 - y0) * s * 0.62, 13 * s))}
            onSet={onSet}
            onDraft={onDraft}
            common={common}
          />
        );
      })}
      <span className="visually-hidden" aria-live="polite">
        {`Page ${pageIndex + 1} has ${fields.length} form ${fields.length === 1 ? "field" : "fields"}.`}
      </span>
    </div>
  );
}

function TextField({
  field,
  busy,
  fontSize,
  onSet,
  onDraft,
  common,
}: {
  field: FormField;
  busy: boolean;
  fontSize: number;
  onSet(field: FormField, value: string): void;
  onDraft(field: FormField, value: string | null): void;
  common: {
    ref: (el: HTMLElement | null) => void;
    style: React.CSSProperties;
    "aria-label": string;
    "aria-required": boolean | undefined;
    onFocus(): void;
    onBlur(): void;
  };
}) {
  const [draft, setDraft] = useState(field.value);
  // The latest text, for handlers that run before a re-render (Escape, then blur).
  const latest = useRef(field.value);
  const change = (value: string) => {
    latest.current = value;
    setDraft(value);
    onDraft(field, value === field.value ? null : value);
  };
  const save = () => {
    if (latest.current !== field.value) onSet(field, latest.current);
  };
  // An editable dropdown: type anything, or pick one of the options.
  const listId = field.kind === "combobox" ? `pdfo-field-options-${field.id}` : undefined;
  const props = {
    ...common,
    className: "pdfo-form-field pdfo-form-text",
    style: { ...common.style, fontSize },
    value: draft,
    readOnly: busy,
    maxLength: field.maxLength ?? undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      change(e.target.value),
    onBlur: () => {
      common.onBlur();
      save();
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        change(field.value);
        e.currentTarget.blur();
      } else if (e.key === "Enter" && !field.multiline) {
        e.preventDefault();
        save();
      }
    },
  };
  if (field.multiline) return <textarea {...props} ref={common.ref} />;
  return (
    <>
      <input type="text" list={listId} {...props} ref={common.ref} />
      {listId && (
        <datalist id={listId}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </datalist>
      )}
    </>
  );
}
