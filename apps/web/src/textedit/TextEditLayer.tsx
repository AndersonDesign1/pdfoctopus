// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Edit text tool's layer over a page: every line of text outlined (purple if it can be
// edited, grey and dashed if not, with the reason), and a text box over the line being edited.
// Enter applies, Escape cancels. A line that's part of a paragraph offers "Edit paragraph",
// which puts a bigger box over the whole paragraph; its text flows from line to line, and
// Ctrl+Enter applies it. The text being typed is kept by the app (see TextDraft), so it
// survives the page being scrolled away and its layer removed.

import type { PageText, ParagraphInfo, TextLineInfo } from "@pdfoctopus/core";
import { MAX_LINE_TEXT, MAX_PARAGRAPH_TEXT } from "@pdfoctopus/core";
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";

/** A line (or the paragraph it's in) being edited, and the text typed so far. */
export interface TextDraft {
  line: TextLineInfo;
  text: string;
  /** Set when the whole paragraph is being edited: `text` is then the paragraph's. */
  paragraph?: ParagraphInfo;
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
  onEditParagraph,
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
  /** Apply new text to a paragraph, the same way. */
  onEditParagraph(
    paragraph: ParagraphInfo,
    line: TextLineInfo,
    text: string,
    signed: boolean,
  ): Promise<boolean>;
  /** Say why a line or paragraph can't be edited. */
  onExplain(reason: string | null): void;
}) {
  const [page, setPage] = useState<PageText | null>(null);
  const setEditing = onEditingChange;
  const listRef = useRef(list);
  listRef.current = list;
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    listRef
      .current()
      .then((found) => {
        if (live) setPage(found);
      })
      .catch(() => {
        if (live) setPage({ lines: [], paragraphs: [], signed: false });
      });
    return () => {
      live = false;
    };
  }, []);

  // Focus the text box when a line or paragraph is picked or the layer comes back (after
  // scrolling), not on every keystroke. Text not changed yet is selected, so typing replaces it.
  const editingKey = editing
    ? `${editing.line.id}:${editing.paragraph ? `p${editing.paragraph.id}` : ""}`
    : undefined;
  const loaded = page !== null;
  const original = editing ? (editing.paragraph?.text ?? editing.line.text) : "";
  const fresh = editing ? editing.text === original : false;
  const freshRef = useRef(fresh);
  freshRef.current = fresh;
  useEffect(() => {
    if (editingKey === undefined || !loaded) return;
    const box = input.current ?? area.current;
    box?.focus();
    if (freshRef.current && input.current) input.current.select();
  }, [editingKey, loaded]);

  if (!page) return null;

  const paragraphOf = (line: TextLineInfo) =>
    page.paragraphs.find((p) => p.lines.includes(line.id)) ?? null;
  const paragraph = editing?.paragraph ?? null;
  const hidden = new Set(paragraph ? paragraph.lines : editing ? [editing.line.id] : []);
  const lineParagraph = editing && !paragraph ? paragraphOf(editing.line) : null;

  const commit = async () => {
    if (!editing || busy) return;
    if (editing.text === original) {
      setEditing(null);
      return;
    }
    const done = paragraph
      ? await onEditParagraph(paragraph, editing.line, editing.text, page.signed)
      : await onEdit(editing.line, editing.text, page.signed);
    if (done) setEditing(null);
    else (input.current ?? area.current)?.focus();
  };

  const cancelKey = (e: KeyboardEvent) => {
    // Only the edit is cancelled; the tool stays picked.
    e.preventDefault();
    e.stopPropagation();
    setEditing(null);
  };

  return (
    <div className="pdfo-text-edit-layer">
      {page.lines.map((line) => {
        if (hidden.has(line.id)) return null;
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
              else onExplain(line.reason);
            }}
          />
        );
      })}
      {editing && !paragraph && (
        <input
          ref={input}
          className="pdfo-text-input"
          style={inputStyle(editing.line, scale)}
          value={editing.text}
          dir={editing.line.direction}
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
              cancelKey(e);
            }
          }}
        />
      )}
      {editing && lineParagraph && (
        <button
          type="button"
          className={
            lineParagraph.editable ? "pdfo-text-switch" : "pdfo-text-switch pdfo-text-switch-off"
          }
          style={switchStyle(editing.line, scale)}
          disabled={busy}
          title={
            lineParagraph.editable
              ? "Edit the whole paragraph, so the text flows from line to line"
              : (lineParagraph.reason ?? undefined)
          }
          // Keep the line's text box focused until the switch is made.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (!lineParagraph.editable) {
              onExplain(lineParagraph.reason);
              return;
            }
            setEditing({ line: editing.line, text: lineParagraph.text, paragraph: lineParagraph });
          }}
        >
          Edit paragraph
        </button>
      )}
      {editing && paragraph && (
        <div className="pdfo-paragraph-editor" style={areaStyle(paragraph, editing.line, scale)}>
          <textarea
            ref={area}
            className="pdfo-paragraph-input"
            style={areaTextStyle(paragraph, editing.line, scale)}
            value={editing.text}
            dir={paragraph.direction}
            maxLength={MAX_PARAGRAPH_TEXT}
            spellCheck={false}
            aria-label="New text for the paragraph. Ctrl+Enter applies, Escape cancels."
            disabled={busy}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") {
                cancelKey(e);
              }
            }}
          />
          <div className="pdfo-paragraph-actions">
            <span className="pdfo-paragraph-hint">Ctrl+Enter applies · Esc cancels</span>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => void commit()}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Where a box starts, as shown: its top-left corner as text in it reads. */
function origin(rect: readonly number[], rotation: number): [number, number] {
  const [x0, y0, x1, y1] = rect as [number, number, number, number];
  return rotation === 90
    ? [x1, y0]
    : rotation === 180
      ? [x1, y1]
      : rotation === 270
        ? [x0, y1]
        : [x0, y0];
}

function fontStyle(line: TextLineInfo, scale: number): CSSProperties {
  const [r, g, b] = line.color.map((c) => Math.round(c * 255));
  return {
    fontSize: Math.max(line.size * scale, 8),
    fontFamily: line.mono ? "monospace" : line.serif ? "serif" : "sans-serif",
    fontWeight: line.bold ? 700 : 400,
    fontStyle: line.italic ? "italic" : "normal",
    color: `rgb(${r} ${g} ${b})`,
  };
}

/** A text box over a line, in its font's style, turned the way the line reads. */
function inputStyle(line: TextLineInfo, scale: number): CSSProperties {
  const [x0, y0, x1, y1] = line.rect;
  const along = line.rotation === 90 || line.rotation === 270 ? y1 - y0 : x1 - x0;
  const across = line.rotation === 90 || line.rotation === 270 ? x1 - x0 : y1 - y0;
  const [left, top] = origin(line.rect, line.rotation);
  // Room to type more than was there; the engine says if it no longer fits.
  const width = Math.max((along + 2 * PAD) * scale + 40, 120);
  // A line read right to left keeps its right edge, so its box grows to the left.
  const rtl = line.direction === "rtl" && line.rotation === 0;
  return {
    ...fontStyle(line, scale),
    left: rtl ? (x1 + PAD) * scale - width : (left - PAD) * scale,
    top: (top - PAD) * scale,
    width,
    height: (across + 2 * PAD) * scale,
    transform: line.rotation ? `rotate(${line.rotation}deg)` : undefined,
    transformOrigin: "0 0",
  };
}

/** The "Edit paragraph" button, just above the line's text box. */
function switchStyle(line: TextLineInfo, scale: number): CSSProperties {
  const [left, top] = origin(line.rect, line.rotation);
  return {
    left: (left - PAD) * scale,
    top: (top - PAD) * scale - 26,
    transform: line.rotation ? `rotate(${line.rotation}deg)` : undefined,
    transformOrigin: `0 26px`,
  };
}

/** The paragraph's box, turned the way it reads, with room under it for its buttons. */
function areaStyle(paragraph: ParagraphInfo, line: TextLineInfo, scale: number): CSSProperties {
  const [x0, y0, x1, y1] = paragraph.rect;
  const turned = line.rotation === 90 || line.rotation === 270;
  const along = turned ? y1 - y0 : x1 - x0;
  const [left, top] = origin(paragraph.rect, line.rotation);
  return {
    left: (left - PAD) * scale,
    top: (top - PAD) * scale,
    width: Math.max((along + 2 * PAD) * scale, 220),
    transform: line.rotation ? `rotate(${line.rotation}deg)` : undefined,
    transformOrigin: "0 0",
  };
}

function areaTextStyle(paragraph: ParagraphInfo, line: TextLineInfo, scale: number): CSSProperties {
  const [x0, y0, x1, y1] = paragraph.rect;
  const turned = line.rotation === 90 || line.rotation === 270;
  const across = turned ? x1 - x0 : y1 - y0;
  const count = Math.max(paragraph.lines.length, 1);
  // The paragraph's own line spacing, so the text wraps about where it will on the page.
  const spacing = count > 1 ? (across - line.size * 1.2) / (count - 1) : line.size * 1.2;
  return {
    ...fontStyle(line, scale),
    height: (across + 2 * PAD) * scale + spacing * scale,
    lineHeight: `${Math.max(spacing, line.size) * scale}px`,
  };
}
