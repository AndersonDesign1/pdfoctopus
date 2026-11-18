// SPDX-License-Identifier: AGPL-3.0-or-later

// Points git at .githooks so the pre-push hook runs. Called by the "prepare" script on every
// `bun install`. Plain Node APIs so it works the same on Windows, macOS and Linux. Does
// nothing (and never fails the install) outside a git checkout, e.g. a source tarball.

import { spawnSync } from "node:child_process";

const inRepo = spawnSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" }).status === 0;
if (inRepo) {
  spawnSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
}
