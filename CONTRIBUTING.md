# Contributing to PDFoctopus

Thanks for helping! PDFoctopus is early-stage. Check [PHASES.md](./PHASES.md) to see what is
being worked on.

## Getting started

Requirements: [Bun](https://bun.sh) 1.3+, Node.js 22+, and (for the desktop app only)
[Rust](https://rustup.rs) plus the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
bun install
```

```bash
bun run dev        # web app at http://localhost:5173
```

```bash
bun run check      # lint + typecheck + tests (run before every PR)
```

```bash
bun run desktop    # desktop app (needs Rust + Tauri prerequisites)
```

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/). There is no CLA.
Every commit must be signed off, which certifies you wrote it or otherwise have the right to
submit it under the project licence:

```bash
git commit -s -m "Your message"
```

This adds a line like `Signed-off-by: Your Name <you@example.com>` to the commit.

## Licence headers

The project is licensed under **AGPL-3.0-or-later**. Start every new source file with:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
```

(Use `#` comments in Rust config / TOML / shell files, `//` in Rust source.)

## Pull requests

- Keep each PR focused on one change.
- `bun run check` must pass.
- If your change completes a task in [PHASES.md](./PHASES.md), tick its box in the same PR.
