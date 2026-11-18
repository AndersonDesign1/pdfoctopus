// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A signature (or initials, or a date) waiting to be put on the page: drag it to move it,
// drag its corner to resize it, then apply. Nothing changes in the PDF until Apply.

import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";
import { clampRect, type PageRect, placementKey, resizeRect } from "./ink";

export interface PlacementProps {
  rect: PageRect;
  page: { width: number; height: number };
  /** CSS pixels per point. */
  scale: number;
  imageUrl: string;
  /** E.g. "signature", for labels. */
  noun: string;
  busy: boolean;
  onChange(rect: PageRect): void;
  onApply(): void;
  onCancel(): void;
}

type Drag =
  | { mode: "move"; startX: number; startY: number; rect: PageRect }
  | { mode: "resize"; startX: number; rect: PageRect };

export function Placement({
  rect,
  page,
  scale,
  imageUrl,
  noun,
  busy,
  onChange,
  onApply,
  onCancel,
}: PlacementProps) {
  const boxRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<Drag | null>(null);

  // Put the keyboard on the stamp when it appears, and again whenever it moves (clicking the
  // page to move it would otherwise leave the focus on the page), so its keys keep working.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the stamp moves
  useEffect(() => {
    boxRef.current?.focus({ preventScroll: true });
  }, [rect.left, rect.top]);

  function begin(e: ReactPointerEvent, mode: Drag["mode"]) {
    if (e.button !== 0 || busy) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current =
      mode === "move"
        ? { mode, startX: e.clientX, startY: e.clientY, rect }
        : { mode, startX: e.clientX, rect };
  }

  function move(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / scale;
    if (d.mode === "move") {
      const dy = (e.clientY - d.startY) / scale;
      onChange(clampRect({ ...d.rect, left: d.rect.left + dx, top: d.rect.top + dy }, page));
    } else {
      onChange(resizeRect(d.rect, d.rect.width + dx, page));
    }
  }

  function end() {
    drag.current = null;
  }

  // Near the bottom of the page, show the buttons above the stamp so the next page can't cover them.
  const nearBottom = (page.height - rect.top - rect.height) * scale < 56;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: only stops clicks reaching the page below; the stamp handles the keyboard itself
    // biome-ignore lint/a11y/noStaticElementInteractions: as above
    <div
      className="pdfo-placement"
      style={{
        left: rect.left * scale,
        top: rect.top * scale,
        width: rect.width * scale,
        height: rect.height * scale,
      }}
      // Clicks on the stamp are for the stamp, not for "move it to where I clicked".
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        ref={boxRef}
        className="pdfo-placement-box"
        aria-roledescription={`${noun} to place`}
        aria-label={`Your ${noun}. Drag or use the arrow keys to move it, Shift plus arrows to move faster, plus and minus to resize. Enter to apply, Escape to cancel.`}
        onPointerDown={(e) => begin(e, "move")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={(e) => {
          // Ctrl/Cmd/Alt combinations are the browser's and the app's (zoom, undo), not the stamp's.
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          const action = placementKey(e.key, e.shiftKey, rect, page);
          if (!action) return;
          // Keep these keys from also scrolling the view or changing page.
          e.preventDefault();
          e.stopPropagation();
          if (action.type === "change") onChange(action.rect);
          else if (action.type === "apply" && !busy) onApply();
          else if (action.type === "cancel" && !busy) onCancel();
        }}
      >
        <img src={imageUrl} alt="" draggable={false} />
        <span
          className="pdfo-placement-handle"
          aria-hidden="true"
          onPointerDown={(e) => begin(e, "resize")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      </button>
      <div className={nearBottom ? "pdfo-placement-actions above" : "pdfo-placement-actions"}>
        <button type="button" className="button" disabled={busy} onClick={onApply}>
          Apply
        </button>
        {/* While applying, the stamp is being written and can't be called back. */}
        <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
