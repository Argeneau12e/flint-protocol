/**
 * Client-side transaction builders for the payment page (Task 3).
 *
 * The Task 2 builders in `flint-program.ts` construct unsigned transactions;
 * this module is the thin client half: build, then serialize to base64 for
 * `signAndSend` (which is what `useTransactionAction.run` expects), using the
 * browser connection and the live program id. No authority logic lives here —
 * the program enforces it, and the builders pass stored state through.
 */

"use client";

import { PublicKey, type Connection } from "@solana/web3.js";
import { DEFAULT_PROGRAM_ID } from "@/lib/config";
import {
  buildClaimDeliveryTransaction,
  buildDisputeTransaction,
  buildFundTransaction,
  buildReleaseAfterReviewTransaction,
  buildReleaseTransaction,
  buildRefundTransaction,
  buildSplitAfterArbiterTimeoutTransaction,
  serializeForClient,
  type ClaimDeliveryAccounts,
  type DisputeAccounts,
  type ReleaseAfterReviewAccounts,
  type SplitAfterArbiterTimeoutAccounts,
} from "@/lib/flint-program";
import type { DisputeReason } from "@/lib/frs1-types";

/** The deployed program, for client-side transaction building. */
export function flintProgramId(): PublicKey {
  return new PublicKey(DEFAULT_PROGRAM_ID);
}

export async function fundTxBase64(
  connection: Connection,
  programId: PublicKey,
  funder: PublicKey,
  agreement: PublicKey,
  asset: PublicKey,
): Promise<string> {
  const transaction = await buildFundTransaction(connection, programId, funder, {
    agreement,
    asset,
  });
  return serializeForClient(transaction);
}

export async function releaseTxBase64(
  connection: Connection,
  programId: PublicKey,
  payer: PublicKey,
  agreement: PublicKey,
  asset: PublicKey,
  recipient: PublicKey,
): Promise<string> {
  const transaction = await buildReleaseTransaction(connection, programId, payer, {
    agreement,
    asset,
    recipient,
  });
  return serializeForClient(transaction);
}

export async function refundTxBase64(
  connection: Connection,
  programId: PublicKey,
  cranker: PublicKey,
  agreement: PublicKey,
  asset: PublicKey,
  payer: PublicKey,
): Promise<string> {
  const transaction = await buildRefundTransaction(connection, programId, cranker, {
    agreement,
    asset,
    payer,
  });
  return serializeForClient(transaction);
}

export async function claimDeliveryTxBase64(
  connection: Connection,
  programId: PublicKey,
  accounts: ClaimDeliveryAccounts,
  evidenceHash: number[],
  evidenceRef: string,
): Promise<string> {
  const transaction = await buildClaimDeliveryTransaction(
    connection,
    programId,
    accounts,
    evidenceHash,
    evidenceRef,
  );
  return serializeForClient(transaction);
}

export async function disputeTxBase64(
  connection: Connection,
  programId: PublicKey,
  accounts: DisputeAccounts,
  reason: DisputeReason,
): Promise<string> {
  const transaction = await buildDisputeTransaction(
    connection,
    programId,
    accounts,
    reason,
  );
  return serializeForClient(transaction);
}

export async function releaseAfterReviewTxBase64(
  connection: Connection,
  programId: PublicKey,
  accounts: ReleaseAfterReviewAccounts,
): Promise<string> {
  const transaction = await buildReleaseAfterReviewTransaction(
    connection,
    programId,
    accounts,
  );
  return serializeForClient(transaction);
}

export async function splitAfterTimeoutTxBase64(
  connection: Connection,
  programId: PublicKey,
  accounts: SplitAfterArbiterTimeoutAccounts,
): Promise<string> {
  const transaction = await buildSplitAfterArbiterTimeoutTransaction(
    connection,
    programId,
    accounts,
  );
  return serializeForClient(transaction);
}
