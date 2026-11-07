// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import type { PageRenderer, RenderKind } from "./renderer";
import { RenderCancelledError } from "./renderQueue";

export interface PageCanvasProps {
  renderer: PageRenderer;
  kind: RenderKind;
  index: number;
  /** Size on screen, in CSS pixels. */
  width: number;
  height: number;
  /** Resolution to render at (MuPDF scale: 1 = 72 dpi). */
  renderScale: number;
  className?: string;
  label: string;
}

function draw(canvas: HTMLCanvasElement, bitmap: ImageBitmap): void {
  try {
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  } catch {
    // The bitmap was freed by the cache in the meantime; the next render will draw.
  }
}

/**
 * One page drawn on a canvas. While the exact resolution renders, the closest cached bitmap
 * is shown stretched, so zooming and scrolling never flash a blank page.
 */
export function PageCanvas({
  renderer,
  kind,
  index,
  width,
  height,
  renderScale,
  className,
  label,
}: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the render on Retry
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const exact = renderer.cached(kind, index, renderScale);
    if (exact) {
      draw(canvas, exact);
      return;
    }
    const placeholder = renderer.placeholder(kind, index, renderScale);
    if (placeholder) draw(canvas, placeholder);

    let current = true;
    setFailed(false);
    renderer.render(kind, index, renderScale).then(
      (bitmap) => {
        if (current) draw(canvas, bitmap);
      },
      (err) => {
        if (err instanceof RenderCancelledError) return;
        console.warn(`Page ${index + 1}:`, err);
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [renderer, kind, index, renderScale, attempt]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className={className}
        style={{ width, height }}
        role="img"
        aria-label={label}
      />
      {failed && kind === "page" && (
        <div className="pdfo-page-error" role="alert">
          <span>This page couldn't be displayed. It may be damaged.</span>
          <button
            type="button"
            className="button secondary"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </button>
        </div>
      )}
    </>
  );
}
