/**
 * Payer email captured at creation (task item 10).
 *
 * The on-chain agreement has no email field — it is a fixed account layout — so
 * the optional payer address a creator enters lives here instead: a small JSON
 * store keyed by the agreement's uuid (the same uuid minted at creation and
 * returned to the creator). The evidence-upload path looks it up when it is time
 * to notify, and skips silently when there is no entry, no email, or no
 * `RESEND_API_KEY`.
 *
 * Deliberately off-chain and best-effort: an email is a notification, never an
 * authorization. Nothing in the protocol reads this file, and losing it (a new
 * deployment, a cleared `.data` directory) only means a payer is not emailed —
 * never that a payment is misrouted. The store follows the `decisions.jsonl`
 * pattern: a plain file under the gitignored `.data` directory, read and written
 * as a whole (it is small), no database.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isEmailAddress } from "./notify";

/** uuid -> payer email. */
type EmailMap = Record<string, string>;

/** The store file, under the gitignored `.data` directory of the repo root. */
function storePath(): string {
  const fromEnv = process.env.FLINT_PAYER_EMAIL_STORE;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return resolve(process.cwd(), fromEnv.trim());
  }
  return resolve(process.cwd(), ".data", "payer-emails.json");
}

function readStore(): EmailMap {
  const path = storePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: EmailMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    // A corrupt store must not fail agreement creation: an unemailed payer is
    // an acceptable loss, a 500 on create is not.
    return {};
  }
}

/**
 * Record the payer email for `agreementId`. Returns false (and records nothing)
 * when the address is not a plausible email — a creator typo must not become a
 * stored address that later bounces at the worst moment.
 */
export function recordPayerEmail(agreementId: string, email: string): boolean {
  const trimmed = email.trim();
  if (!isEmailAddress(trimmed)) return false;
  const store = readStore();
  store[agreementId] = trimmed;
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return true;
}

/** The recorded payer email for `agreementId`, or null when there is none. */
export function getPayerEmail(agreementId: string): string | null {
  return readStore()[agreementId] ?? null;
}

/** Test-only: point the store at a temporary path. */
export function setPayerEmailStorePath(path: string): void {
  process.env.FLINT_PAYER_EMAIL_STORE = path;
}
