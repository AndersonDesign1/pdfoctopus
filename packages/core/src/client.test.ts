// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfWorkerClient } from "./client";
import { EngineCrashedError, IncrementalSaveError } from "./errors";
import type { WorkerMessage, WorkerRequest } from "./protocol";

/** Stands in for the real Web Worker; tests decide how it answers. */
class FakeWorker {
  static last: FakeWorker;
  onmessage: ((event: { data: WorkerMessage }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: WorkerRequest[] = [];
  transfers: Transferable[][] = [];
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(req: WorkerRequest, transfer: Transferable[] = []) {
    this.sent.push(req);
    this.transfers.push(transfer);
  }
  terminate() {
    this.terminated = true;
  }
  reply(msg: WorkerMessage) {
    this.onmessage?.({ data: msg });
  }
}

beforeEach(() => {
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PdfWorkerClient", () => {
  it("passes load progress to the callback", () => {
    const onLoadProgress = vi.fn();
    new PdfWorkerClient({ onLoadProgress });
    FakeWorker.last.reply({ event: "load-progress", progress: { loaded: 5, total: 10 } });
    expect(onLoadProgress).toHaveBeenCalledWith({ loaded: 5, total: 10 });
  });

  it("keeps the worker after an ordinary error", async () => {
    const client = new PdfWorkerClient();
    const saving = client.save();
    const { id } = FakeWorker.last.sent[0] as WorkerRequest;
    FakeWorker.last.reply({ id, ok: false, code: "incremental-save-unavailable", error: "x" });
    await expect(saving).rejects.toBeInstanceOf(IncrementalSaveError);
    expect(client.crashed).toBe(false);
    expect(FakeWorker.last.terminated).toBe(false);
  });

  it("discards the worker when the engine crashes", async () => {
    const client = new PdfWorkerClient();
    const render = client.renderPage(0);
    const other = client.renderPage(1);
    const { id } = FakeWorker.last.sent[0] as WorkerRequest;
    FakeWorker.last.reply({ id, ok: false, code: "engine-crashed", error: "unreachable" });
    await expect(render).rejects.toBeInstanceOf(EngineCrashedError);
    await expect(other).rejects.toBeInstanceOf(EngineCrashedError);
    expect(client.crashed).toBe(true);
    expect(FakeWorker.last.terminated).toBe(true);
    await expect(client.renderPage(0)).rejects.toBeInstanceOf(EngineCrashedError);
  });

  it("reports a crash while idle once, but not a deliberate terminate", () => {
    const onFatalError = vi.fn();
    const client = new PdfWorkerClient({ onFatalError });
    FakeWorker.last.onerror?.({ message: "boom", preventDefault() {} });
    FakeWorker.last.onmessageerror?.();
    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(onFatalError.mock.calls[0]?.[0]).toBeInstanceOf(EngineCrashedError);
    expect(client.crashed).toBe(true);

    const other = vi.fn();
    new PdfWorkerClient({ onFatalError: other }).terminate();
    expect(other).not.toHaveBeenCalled();
  });

  it("settles the failing request even if onFatalError throws", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new PdfWorkerClient({
      onFatalError: () => {
        throw new Error("bug in callback");
      },
    });
    const render = client.renderPage(0);
    const other = client.renderPage(1);
    const { id } = FakeWorker.last.sent[0] as WorkerRequest;
    FakeWorker.last.reply({ id, ok: false, code: "engine-crashed", error: "unreachable" });
    await expect(render).rejects.toBeInstanceOf(EngineCrashedError);
    await expect(other).rejects.toBeInstanceOf(EngineCrashedError);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("discards a worker that stops answering, as a crash", async () => {
    vi.useFakeTimers();
    try {
      const onFatalError = vi.fn();
      const client = new PdfWorkerClient({ onFatalError, stallTimeoutMs: 1000 });
      // Nothing is waiting: an idle worker is never stuck.
      vi.advanceTimersByTime(5000);
      expect(client.crashed).toBe(false);

      const opening = client.init();
      vi.advanceTimersByTime(900);
      // Any message (load progress here) shows it's alive and starts the clock again.
      FakeWorker.last.reply({ event: "load-progress", progress: { loaded: 1, total: 2 } });
      vi.advanceTimersByTime(900);
      expect(client.crashed).toBe(false);
      const { id } = FakeWorker.last.sent[0] as WorkerRequest;
      FakeWorker.last.reply({ id, ok: true, type: "init", result: null });
      await expect(opening).resolves.toBeNull();
      vi.advanceTimersByTime(5000);
      expect(client.crashed).toBe(false);

      // A request that's never answered: a loop in MuPDF, say.
      const render = client.renderPage(0);
      vi.advanceTimersByTime(1000);
      await expect(render).rejects.toThrow("The PDF engine stopped responding");
      await expect(render).rejects.toBeInstanceOf(EngineCrashedError);
      expect(client.crashed).toBe(true);
      expect(FakeWorker.last.terminated).toBe(true);
      expect(onFatalError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when MuPDF had trouble with a file, so the next file gets a fresh worker", () => {
    const client = new PdfWorkerClient();
    expect(client.troubled).toBe(false);
    FakeWorker.last.reply({ event: "troubled" });
    expect(client.troubled).toBe(true);
    expect(client.crashed).toBe(false);
  });

  it("treats an uncaught worker error as a crash", async () => {
    const client = new PdfWorkerClient();
    const opening = client.init();
    FakeWorker.last.onerror?.({ message: "boom", preventDefault() {} });
    await expect(opening).rejects.toBeInstanceOf(EngineCrashedError);
    expect(client.crashed).toBe(true);
  });

  it("sends page operations and transfers each inserted file's buffer once", async () => {
    const client = new PdfWorkerClient();
    const shared = new Uint8Array(8);
    const third = new Uint8Array(4);
    const inserting = client.insertPdfs(2, [
      { bytes: shared, pages: [0] },
      { bytes: shared, pages: [1] },
      { bytes: third },
    ]);
    const req = FakeWorker.last.sent[0] as Extract<WorkerRequest, { type: "insertPdfs" }>;
    expect(req.type).toBe("insertPdfs");
    expect(req.at).toBe(2);
    expect(FakeWorker.last.transfers[0]).toEqual([shared.buffer, third.buffer]);
    expect(FakeWorker.last.transfers[0]?.[0]).toBe(shared.buffer);
    expect(FakeWorker.last.transfers[0]?.[1]).toBe(third.buffer);
    const result = {
      info: {
        pageCount: 1,
        pages: [{ width: 1, height: 1 }],
        labels: [null],
        metadata: {},
        redactionMarks: 0,
        form: { fields: 0, xfa: "none" as const },
        security: {
          encrypted: false,
          permissions: {
            print: true,
            copy: true,
            edit: true,
            annotate: true,
            fillForms: true,
            assemble: true,
          },
          canChange: true,
          pending: "none" as const,
        },
        redacted: false,
      },
      history: { canUndo: true, canRedo: false, undoLabel: "Insert 2 files", redoLabel: null },
    };
    FakeWorker.last.reply({ id: req.id, ok: true, type: "insertPdfs", result });
    await expect(inserting).resolves.toEqual(result);

    const undoing = client.undo();
    const undo = FakeWorker.last.sent[1] as WorkerRequest;
    expect(undo.type).toBe("undo");
    FakeWorker.last.reply({ id: undo.id, ok: true, type: "undo", result: null });
    await expect(undoing).resolves.toBeNull();
  });
});
