// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fuzz run's thread supervisor: a thread that hangs or dies is cut off, and the variant
// it was on is recorded from the bytes it already sent, without making the variant again.

import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { type Failure, type RunnerMessage, supervise } from "./supervise";

/** A thread that sends `messages`, then does `then` ("hang" loops for ever). */
function fakeThread(messages: RunnerMessage[], then: "hang" | "die" | "finish") {
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    for (const m of workerData.messages) parentPort.postMessage(m);
    if (workerData.then === "hang") for (;;) {}
    if (workerData.then === "die") throw new Error("boom");
    parentPort.postMessage({ type: "finished" });
  `;
  return new Worker(code, { eval: true, workerData: { messages, then } });
}

function run(messages: RunnerMessage[], then: "hang" | "die" | "finish") {
  const failures: Failure[] = [];
  const done: number[] = [];
  const next = supervise({
    from: 5,
    start: () => fakeThread(messages, then),
    hangMs: 300,
    startupMs: 5000,
    onDone: (msg) => done.push(msg.index),
    onFailure: (f) => failures.push(f),
    onBroken: (err) => {
      throw err;
    },
  });
  return { next, failures, done };
}

const bytes = new Uint8Array([37, 80, 68, 70]);

describe("fuzz thread supervisor", () => {
  it("records a hung variant from the bytes it sent, and carries on after it", async () => {
    // From review: recording a hang used to make the variant again on the main thread, which
    // could hang the same way.
    const { next, failures } = run(
      [
        { type: "making", index: 5 },
        { type: "start", index: 5, bytes, label: "fixture:x with flipBytes" },
      ],
      "hang",
    );
    await expect(next).resolves.toBe(6);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.index).toBe(5);
    expect(failures[0]?.bytes).toEqual(bytes);
    expect(failures[0]?.label).toBe("fixture:x with flipBytes");
    expect(failures[0]?.problems[0]?.kind).toBe("too-slow");
  }, 20_000);

  it("records a hang while making a variant without its bytes", async () => {
    const { next, failures } = run([{ type: "making", index: 5 }], "hang");
    await expect(next).resolves.toBe(6);
    expect(failures[0]?.bytes).toBeNull();
  }, 20_000);

  it("records a thread that dies, and carries on after the variant", async () => {
    const { next, failures } = run(
      [
        { type: "making", index: 5 },
        { type: "start", index: 5, bytes, label: "x" },
      ],
      "die",
    );
    await expect(next).resolves.toBe(6);
    expect(failures[0]?.problems[0]?.kind).toBe("crash");
  }, 20_000);

  it("passes finished variants on and resumes where the thread stopped", async () => {
    const { next, failures, done } = run(
      [
        { type: "making", index: 5 },
        { type: "start", index: 5, bytes, label: "x" },
        { type: "done", index: 5, ms: 1, problems: [] },
      ],
      "finish",
    );
    await expect(next).resolves.toBe(6);
    expect(done).toEqual([5]);
    expect(failures).toEqual([]);
  }, 20_000);
});
