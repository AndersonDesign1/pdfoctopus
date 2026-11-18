# Notes for AI coding agents

Read [CONTRIBUTING.md](./CONTRIBUTING.md) and the "Next up" section of [PHASES.md](./PHASES.md)
first. The rules below are the ones that have been broken before.

## Hard rules

- **Never push to `main`**, not even a one-line docs change. Push a branch and open a pull
  request. A docs commit pushed straight to `main` on 2026-11-10 failed the formatting check
  and left `main` red for a week, which also failed every Dependabot PR.
- **Never merge, or suggest merging, a PR whose CI is not fully green** (`web`, `desktop` and
  `signatures`). A red `main` is fixed before any other work.
- **Run `bun run check` before every push.** It runs lint (Biome formats Markdown too),
  typecheck and tests. `bun run format` fixes formatting.
- Sign off every commit: `git commit -s`.
- Start new source files with `SPDX-License-Identifier: AGPL-3.0-or-later`.
- Saving must stay incremental unless the user agreed to a rewrite, and files never leave the
  user's device without explicit consent.

## Dependabot PRs

Minor and patch updates: merge once CI is green. Major updates: check them locally first
(`bun run check` and `bun run build` on the PR branch). If a Dependabot PR fails, look at
whether `main` fails the same way before blaming the update.
