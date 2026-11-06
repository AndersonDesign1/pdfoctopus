// SPDX-License-Identifier: AGPL-3.0-or-later

import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Size of MuPDF's .wasm file, so the loading bar can show real progress even when the
// server compresses the file (and so sends no usable Content-Length).
const requireFromCore = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const mupdfWasm = join(dirname(requireFromCore.resolve("mupdf")), "mupdf-wasm.wasm");

export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port and must see Rust errors in the terminal.
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  worker: { format: "es" },
  build: { target: "es2022" },
  define: { __MUPDF_WASM_SIZE__: JSON.stringify(statSync(mupdfWasm).size) },
  // MuPDF loads its own .wasm file at runtime; don't let Vite pre-bundle it.
  optimizeDeps: { exclude: ["mupdf"] },
});
