/**
 * Derived agreement state and viewer role (task item 2).
 *
 * The on-chain `status` is the source of truth, but the UI needs two things it
 * does not directly encode: a *viewer role* (who is looking) and a *derived
 * state* that folds in the clock — chiefly whether a funded agreement has
 * expired, and the fact that a claimed agreement is never "expired".
 *
 * This module is pure: it takes an agreement plus a "now" and returns the role
 * and state, with no chain reads and no local-only state. `useAgreement` polls
 * the chain every 5 seconds and feeds the fresh account straight through here,
 * so what the user sees is always derived from chain state and the current time
 * — never from a client-side cache that could drift.
 *
 * The load-bearing rule (task item 2): **a claimed agreement must never derive
 * to "expired".** Once the recipient has claimed delivery, the agreement is in
 * the review/dispute branch; its `expires_at` no longer means anything, and the
 * relevant deadline is `claimed_at + review_window_secs`. Deriving an in-review
 * claim to "expired" would offer a refund on an agreement the payer can only
 * dispute, not refund — so `delivery_claimed` and `disputed` short-circuit the
 * expiry check entirely.
 */

import type { AgreementStatus, Frs1Agreement } from "./frs1-types";

/** Who is looking at the agreement. */
export type AgreementViewer = "payer" | "recipient" | "arbiter" | "visitor";

/**
 * The UI state. It refines the on-chain status with the clock:
 * `awaiting_payment` (pending), `expired` (funded but past `expires_at`),
 * `delivered_in_review` (claimed, review window open or closed).
 */
export type DerivedAgreementState =
  | "awaiting_payment"
  | "funded"
  | "delivered_in_review"
  | "disputed"
  | "released"
  | "refunded"
  | "expired"
  | "cancelled";

/**
 * The viewer's role. The arbiter is the one address on the Config that may
 * resolve a dispute; it is passed in (read from Config by the caller) so this
 * function stays pure and testable.
 */
export function deriveViewer(
  agreement: Frs1Agreement,
  connectedAddress: string | null,
  arbiterAddress: string | null = null,
): AgreementViewer | null {
  if (connectedAddress === null) return null;
  if (connectedAddress === agreement.recipientAddress) return "recipient";
  if (agreement.payerAddress !== null && connectedAddress === agreement.payerAddress) {
    return "payer";
  }
  if (arbiterAddress !== null && connectedAddress === arbiterAddress) return "arbiter";
  return "visitor";
}

/** True when the stored status is terminal: nothing transitions out of it. */
export function isTerminalStatus(status: AgreementStatus): boolean {
  return (
    status === "released" ||
    status === "refunded" ||
    status === "split" ||
    status === "cancelled"
  );
}

/**
 * The end of the review window: `claimed_at + review_window_secs`. Meaningful
 * only for a claimed agreement; the review window starts at the claim, not at
 * `expires_at`, because there is no claim to review until one exists.
 */
export function reviewWindowEnd(agreement: Frs1Agreement): number | null {
  if (agreement.claimedAt === null) return null;
  return agreement.claimedAt + agreement.reviewWindowSecs;
}

/**
 * Derive the UI state from the on-chain status, the agreement's own timestamps,
 * and `now` (Unix seconds).
 *
 * `expired` is derived, not stored: a `funded` agreement whose `expires_at` has
 * passed is expired, and only a refund remains. A *claimed* agreement
 * (`delivery_claimed` or `disputed`) is never expired — see the module comment.
 */
export function deriveState(
  agreement: Frs1Agreement,
  now: number,
): DerivedAgreementState {
  switch (agreement.status) {
    case "pending":
      // A pending agreement past its expiry was never fundable; the UI shows it
      // as expired so the recipient knows to re-propose. `create`/`fund` enforce
      // the same boundary on chain.
      return now >= agreement.expiresAt ? "expired" : "awaiting_payment";
    case "funded":
      // Funded and past expiry: refund only. Not claimed, so expiry applies.
      return now >= agreement.expiresAt ? "expired" : "funded";
    case "deliveryClaimed":
    case "disputed":
      // Claimed (or disputed off a claim): the expiry is irrelevant from here —
      // the review window and the arbiter deadline govern. Never "expired".
      return agreement.status === "disputed" ? "disputed" : "delivered_in_review";
    case "released":
      return "released";
    case "refunded":
      return "refunded";
    case "split":
      // A split is a terminal settlement of a dispute; the UI treats it like a
      // released outcome for display purposes (both sides were paid).
      return "released";
    case "cancelled":
      return "cancelled";
    default: {
      // Exhaustiveness: a new on-chain status must be handled here, not silently
      // bucketed. `never` makes the compiler flag an unhandled variant.
      const exhaustive: never = agreement.status;
      return exhaustive;
    }
  }
}

/** Everything the UI needs about one agreement, derived in one call. */
export interface AgreementView {
  agreement: Frs1Agreement;
  viewer: AgreementViewer | null;
  state: DerivedAgreementState;
  /** End of the review window (Unix seconds), or null when not claimed. */
  reviewEndsAt: number | null;
}

export function deriveAgreementView(
  agreement: Frs1Agreement,
  connectedAddress: string | null,
  now: number,
  arbiterAddress: string | null = null,
): AgreementView {
  return {
    agreement,
    viewer: deriveViewer(agreement, connectedAddress, arbiterAddress),
    state: deriveState(agreement, now),
    reviewEndsAt: reviewWindowEnd(agreement),
  };
}
