// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Edit text tool's layer over a page: every line of text outlined (purple if it can be
// edited, grey and dashed if not, with the reason), and a text box over the line being edited.
// Enter applies, Escape cancels. The text being typed is kept by the app (see TextDraft), so it
// survives the page being scrolled away and its layer removed.

import type { PageText, TextLineInfo } from "@pdfoctopus/core";
import { MAX_LINE_TEXT } from "@pdfoctopus/core";
import { type CSSProperties, useEffect, useRef, useState } from "react";

/** A line being edited and the text typed so far. */
export interface TextDraft {
  line: TextLineInfo;
  text: string;
}

/** Room around a line's box, in points, so small text is easy to click. */
const PAD = 1.5;

export function TextEditLayer({
  scale,
  busy,
  list,
  editing,
  onEditingChange,
  onEdit,
  onExplain,
}: {
  /** CSS pixels per point. */
  scale: number;
  busy: boolean;
  /** Reads this page's lines; called once each time the layer appears. */
  list(): Promise<PageText>;
  /** The line being edited on this page, if any, and what's been typed. */
  editing: TextDraft | null;
  /** A line picked, the text changed, or the edit finished or cancelled (null). */
  onEditingChange(draft: TextDraft | null): void;
  /** Apply new text to a line. Resolves true once it's done (or false to keep editing). */
  onEdit(line: TextLineInfo, text: string, signed: boolean): Promise<boolean>;
  /** Say why a line can't be edited. */
  onExplain(line: TextLineInfo): void;
}) {
  const [page, setPage] = useState<PageText | null>(null);
  const setEditing = onEditingChange;
  const listRef = useRef(list);
  listRef.current = list;
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    listRef
      .current()
      .then((found) => {
        if (live) setPage(found);
      })
      .catch(() => {
        if (live) setPage({ lines: [], signed: false });
      });
    return () => {
      live = false;
    };
  }, []);

  // Focus the text box when a line is picked or the layer comes back (after scrolling), not on
  // every keystroke. Text not changed yet is selected, so typing replaces it.
  const editingId = editing?.line.id;
  const loaded = page !== null;
  const fresh = editing ? editing.text === editing.line.text : false;
  const freshRef = useRef(fresh);
  freshRef.current = fresh;
  useEffect(() => {
    if (editingId === undefined || !loaded) return;
    input.current?.focus();
    if (freshRef.current) input.current?.select();
  }, [editingId, loaded]);

  if (!page) return null;

  const commit = async () => {
    if (!editing || busy) return;
    if (editing.text === editing.line.text) {
      setEditing(null);
      return;
    }
    const done = await onEdit(editing.line, editing.text, page.signed);
    if (done) setEditing(null);
    else input.current?.focus();
  };

  return (
    <div className="pdfo-text-edit-layer">
      {page.lines.map((line) => {
        if (editing?.line.id === line.id) return null;
        const [x0, y0, x1, y1] = line.rect;
        const box: CSSProperties = {
          left: (x0 - PAD) * scale,
          top: (y0 - PAD) * scale,
          width: (x1 - x0 + 2 * PAD) * scale,
          height: (y1 - y0 + 2 * PAD) * scale,
        };
        return (
          <button
            key={line.id}
            type="button"
            className={line.editable ? "pdfo-text-line" : "pdfo-text-line locked"}
            style={box}
            disabled={busy}
            title={line.editable ? `Edit “${line.text.trim()}”` : (line.reason ?? undefined)}
            aria-label={
              line.editable
                ? `Edit line “${line.text.trim()}”`
                : `“${line.text.trim()}” can't be edited: ${line.reason ?? ""}`
            }
            onClick={() => {
              if (line.editable) setEditing({ line, text: line.text });
              else onExplain(line);
            }}
          />
        );
      })}
      {editing && (
        <input
          ref={input}
          className="pdfo-text-input"
          style={inputStyle(editing.line, scale)}
          value={editing.text}
          maxLength={MAX_LINE_TEXT}
          spellCheck={false}
          aria-label="New text for the line. Enter applies, Escape cancels."
          disabled={busy}
          onChange={(e) => setEditing({ line: editing.line, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              // Only the edit is cancelled; the tool stays picked.
              e.preventDefault();
              e.stopPropagation();
              setEditing(null);
            }
          }}
        />
      )}
    </div>
  );
}

/** A text box over a line, in its font's style, turned the way the line reads. */
function inputStyle(line: TextLineInfo, scale: number): CSSProperties {
  const [x0, y0, x1, y1] = line.rect;
  const along = line.rotation === 90 || line.rotation === 270 ? y1 - y0 : x1 - x0;
  const across = line.rotation === 90 || line.rotation === 270 ? x1 - x0 : y1 - y0;
  const [left, top] =
    line.rotation === 90
      ? [x1, y0]
      : line.rotation === 180
        ? [x1, y1]
        : line.rotation === 270
          ? [x0, y1]
          : [x0, y0];
  const [r, g, b] = line.color.map((c) => Math.round(c * 255));
  return {
    left: (left - PAD) * scale,
    top: (top - PAD) * scale,
    // Room to type more than was there; the engine says if it no longer fits.
    width: Math.max((along + 2 * PAD) * scale + 40, 120),
    height: (across + 2 * PAD) * scale,
    fontSize: Math.max(line.size * scale, 8),
    fontFamily: line.mono ? "monospace" : line.serif ? "serif" : "sans-serif",
    fontWeight: line.bold ? 700 : 400,
    fontStyle: line.italic ? "italic" : "normal",
    color: `rgb(${r} ${g} ${b})`,
    transform: line.rotation ? `rotate(${line.rotation}deg)` : undefined,
    transformOrigin: "0 0",
  };
}
