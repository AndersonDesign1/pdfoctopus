// SPDX-License-Identifier: AGPL-3.0-or-later

// Points git at .githooks so the pre-push hook runs. Called by the "prepare" script on every
// `bun install`. Plain Node APIs so it works the same on Windows, macOS and Linux. Does
// nothing outside this project's own git checkout (a source tarball, or a copy of the project
// sitting inside some other repository), so it never changes another repository's settings.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

const projectRoot = realpathSync(process.cwd());
const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
const repoRoot = top.status === 0 ? realpathSync(top.stdout.trim()) : null;

if (repoRoot === projectRoot) {
  const result = spawnSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error("Could not set up the git hooks: `git config core.hooksPath .githooks` failed.");
    process.exit(1);
  }
}
