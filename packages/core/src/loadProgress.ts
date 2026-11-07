// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reports download progress for MuPDF's WebAssembly file (about 10 MB).
//
// MuPDF's loader fetches the .wasm itself, so we wrap `fetch` while it loads: responses for
// .wasm files are passed through a counting stream. The response keeps its headers, so
// MuPDF can still use streaming compilation.

import type { LoadProgress } from "./protocol";

type Fetch = typeof fetch;

/**
 * The expected size of a response body, if the server told us. When the response is
 * compressed, Content-Length is the compressed size, which we can't compare against the
 * decompressed bytes we count, so it is ignored.
 */
export function expectedBodySize(headers: Headers, fallback: number | null): number | null {
  const encoding = headers.get("content-encoding");
  const length = Number(headers.get("content-length"));
  if ((!encoding || encoding === "identity") && Number.isFinite(length) && length > 0) {
    return length;
  }
  return fallback;
}

function isWasmRequest(input: Parameters<Fetch>[0]): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(url, "http://x/").pathname.endsWith(".wasm");
}

/**
 * Return a `fetch` that reports progress for .wasm downloads and passes everything else
 * through unchanged. `expectedSize` is used when the server doesn't give a usable length.
 */
export function withWasmProgress(
  baseFetch: Fetch,
  onProgress: (progress: LoadProgress) => void,
  expectedSize: number | null = null,
): Fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!isWasmRequest(input) || !response.ok || !response.body) return response;

    const total = expectedBodySize(response.headers, expectedSize);
    let loaded = 0;
    onProgress({ loaded, total });
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        onProgress({ loaded, total });
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(counter), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
