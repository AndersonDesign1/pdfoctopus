// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { RenderCancelledError, RenderQueue } from "./renderQueue";

/** A render function whose calls complete only when the test says so. */
function controlledRun() {
  const calls: { index: number; finish: () => void }[] = [];
  const run = (index: number) =>
    new Promise<string>((resolve) => {
      calls.push({ index, finish: () => resolve(`page ${index}`) });
    });
  return { run, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("RenderQueue", () => {
  it("runs one job at a time, highest priority first", async () => {
    const { run, calls } = controlledRun();
    const queue = new RenderQueue(run);
    const a = queue.request({ key: "a", index: 1, scale: 1, priority: 1 });
    queue.request({ key: "b", index: 2, scale: 1, priority: 1 });
    queue.request({ key: "c", index: 3, scale: 1, priority: 0 });
    expect(calls.map((c) => c.index)).toEqual([1]);
    calls[0]?.finish();
    expect(await a).toBe("page 1");
    await tick();
    // "c" has a higher priority than "b", which was requested earlier.
    expect(calls.map((c) => c.index)).toEqual([1, 3]);
  });

  it("shares one render between duplicate requests", async () => {
    const { run, calls } = controlledRun();
    const queue = new RenderQueue(run);
    const first = queue.request({ key: "a", index: 1, scale: 1, priority: 1 });
    const second = queue.request({ key: "a", index: 1, scale: 1, priority: 0 });
    calls[0]?.finish();
    expect(await first).toBe("page 1");
    expect(await second).toBe("page 1");
    expect(calls).toHaveLength(1);
  });

  it("drops queued jobs that are no longer wanted", async () => {
    const { run, calls } = controlledRun();
    const queue = new RenderQueue(run);
    queue.request({ key: "a", index: 1, scale: 1, priority: 0 });
    const b = queue.request({ key: "b", index: 2, scale: 1, priority: 0 });
    const c = queue.request({ key: "c", index: 3, scale: 1, priority: 0 });
    queue.retain((job) => job.key !== "b");
    await expect(b).rejects.toBeInstanceOf(RenderCancelledError);
    calls[0]?.finish();
    await tick();
    expect(calls.map((x) => x.index)).toEqual([1, 3]);
    calls[1]?.finish();
    expect(await c).toBe("page 3");
    await tick();
    expect(queue.size).toBe(0);
  });

  it("keeps going after a failed render", async () => {
    let n = 0;
    const queue = new RenderQueue(async (index: number) => {
      n++;
      if (index === 1) throw new Error("bad page");
      return "ok";
    });
    const bad = queue.request({ key: "a", index: 1, scale: 1, priority: 0 });
    const good = queue.request({ key: "b", index: 2, scale: 1, priority: 0 });
    await expect(bad).rejects.toThrow("bad page");
    expect(await good).toBe("ok");
    expect(n).toBe(2);
  });
});
