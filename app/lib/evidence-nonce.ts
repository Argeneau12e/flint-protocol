/**
 * Upload nonces — server-issued, single-use, short-lived.
 *
 * The upload route proves the request comes from the agreement's *recipient*
 * by checking an ed25519 signature over a message that includes a nonce the
 * server minted. The nonce is what makes that signature non-replayable: it is
 * single-use (consumed on first successful verification) and expires after
 * `NONCE_TTL_SECONDS`, so a captured signature is worthless once spent or once
 * stale.
 *
 * In-memory and per-process, exactly like `lib/throttle.ts`: this is a devnet
 * single-process demo, and the failure mode of a restart (nonces cleared) only
 * forces a client to request a fresh one. The map is bounded and swept on
 * access so it cannot grow without limit.
 */

import { webcrypto } from "node:crypto";

/** How long an issued nonce stays valid. */
export const NONCE_TTL_SECONDS = 5 * 60;

/** The message a recipient signs: `flint-evidence-upload:<agreement>:<nonce>`. */
export function uploadSignMessage(agreement: string, nonce: string): string {
  return `flint-evidence-upload:${agreement}:${nonce}`;
}

interface NonceRecord {
  /** Unix seconds when the nonce stops being valid. */
  expiresAt: number;
  /** True once the nonce has been spent by a successful verification. */
  used: boolean;
}

/** agreement -> nonce -> record. Keyed by agreement so a nonce is scoped to it. */
const nonces = new Map<string, Map<string, NonceRecord>>();

/** Bounded so a flood of `POST /nonce` cannot grow the map without limit. */
const MAX_AGREEMENTS = 5_000;

const cryptoObj: Crypto = webcrypto as unknown as Crypto;

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  cryptoObj.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Drop every expired nonce for one agreement, and spent ones with them. */
function sweep(nowSeconds: number): void {
  for (const [agreement, bucket] of nonces) {
    for (const [nonce, record] of bucket) {
      if (record.used || nowSeconds >= record.expiresAt) bucket.delete(nonce);
    }
    if (bucket.size === 0) nonces.delete(agreement);
  }
}

/**
 * Issue a fresh nonce for `agreement`. Returns the nonce and its expiry so the
 * caller can sign before it lapses. `nowSeconds` is injectable for tests.
 */
export function issueNonce(
  agreement: string,
  nowSeconds: number = Date.now() / 1000,
): { nonce: string; expiresAt: number } {
  if (nonces.size >= MAX_AGREEMENTS) sweep(nowSeconds);
  const nonce = randomNonce();
  const expiresAt = Math.floor(nowSeconds) + NONCE_TTL_SECONDS;
  let bucket = nonces.get(agreement);
  if (bucket === undefined) {
    bucket = new Map();
    nonces.set(agreement, bucket);
  }
  bucket.set(nonce, { expiresAt, used: false });
  return { nonce, expiresAt };
}

export type NonceCheck = "ok" | "unknown" | "expired" | "used";

/**
 * Consume a nonce: returns "ok" exactly once for a valid, unexpired, unused
 * nonce, and marks it used. Every later attempt, and any attempt after expiry,
 * returns a non-"ok" reason. `nowSeconds` is injectable for tests.
 */
export function consumeNonce(
  agreement: string,
  nonce: string,
  nowSeconds: number = Date.now() / 1000,
): NonceCheck {
  const bucket = nonces.get(agreement);
  if (bucket === undefined) return "unknown";
  const record = bucket.get(nonce);
  if (record === undefined) return "unknown";
  if (record.used) return "used";
  if (nowSeconds >= record.expiresAt) {
    bucket.delete(nonce);
    return "expired";
  }
  record.used = true;
  return "ok";
}

/** Test-only: clear every nonce so one test cannot satisfy another's replay. */
export function resetNonces(): void {
  nonces.clear();
}
