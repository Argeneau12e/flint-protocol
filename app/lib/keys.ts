/**
 * Keypair loading for the agent flow (Phase 2).
 *
 * SERVER-ONLY. Never import this from a client component: a bundled keypair is
 * a published keypair. Both keypairs are devnet throwaways (Sections 6.3 / 12),
 * and both live under `app/.keys/`, which is gitignored — a keypair must never
 * be committed, and a leaked one must never be silently reused.
 *
 * The two wallets have distinct roles and must not be confused (Section 4.5):
 *   - **service** = the recipient: proposes agreements, signs `create`;
 *   - **agent**   = the payer: signs `fund` (and `release` when it settles).
 * A build that paid from the recipient, or proposed from the agent, would break
 * the authority model — so the role is a required argument at every call site.
 */

import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

/** A loaded keypair plus the role it is allowed to play. */
export interface LoadedKeypair {
  keypair: Keypair;
  /** The address, resolved once, for logging and account derivation. */
  address: string;
  role: "service" | "agent";
}

/**
 * Loads a solana-keygen JSON keypair file.
 *
 * Validates that the file holds a 64-byte secret key. A 32-byte array is a
 * *public* key: loading it would produce a Keypair that cannot sign, and
 * failing here names the actual problem instead of surfacing as "signature
 * verification failed" deep inside a transaction send.
 */
export function loadKeypair(
  path: string,
  role: "service" | "agent",
): LoadedKeypair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(
      `Could not read the ${role} keypair at "${path}". ` +
        `Generate it with scripts/provision-devnet.mjs (or solana-keygen new). ` +
        `Original error: ${(cause as Error).message}`,
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 32) {
    throw new Error(
      `The ${role} keypair at "${path}" is not a 64-byte secret key ` +
        `(found ${Array.isArray(parsed) ? `${parsed.length} bytes` : "a non-array file"}). ` +
        `A 32-byte array is a public key and cannot sign.`,
    );
  }
  if (parsed.length !== 64) {
    throw new Error(
      `The ${role} keypair at "${path}" has ${parsed.length} bytes; a solana keypair is 64.`,
    );
  }

  const keypair = Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  return { keypair, address: keypair.publicKey.toBase58(), role };
}
