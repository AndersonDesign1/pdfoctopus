// SPDX-License-Identifier: AGPL-3.0-or-later

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port and must see Rust errors in the terminal.
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  worker: { format: "es" },
  build: { target: "es2022" },
  // MuPDF loads its own .wasm file at runtime; don't let Vite pre-bundle it.
  optimizeDeps: { exclude: ["mupdf"] },
});
