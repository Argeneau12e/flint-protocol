/**
 * Solana cluster configuration.
 *
 * Flint is devnet-only for this entire build (FLINT_BUILD_CONTEXT.md Sections
 * 6.3 and 12): nothing here may reference a mainnet key or touch mainnet.
 *
 * PHASE 0 SCOPE: configuration and a connection factory only. No instruction
 * builders, no wallet wiring, no data fetching.
 */

import { Connection, clusterApiUrl } from "@solana/web3.js";

/** The only cluster this build talks to. */
export const CLUSTER = "devnet" as const;

/**
 * Devnet RPC endpoint. Override with NEXT_PUBLIC_SOLANA_RPC_URL (see
 * `.env.example`); defaults to the public devnet endpoint.
 */
export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? clusterApiUrl("devnet");

/**
 * Guard rail, not decoration: the whole build is devnet-only, so a mainnet
 * endpoint in configuration is a bug we want to fail loudly on rather than
 * silently transact against.
 */
if (/mainnet/i.test(RPC_URL)) {
  throw new Error(
    "Flint is devnet-only in v1 — refusing to configure a mainnet RPC endpoint.",
  );
}

/** Commitment used for all reads and writes in this build. */
export const COMMITMENT = "confirmed" as const;

/** A connection to the configured devnet RPC. */
export function getConnection(): Connection {
  return new Connection(RPC_URL, COMMITMENT);
}

/** Solana Explorer link for a transaction signature (devnet). */
export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`;
}

/** Solana Explorer link for an address (devnet). */
export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=${CLUSTER}`;
}
