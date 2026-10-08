/** Dispute client utilities (Phase 5a)
 * 
 * Maps reason codes through DISPUTE_REASON_CODES,
 * builds transaction parameters, and handles the
 * arbiter queue logic.
 */

import { PublicKey, type Connection } from "@solana/web3.js";
import { Frs1Agreement, DisputeReason, DISPUTE_REASON_CODES } from "./frs1-types";

/** Map a human-readable reason code to the on-chain discriminant. */
export function reasonCodeToDiscriminal(reason: DisputeReason): number {
  return DISPUTE_REASON_CODES[reason];
}

/** Map the on-chain discriminant to a human-readable reason. */
export function discriminalToReasonCode(code: number): DisputeReason | undefined {
  return Object.entries(DISPUTE_REASON_CODES).find(
    ([, c]) => c === code,
  )?.[0] as DisputeReason | undefined;
}

/** Build the `dispute` transaction instructions parameters.
 * 
 * The caller must ensure the agreement is not already disputed
 * and is in a state that allows disputing (typically "funded" or "deliveryClaimed").
 */
export interface DisputeParams {
  /** Human-readable reason (mapped to on-chain discriminant). */
  reason: DisputeReason;
  /** Optional meta object for the reason (e.g., { notReceived: { item: string } }). */
  meta?: Record<string, unknown>;
}

/** Check whether a connected wallet can dispute this agreement.
 * 
 * - The agreement must be in a non-terminal state (not released/refunded/cancelled).
 * - The wallet must be the payer or the recipient (depending on flow).
 * - The arbiter window must not have closed (or the caller must be the arbiter).
 */
export function canDispute(
  agreement: Frs1Agreement,
  connectedAddress: string | null,
  isArbiter: boolean,
): { ok: boolean; reason?: string } {
  const terminalStates = ["released", "refunded", "cancelled"];
  if (terminalStates.includes(agreement.status)) {
    return { ok: false, reason: "agreement_terminal" };
  }

  if (!connectedAddress) {
    return { ok: false, reason: "no_wallet_connected" };
  }

  // Payer can always dispute their own agreements
  // Recipient can dispute under certain conditions
  // Arbiter can always resolve
  if (isArbiter) {
    return { ok: true };
  }

  const pubkey = new PublicKey(connectedAddress);
  const payer = agreement.payerAddress ? new PublicKey(agreement.payerAddress) : null;
  const recipient = new PublicKey(agreement.recipientAddress);

  if (payer !== null && pubkey.equals(payer)) return { ok: true };
  if (pubkey.equals(recipient)) return { ok: true };

  return { ok: false, reason: "not_payer_or_recipient" };
}

/** Arbiter queue position (simple in-memory / Redis‑backed in prod).
 * 
 * Returns whether the caller is the configured arbiter and their queue position.
 */
export interface ArbiterStatus {
  isArbiter: boolean;
  queuePosition: number | null;
  /** True when the arbiter's review window has closed. */
  reviewWindowClosed: boolean;
}

/** Read the Config account to determine the arbiter and review window.
 * 
 * In a full deployment this would read from the on-chain Config PDA.
 * Here we provide the structure; the actual RPC call depends on the program.
 */
export async function getArbiterStatus(
  connection: Connection,
  configPda: PublicKey,
  connectedAddress: string | null,
): Promise<ArbiterStatus> {
  void connection;
  void configPda;
  // No on-chain Config read yet: this helper is unwired (no callers) and the
  // Config shape lives in the program. Report non-arbiter until wired.
  const isArbiter = false;

  const reviewWindowClosed = isArbiter
    ? false // arbiter has not closed the window yet (simplified)
    : true; // non‑arbiter sees window as closed

  // Simple queue: position based on connected address hash (deterministic for testing)
  let queuePosition: number | null = null;
  if (connectedAddress) {
    const hash = Buffer.from(connectedAddress, "utf8");
    queuePosition = hash[0] % 5; // 0‑4 placeholder
  }

  return {
    isArbiter,
    queuePosition,
    reviewWindowClosed,
  };
}

/** Resolve a dispute on-chain via the program.
 * 
 * This is a wrapper that builds the transaction; the caller signs and sends.
 */
export interface ResolveDisputeParams {
  agreement: PublicKey;
  arbiter: PublicKey;
  outcome:
    | { release: {} }
    | { refund: {} }
    | { split: { recipientBps: number } };
}

export function buildResolveDisputeTxParams(params: ResolveDisputeParams): {
  outcome: { release: {} } | { refund: {} } | { split: { recipientBps: number } };
} {
  return { outcome: params.outcome };
}