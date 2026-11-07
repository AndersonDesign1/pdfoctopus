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
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(req: WorkerRequest) {
    this.sent.push(req);
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

  it("treats an uncaught worker error as a crash", async () => {
    const client = new PdfWorkerClient();
    const opening = client.init();
    FakeWorker.last.onerror?.({ message: "boom", preventDefault() {} });
    await expect(opening).rejects.toBeInstanceOf(EngineCrashedError);
    expect(client.crashed).toBe(true);
  });
});
