/**
 * Loads the environment the test suites run against, before they start.
 *
 * Plain node does not load `app/.env.local` the way Next.js does, and these
 * tests deliberately exercise the *same* modules the app does — so without
 * this, the tests would run against a different configuration than the app and
 * could pass for the wrong reason. Load order decides priority:
 *
 *   1. `tests/.env.test` — pins the suites to the throwaway test mint (TST);
 *      the demo asset (Circle devnet USDC) must never be what automated tests
 *      mint or spend (Phase 5a);
 *   2. `app/.env.local`, then `app/.env` — the app's own configuration, for
 *      everything the test pin does not cover (program id, keypairs, price).
 *
 * Existing environment variables always win over every file, so a CI secret is
 * never overwritten by a local file.
 *
 * `process.cwd()` rather than `__dirname`: these files are loaded as ES modules
 * (Node's own type stripping), where `__dirname` does not exist. Mocha is always
 * run from the repo root, so the cwd is the right base either way.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();

for (const file of [
  resolve(repoRoot, "tests", ".env.test"),
  resolve(repoRoot, "app", ".env.local"),
  resolve(repoRoot, "app", ".env"),
]) {
  if (!existsSync(file)) continue;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
