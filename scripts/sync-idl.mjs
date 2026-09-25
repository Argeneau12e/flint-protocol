/**
 * Copies the generated Anchor IDL into the app, so the app can build transactions
 * against the same interface the program was built from.
 *
 * The IDL is an artifact: it is produced by `anchor build` (or `anchor program
 * deploy`) and must never be hand-edited. This script exists so that "rebuild the
 * program" and "the app sees the new interface" cannot drift apart silently — run
 * it after every program change.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(repoRoot, "target", "idl", "flint_escrow.json");
const destination = resolve(repoRoot, "app", "lib", "idl", "flint_escrow.json");

if (!existsSync(source)) {
  console.error(
    `No IDL at ${source}. Run \`anchor build\` (WSL) before syncing, or \`anchor program deploy\`, which writes it.`,
  );
  process.exit(1);
}

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`Synced IDL -> ${destination}`);
