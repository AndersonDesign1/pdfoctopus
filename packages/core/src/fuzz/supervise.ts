// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Watching a fuzzing thread (runner.ts) from the main thread: it reports each variant, and a
// variant that crashes the thread or stops it answering is recorded and the thread replaced.
// The thread sends each variant's bytes before running it, so recording a hang or crash only
// writes what's already here: nothing that could hang again runs on the main thread.

import type { Problem } from "./drive";

export type RunnerMessage =
  /** About to make variant `index` (a hang now is in making it, not in the engine). */
  | { type: "making"; index: number }
  /** About to run variant `index`: its bytes and what it is, kept in case it hangs. */
  | { type: "start"; index: number; bytes: Uint8Array; label: string }
  | { type: "done"; index: number; ms: number; problems: Problem[] }
  | { type: "finished" };

/** What can't be lost if the thread hangs or dies: the variant it was on. */
export interface Failure {
  index: number;
  /** Null when it hung or died while making the variant (before its bytes were sent). */
  bytes: Uint8Array | null;
  label: string;
  problems: Problem[];
}

/** The parts of a worker thread used here (node:worker_threads' Worker has them). */
export interface ThreadLike {
  on(event: "message", listener: (msg: RunnerMessage) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: () => void): unknown;
  terminate(): unknown;
}

export interface SuperviseOptions {
  /** Start the thread for variants from `from` on. */
  start(from: number): ThreadLike;
  from: number;
  /** A variant that takes this long (with no message) has hung. */
  hangMs: number;
  /** How long a new thread may take to send its first message. */
  startupMs: number;
  onDone(msg: Extract<RunnerMessage, { type: "done" }>, label: string, bytes: Uint8Array): void;
  onFailure(failure: Failure): void;
  /** The thread died before running anything: the fuzzer itself is broken. */
  onBroken(err: Error): void;
}

/** Run one thread until it finishes, hangs or dies; resolves to the next variant to run. */
export function supervise(options: SuperviseOptions): Promise<number> {
  return new Promise((done) => {
    const thread = options.start(options.from);
    let current = options.from;
    let bytes: Uint8Array | null = null;
    let label = `variant ${current} (while making it)`;
    let started = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (next: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void thread.terminate();
      done(next);
    };
    const fail = (kind: Problem["kind"], message: string) => {
      options.onFailure({
        index: current,
        bytes,
        label,
        problems: [{ kind, op: "variant", message }],
      });
      finish(current + 1);
    };
    const watch = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail("too-slow", `no answer in ${ms} ms (hung)`), ms);
    };
    watch(options.startupMs);
    thread.on("message", (msg) => {
      // Messages still queued from a thread that was given up on.
      if (finished) return;
      started = true;
      watch(options.hangMs);
      if (msg.type === "making") {
        current = msg.index;
        bytes = null;
        label = `variant ${msg.index} (while making it)`;
      } else if (msg.type === "start") {
        current = msg.index;
        bytes = msg.bytes;
        label = msg.label;
      } else if (msg.type === "done") {
        options.onDone(msg, label, bytes ?? new Uint8Array());
        current = msg.index + 1;
        bytes = null;
      } else {
        finish(current);
      }
    });
    thread.on("error", (err) => {
      if (finished) return;
      if (!started) {
        finished = true;
        clearTimeout(timer);
        options.onBroken(err);
        done(current);
        return;
      }
      fail("crash", `the thread died: ${err.message}`);
    });
    thread.on("exit", () => {
      if (!finished) fail("crash", "the thread exited");
    });
  });
}
