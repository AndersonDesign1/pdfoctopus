// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Size of MuPDF's .wasm file, so the loading bar can show real progress even when the
// server compresses the file (and so sends no usable Content-Length).
const requireFromCore = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const mupdfWasm = join(dirname(requireFromCore.resolve("mupdf")), "mupdf-wasm.wasm");

/**
 * Writes the list of built files into dist/sw.js so the service worker can cache the whole
 * app on install and delete files from older versions. Reads the output folder after the
 * build, so files from the worker sub-build (including MuPDF's .wasm) are included.
 */
function serviceWorkerPrecache(): Plugin {
  let outDir = "";
  return {
    name: "pdfoctopus:sw-precache",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const assets = readdirSync(join(outDir, "assets")).map((name) => `/assets/${name}`);
      // Top-level public files (e.g. the favicon). The page itself is cached as "/".
      const skip = new Set(["index.html", "sw.js", "_headers", "assets"]);
      const publicFiles = readdirSync(outDir)
        .filter((name) => !skip.has(name))
        .map((name) => `/${name}`);
      const swPath = join(outDir, "sw.js");
      const listMarker = '/* __PRECACHE__ */ ["/"]';
      const versionMarker = '/* __VERSION__ */ "dev"';
      let sw = readFileSync(swPath, "utf8");
      for (const marker of [listMarker, versionMarker]) {
        if (!sw.includes(marker)) throw new Error(`sw.js is missing the ${marker} marker`);
      }
      sw = sw.replace(listMarker, JSON.stringify(["/", ...publicFiles.sort(), ...assets.sort()]));
      // Any change to the worker or the file list gives a new version, and so a new cache.
      const version = createHash("sha256").update(sw).digest("hex").slice(0, 12);
      writeFileSync(swPath, sw.replace(versionMarker, JSON.stringify(version)));
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorkerPrecache()],
  // Tauri expects a fixed port and must see Rust errors in the terminal.
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  worker: { format: "es" },
  build: { target: "es2022" },
  define: { __MUPDF_WASM_SIZE__: JSON.stringify(statSync(mupdfWasm).size) },
  // MuPDF loads its own .wasm file at runtime; don't let Vite pre-bundle it.
  optimizeDeps: { exclude: ["mupdf"] },
});
