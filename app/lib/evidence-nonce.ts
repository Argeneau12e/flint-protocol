/**
 * Upload nonces — server-signed, short-lived, stateless.
 *
 * The upload route proves the request comes from the agreement's *recipient*
 * by checking an ed25519 signature over a message that includes a nonce the
 * server minted. The nonce is what makes that signature time-boxed: it carries
 * its own expiry and is bound to one agreement by an HMAC-SHA256 tag under a
 * server secret (`FLINT_NONCE_SECRET`), so a nonce minted for agreement A
 * verifies nowhere else, a tampered expiry or agreement fails the tag, and
 * anything past `NONCE_TTL_SECONDS` is refused as expired.
 *
 * Verification needs no storage, so any server instance can check a nonce
 * another instance issued — the property a serverless host needs. Within the
 * five-minute life the same nonce can be presented more than once; each use
 * still requires the recipient's signature over this exact message, so a
 * replay can only repeat an upload the recipient already authorized, and it
 * dies with the expiry regardless.
 *
 * `uploadSignMessage` is imported by a client component, so this module must
 * stay browser-safe: HMAC uses Web Crypto (async), never `node:crypto`.
 */

/** How long an issued nonce stays valid. */
export const NONCE_TTL_SECONDS = 5 * 60;

/** The message a recipient signs: `flint-evidence-upload:<agreement>:<nonce>`. */
export function uploadSignMessage(agreement: string, nonce: string): string {
  return `flint-evidence-upload:${agreement}:${nonce}`;
}

/**
 * Thrown when `FLINT_NONCE_SECRET` is missing or empty. The routes translate
 * this into a clear JSON error instead of a stack trace.
 */
export class MissingNonceSecretError extends Error {
  constructor() {
    super("FLINT_NONCE_SECRET is not set on the server.");
    this.name = "MissingNonceSecretError";
  }
}

/** The server secret, or a clear error when it has not been configured. */
function serverSecret(): string {
  const secret = process.env.FLINT_NONCE_SECRET;
  if (secret === undefined || secret === "") throw new MissingNonceSecretError();
  return secret;
}

const encoder = new TextEncoder();

function randomValue(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The tag over `data` under the server secret. Web Crypto: works in Node 20+ and browsers. */
async function hmacTag(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(serverSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return base64Url(new Uint8Array(signature));
}

/** The signed payload: agreement + random + expiry, so all three are bound together. */
function payload(agreement: string, value: string, expiresAt: number): string {
  return `flint-upload-nonce:${agreement}:${value}:${expiresAt}`;
}

/** Constant-time-ish string equality (length-independent XOR fold). */
function sameTag(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a fresh nonce for `agreement`: `random.expiry.tag`, verifiable without
 * any server-side record. Returns the nonce and its expiry so the caller can
 * sign before it lapses. `nowSeconds` is injectable for tests.
 */
export async function issueNonce(
  agreement: string,
  nowSeconds: number = Date.now() / 1000,
): Promise<{ nonce: string; expiresAt: number }> {
  const value = randomValue();
  const expiresAt = Math.floor(nowSeconds) + NONCE_TTL_SECONDS;
  const tag = await hmacTag(payload(agreement, value, expiresAt));
  return { nonce: `${value}.${expiresAt}.${tag}`, expiresAt };
}

export type NonceCheck = "ok" | "unknown" | "expired";

/**
 * Verify a nonce against `agreement`: well-formed, unexpired, and carrying a
 * valid tag for *this* agreement under the server secret. A tampered value,
 * expiry or agreement fails the tag and reports "unknown". `nowSeconds` is
 * injectable for tests.
 */
export async function consumeNonce(
  agreement: string,
  nonce: string,
  nowSeconds: number = Date.now() / 1000,
): Promise<NonceCheck> {
  serverSecret(); // Missing secret is a configuration error, reported as such.
  const parts = nonce.split(".");
  if (parts.length !== 3) return "unknown";
  const [value, expiryRaw, tag] = parts as [string, string, string];
  if (value === "" || tag === "") return "unknown";
  const expiresAt = Number(expiryRaw);
  if (!Number.isInteger(expiresAt)) return "unknown";
  const expected = await hmacTag(payload(agreement, value, expiresAt));
  if (!sameTag(expected, tag)) return "unknown";
  if (Math.floor(nowSeconds) >= expiresAt) return "expired";
  return "ok";
}
