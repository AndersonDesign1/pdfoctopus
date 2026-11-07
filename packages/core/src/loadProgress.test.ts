// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { EngineCrashedError, EngineLoadError, errorCode, errorFromCode } from "./errors";
import { expectedBodySize, withWasmProgress } from "./loadProgress";
import type { LoadProgress } from "./protocol";

function fakeFetch(body: Uint8Array[], headers: Record<string, string>): typeof fetch {
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of body) controller.enqueue(chunk);
          controller.close();
        },
      }),
      { headers },
    );
}

describe("withWasmProgress", () => {
  it("reports progress for .wasm downloads and keeps the body and headers", async () => {
    const events: LoadProgress[] = [];
    const wrapped = withWasmProgress(
      fakeFetch([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7, 8])], {
        "content-type": "application/wasm",
        "content-length": "8",
      }),
      (p) => events.push(p),
    );
    const res = await wrapped("https://example.com/assets/mupdf-wasm-abc.wasm");
    expect(res.headers.get("content-type")).toBe("application/wasm");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events).toEqual([
      { loaded: 0, total: 8 },
      { loaded: 3, total: 8 },
      { loaded: 8, total: 8 },
    ]);
  });

  it("leaves other requests alone", async () => {
    const events: LoadProgress[] = [];
    const wrapped = withWasmProgress(fakeFetch([new Uint8Array(4)], {}), (p) => events.push(p));
    await (await wrapped("https://example.com/app.js")).arrayBuffer();
    expect(events).toEqual([]);
  });
});

describe("expectedBodySize", () => {
  it("uses Content-Length for uncompressed responses", () => {
    expect(expectedBodySize(new Headers({ "content-length": "100" }), 5)).toBe(100);
  });

  it("falls back when the response is compressed or has no length", () => {
    const compressed = new Headers({ "content-length": "40", "content-encoding": "br" });
    expect(expectedBodySize(compressed, 100)).toBe(100);
    expect(expectedBodySize(new Headers(), null)).toBeNull();
  });
});

describe("engine errors", () => {
  it("treats a WebAssembly trap as a crash", () => {
    expect(errorCode(new WebAssembly.RuntimeError("unreachable"))).toBe("engine-crashed");
  });

  it("round-trips fatal errors across the worker boundary", () => {
    expect(errorFromCode(errorCode(new EngineCrashedError()), "x")).toBeInstanceOf(
      EngineCrashedError,
    );
    expect(errorFromCode(errorCode(new EngineLoadError()), "x")).toBeInstanceOf(EngineLoadError);
  });
});
