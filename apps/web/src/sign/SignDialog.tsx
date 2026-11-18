// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Make a signature or initials: draw it, type it in a handwriting font, or upload a photo or
// scan of one. Signatures can be remembered on this device and picked again next time.

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Modal } from "../ui/Dialogs";
import type { InkPoint } from "./ink";
import {
  addSaved,
  loadSaved,
  removeSaved,
  type SavedKind,
  type SavedSignature,
} from "./savedSignatures";
import {
  drawStrokes,
  INK_COLOURS,
  pictureToStamp,
  SIGNATURE_FONTS,
  type SignatureFont,
  type StampImage,
  stampFromDataUrl,
  strokesToStamp,
  textToStamp,
} from "./stampImage";

type Tab = "saved" | "draw" | "type" | "upload";

const TAB_LABELS: Record<Tab, string> = {
  saved: "Saved",
  draw: "Draw",
  type: "Type",
  upload: "Upload",
};

/** Size of the drawing pad in CSS pixels; the pad scales down on narrow screens. */
const PAD = { width: 520, height: 200 };
const PEN_WIDTH = { signature: 2.6, initials: 3.2 };

export function SignDialog({
  kind,
  onUse,
  onCancel,
}: {
  kind: SavedKind;
  onUse(image: StampImage): void;
  onCancel(): void;
}) {
  const noun = kind === "signature" ? "signature" : "initials";
  const [saved, setSaved] = useState<SavedSignature[]>(() =>
    loadSaved().filter((s) => s.kind === kind),
  );
  const [tab, setTab] = useState<Tab>(saved.length ? "saved" : "draw");
  const [colour, setColour] = useState<string>(INK_COLOURS[0].value);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  // Draw
  const [strokes, setStrokes] = useState<InkPoint[][]>([]);
  // Type
  const [typed, setTyped] = useState("");
  const [font, setFont] = useState<SignatureFont>(SIGNATURE_FONTS[0].family);
  // Upload
  const [picture, setPicture] = useState<File>();
  const [removePaper, setRemovePaper] = useState(true);
  const [uploaded, setUploaded] = useState<StampImage | null>(null);

  // Clean up the uploaded picture whenever it or the background option changes.
  useEffect(() => {
    if (!picture) {
      setUploaded(null);
      return;
    }
    let current = true;
    setError(undefined);
    // The previous result is for another picture or setting: never place it by mistake.
    setUploaded(null);
    pictureToStamp(picture, removePaper).then(
      (img) => {
        if (!current) return;
        setUploaded(img);
        if (!img) setError("Nothing was found in that picture. Try one with darker ink.");
      },
      (err: unknown) => {
        if (!current) return;
        setUploaded(null);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      current = false;
    };
  }, [picture, removePaper]);

  const ready =
    (tab === "draw" && strokes.length > 0) ||
    (tab === "type" && typed.trim() !== "") ||
    (tab === "upload" && uploaded !== null);

  // A typed signature waits for its font, and the dialog can be closed meanwhile. Once it's
  // closed, the result must be dropped: not remembered, and not placed.
  const open = useRef(true);
  useEffect(
    () => () => {
      open.current = false;
    },
    [],
  );

  async function use() {
    setError(undefined);
    setWorking(true);
    try {
      let image: StampImage | null = null;
      if (tab === "draw") image = strokesToStamp(strokes, PAD, colour, PEN_WIDTH[kind]);
      else if (tab === "type") image = await textToStamp(typed, font, colour);
      else if (tab === "upload") image = uploaded;
      if (!open.current) return;
      if (!image) {
        setError(`There's no ${noun} to use yet.`);
        return;
      }
      if (remember && addSaved({ kind, dataUrl: image.dataUrl, ...size(image) }) === null) {
        // Still use it; it just won't be offered next time.
        console.warn("Couldn't remember the signature: browser storage is unavailable or full");
      }
      onUse(image);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (open.current) setWorking(false);
    }
  }

  const tabs: Tab[] = saved.length
    ? ["saved", "draw", "type", "upload"]
    : ["draw", "type", "upload"];
  const baseId = useId();

  return (
    <Modal
      title={kind === "signature" ? "Add your signature" : "Add your initials"}
      onClose={onCancel}
    >
      <div className="pdfo-tabs" role="tablist" aria-label={`How to make your ${noun}`}>
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`${baseId}-${t}`}
            aria-selected={tab === t}
            aria-controls={`${baseId}-panel`}
            className="pdfo-tab"
            onClick={() => {
              setTab(t);
              setError(undefined);
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-${tab}`}>
        {tab === "saved" && (
          <SavedList
            items={saved}
            noun={noun}
            onPick={(s) => onUse(stampFromDataUrl(s.dataUrl, s.width, s.height))}
            onRemove={(s) => setSaved(removeSaved(s.id).filter((x) => x.kind === kind))}
          />
        )}

        {tab === "draw" && (
          <>
            <DrawPad
              strokes={strokes}
              onChange={setStrokes}
              colour={colour}
              penWidth={PEN_WIDTH[kind]}
            />
            <div className="pdfo-row">
              <span className="pdfo-hint">Draw with your mouse, finger or pen.</span>
              <button
                type="button"
                className="button secondary"
                disabled={strokes.length === 0}
                onClick={() => setStrokes((s) => s.slice(0, -1))}
              >
                Undo stroke
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={strokes.length === 0}
                onClick={() => setStrokes([])}
              >
                Clear
              </button>
            </div>
          </>
        )}

        {tab === "type" && (
          <>
            <label className="pdfo-field">
              {kind === "signature" ? "Your name" : "Your initials"}
              <input
                type="text"
                value={typed}
                maxLength={kind === "signature" ? 60 : 6}
                autoComplete={kind === "signature" ? "name" : "off"}
                onChange={(e) => setTyped(e.target.value)}
              />
            </label>
            <fieldset className="pdfo-fieldset pdfo-fonts">
              <legend className="visually-hidden">Style</legend>
              {SIGNATURE_FONTS.map((f) => (
                <label key={f.family} className="pdfo-font-choice">
                  <input
                    type="radio"
                    name={`${baseId}-font`}
                    checked={font === f.family}
                    onChange={() => setFont(f.family)}
                  />
                  <span
                    className="pdfo-font-sample"
                    style={{ fontFamily: `"${f.family}"`, color: colour }}
                  >
                    {typed.trim() || (kind === "signature" ? "Your Name" : "YN")}
                  </span>
                  <span className="visually-hidden">{f.label}</span>
                </label>
              ))}
            </fieldset>
          </>
        )}

        {tab === "upload" && (
          <>
            <label className="pdfo-field">
              A photo or scan of your {noun} on plain paper
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  setPicture(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            <label className="pdfo-choice">
              <input
                type="checkbox"
                checked={removePaper}
                onChange={(e) => setRemovePaper(e.target.checked)}
              />
              Remove the paper background
            </label>
            {uploaded && (
              <div className="pdfo-sign-preview">
                <img src={uploaded.dataUrl} alt={`Your ${noun}, ready to place`} />
              </div>
            )}
          </>
        )}
      </div>

      {tab !== "saved" && (
        <div className="pdfo-row">
          {tab !== "upload" && (
            <fieldset className="pdfo-fieldset pdfo-colours">
              <legend className="visually-hidden">Ink colour</legend>
              {INK_COLOURS.map((c) => (
                <label key={c.value} className="pdfo-colour" title={c.label}>
                  <input
                    type="radio"
                    name={`${baseId}-colour`}
                    checked={colour === c.value}
                    onChange={() => setColour(c.value)}
                  />
                  <span className="pdfo-swatch" style={{ background: c.value }} />
                  <span className="visually-hidden">{c.label}</span>
                </label>
              ))}
            </fieldset>
          )}
          <label className="pdfo-choice">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Remember on this device
          </label>
        </div>
      )}

      {error && (
        <p className="pdfo-error" role="alert">
          {error}
        </p>
      )}

      <div className="pdfo-dialog-actions">
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
        {tab !== "saved" && (
          <button
            type="button"
            className="button"
            disabled={!ready || working}
            onClick={() => void use()}
          >
            Place {noun}
          </button>
        )}
      </div>
    </Modal>
  );
}

function size(image: StampImage) {
  return { width: image.width, height: image.height };
}

function SavedList({
  items,
  noun,
  onPick,
  onRemove,
}: {
  items: SavedSignature[];
  noun: string;
  onPick(item: SavedSignature): void;
  onRemove(item: SavedSignature): void;
}) {
  if (items.length === 0) {
    return <p className="pdfo-hint">Nothing saved yet. Make one in the other tabs.</p>;
  }
  return (
    <>
      <ul className="pdfo-saved-list">
        {items.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              className="pdfo-saved-pick"
              onClick={() => onPick(s)}
              aria-label={`Use saved ${noun} ${i + 1}`}
            >
              <img src={s.dataUrl} alt="" />
            </button>
            <button
              type="button"
              className="tool icon"
              onClick={() => onRemove(s)}
              aria-label={`Forget saved ${noun} ${i + 1}`}
              title="Forget"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <p className="pdfo-hint">
        Saved {noun === "signature" ? "signatures" : noun} stay on this device only.
      </p>
    </>
  );
}

/** A canvas to sign on with a mouse, finger or pen. */
function DrawPad({
  strokes,
  onChange,
  colour,
  penWidth,
}: {
  strokes: InkPoint[][];
  onChange(strokes: InkPoint[][]): void;
  colour: string;
  penWidth: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The stroke being drawn, kept outside React state so drawing doesn't re-render. */
  const active = useRef<InkPoint[] | null>(null);
  const frame = useRef(0);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(PAD.width * dpr);
    const height = Math.round(PAD.height * dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    const all = active.current ? [...strokes, active.current] : strokes;
    drawStrokes(ctx, all, colour, penWidth, dpr);
  }, [strokes, colour, penWidth]);

  useEffect(() => {
    redraw();
  }, [redraw]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  /** Pointer position in pad pixels (the canvas may be shown smaller than PAD). */
  function point(e: ReactPointerEvent | PointerEvent): InkPoint {
    const rect = (canvasRef.current as HTMLCanvasElement).getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * PAD.width,
      y: ((e.clientY - rect.top) / rect.height) * PAD.height,
      pressure: e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5,
    };
  }

  function scheduleRedraw() {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      redraw();
    });
  }

  function finish() {
    const stroke = active.current;
    active.current = null;
    if (stroke?.length) onChange([...strokes, stroke]);
  }

  return (
    <div className="pdfo-pad">
      <canvas
        ref={canvasRef}
        aria-label="Signature drawing area"
        role="img"
        style={{ aspectRatio: `${PAD.width} / ${PAD.height}` }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          active.current = [point(e)];
          scheduleRedraw();
        }}
        onPointerMove={(e) => {
          const stroke = active.current;
          if (!stroke) return;
          // Coalesced events give every point the pen passed through, not one per frame.
          const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
          for (const ev of events.length ? events : [e.nativeEvent]) stroke.push(point(ev));
          scheduleRedraw();
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
      />
      <span className="pdfo-pad-line" aria-hidden="true" />
    </div>
  );
}
