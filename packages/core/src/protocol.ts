// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Messages exchanged between the UI thread and the PDF worker.

import type { RenderedPage } from "./engine";

export type WorkerRequest =
  | { id: number; type: "open"; bytes: Uint8Array }
  | { id: number; type: "render"; index: number; scale?: number }
  | { id: number; type: "save"; incremental?: boolean }
  | { id: number; type: "close" };

export interface WorkerResults {
  open: { pageCount: number };
  render: RenderedPage;
  save: Uint8Array;
  close: null;
}

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
