/**
 * Payment-request actions (Task 3): fund, release, refund.
 *
 * Each action builds its transaction with the Task 2 builders through the
 * thin client wrappers in `lib/client-tx.ts`, then signs via
 * `useTransactionAction`. Plain-language errors, never raw strings.
 */

"use client";

import { PublicKey } from "@solana/web3.js";
import { Button } from "@/components/ui/button";
import { getBrowserConnection, useFlintWallet } from "@/lib/wallet";
import { useTransactionAction } from "@/lib/wallet";
import { flintProgramId } from "@/lib/client-tx";
import { fundTxBase64 } from "@/lib/client-tx";
import { refundTxBase64 } from "@/lib/client-tx";
import { releaseTxBase64 } from "@/lib/client-tx";

function friendlyTxError(): string {
  return "The transaction failed. Nothing changed on chain — try again.";
}

export function FundButton({
  agreementPda,
  asset,
  onSettled,
}: {
  agreementPda: string;
  asset: string;
  onSettled: () => void;
}) {
  const { address, connected } = useFlintWallet();
  const action = useTransactionAction(onSettled);

  async function fund() {
    if (address === null) return;
    await action.run(async () => {
      const connection = getBrowserConnection();
      return fundTxBase64(
        connection,
        flintProgramId(),
        new PublicKey(address),
        new PublicKey(agreementPda),
        new PublicKey(asset),
      );
    });
  }

  return (
    <div className="flint-stack">
      <Button type="button" size="lg" disabled={!connected || action.busy} onClick={() => void fund()}>
        {action.busy ? "Working…" : "Fund"}
      </Button>
      {!connected ? <p className="flint-hint">Connect a wallet to fund this agreement.</p> : null}
      {action.message !== null && action.busy ? <p role="status" className="flint-note">{action.message}</p> : null}
      {action.error === null ? null : <p role="alert" className="flint-error-text">{friendlyTxError()}</p>}
    </div>
  );
}

export function ReleaseButton({
  agreementPda,
  asset,
  recipient,
  onSettled,
}: {
  agreementPda: string;
  asset: string;
  recipient: string;
  onSettled: () => void;
}) {
  const { address, connected } = useFlintWallet();
  const action = useTransactionAction(onSettled);

  async function release() {
    if (address === null) return;
    await action.run(async () => {
      const connection = getBrowserConnection();
      return releaseTxBase64(
        connection,
        flintProgramId(),
        new PublicKey(address),
        new PublicKey(agreementPda),
        new PublicKey(asset),
        new PublicKey(recipient),
      );
    });
  }

  return (
    <div className="flint-stack">
      <Button type="button" size="lg" disabled={!connected || action.busy} onClick={() => void release()}>
        {action.busy ? "Working…" : "Release Funds"}
      </Button>
      {action.message !== null && action.busy ? <p role="status" className="flint-note">{action.message}</p> : null}
      {action.error === null ? null : <p role="alert" className="flint-error-text">{friendlyTxError()}</p>}
    </div>
  );
}

export function RefundButton({
  agreementPda,
  asset,
  payer,
  onSettled,
}: {
  agreementPda: string;
  asset: string;
  payer: string;
  onSettled: () => void;
}) {
  const { address, connected } = useFlintWallet();
  const action = useTransactionAction(onSettled);

  async function refund() {
    if (address === null) return;
    await action.run(async () => {
      const connection = getBrowserConnection();
      return refundTxBase64(
        connection,
        flintProgramId(),
        new PublicKey(address),
        new PublicKey(agreementPda),
        new PublicKey(asset),
        new PublicKey(payer),
      );
    });
  }

  return (
    <div className="flint-stack">
      <Button type="button" variant="outline" disabled={!connected || action.busy} onClick={() => void refund()}>
        {action.busy ? "Working…" : "Refund to payer"}
      </Button>
      {action.error === null ? null : <p role="alert" className="flint-error-text">{friendlyTxError()}</p>}
    </div>
  );
}
