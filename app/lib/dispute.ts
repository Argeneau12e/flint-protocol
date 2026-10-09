/** Dispute client utilities (Phase 5a / Task 2)
 *
 * Maps reason codes through DISPUTE_REASON_CODES, decides who may dispute, and
 * answers the arbiter-queue question: is the connected wallet the Config's
 * arbiter, and does it have anything to rule on? The arbiter identity is read
 * from the on-chain Config, never hardcoded, and resolution is signed by the
 * arbiter's own wallet — there is no server-held key.
 */

import { PublicKey, type Connection } from "@solana/web3.js";
import { DisputeReason, DISPUTE_REASON_CODES } from "./frs1-types";
import type { AgreementStatus } from "./frs1-types";
import { readConfig } from "./flint-program";

/** Map a human-readable reason code to the on-chain discriminant (1..=5). */
export function reasonCodeToDiscriminant(reason: DisputeReason): number {
  return DISPUTE_REASON_CODES[reason];
}

/** Map the on-chain discriminant (1..=5) to a human-readable reason. */
export function discriminantToReasonCode(code: number): DisputeReason | undefined {
  return (Object.keys(DISPUTE_REASON_CODES) as DisputeReason[]).find(
    (reason) => DISPUTE_REASON_CODES[reason] === code,
  );
}

/** Build the `dispute` transaction parameters.
 *
 * The caller must ensure the agreement is disputable: it is in
 * `deliveryClaimed` (a claim inside the review window) and the signer is the
 * stored payer. `program.methods.dispute` takes the Anchor enum variant
 * `{ [reason]: {} }`; the on-chain code is the variant index, which
 * `DISPUTE_REASON_CODES` documents as 1..=5.
 */
export interface DisputeParams {
  /** Human-readable reason (mapped to the on-chain discriminant). */
  reason: DisputeReason;
}

/** The Anchor enum object `dispute` expects for a reason. */
export function disputeReasonArg(reason: DisputeReason): { [k: string]: Record<string, never> } {
  return { [reason]: {} };
}

/** Check whether a connected wallet can dispute this agreement.
 *
 * Only the stored payer may dispute a delivery claim (the program enforces this
 * too — `dispute` is payer-signed). The arbiter resolves; it does not dispute.
 * A terminal agreement is never disputable.
 */
export function canDispute(
  agreement: { status: AgreementStatus; payerAddress: string | null; recipientAddress: string },
  connectedAddress: string | null,
): { ok: boolean; reason?: string } {
  const terminal: AgreementStatus[] = ["released", "refunded", "cancelled", "split"];
  if (terminal.includes(agreement.status)) {
    return { ok: false, reason: "agreement_terminal" };
  }
  if (agreement.status !== "deliveryClaimed") {
    return { ok: false, reason: "no_claim_to_dispute" };
  }
  if (!connectedAddress) {
    return { ok: false, reason: "no_wallet_connected" };
  }
  if (agreement.payerAddress === null || connectedAddress !== agreement.payerAddress) {
    return { ok: false, reason: "payer_only" };
  }
  return { ok: true };
}

export interface ArbiterStatus {
  /** True when the connected wallet is the Config's stored arbiter. */
  isArbiter: boolean;
  /** The Config's arbiter address, or null when Config could not be read. */
  arbiter: string | null;
  /**
   * Agreements in `Disputed` state that the arbiter may rule on. Populated by
   * the caller (which enumerates them); this helper only decides *whether* the
   * connected wallet is the arbiter, so the queue is never shown to anyone else.
   */
  queue: DisputedSummary[];
}

/** One disputed agreement in the arbiter's queue. */
export interface DisputedSummary {
  address: string;
  /** Unix seconds: the arbiter must rule before this, or anyone may split. */
  arbiterDeadline: number;
}

/**
 * Read the Config and decide whether `connectedAddress` is the arbiter.
 *
 * The queue itself is the caller's to supply (enumerating disputed agreements
 * requires an indexer this build does not have); this function gates it — the
 * queue is returned non-empty only when the connected wallet *is* the Config's
 * arbiter, so a non-arbiter never sees another party's disputes. No server-held
 * key: the arbiter rules by signing `resolve_dispute` with its own wallet.
 */
export async function getArbiterStatus(
  connection: Connection,
  programId: PublicKey,
  connectedAddress: string | null,
  disputed: DisputedSummary[] = [],
): Promise<ArbiterStatus> {
  const config = await readConfig(connection, programId).catch(() => null);
  const arbiter = config ? config.arbiter.toBase58() : null;
  const isArbiter =
    arbiter !== null && connectedAddress !== null && connectedAddress === arbiter;
  return { isArbiter, arbiter, queue: isArbiter ? disputed : [] };
}

/** Parameters for the arbiter's `resolve_dispute` ruling. */
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