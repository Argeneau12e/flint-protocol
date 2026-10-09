/**
 * Late-settlement actions (Task 3): release-after-review and 50/50 split.
 * Anyone connected may crank either once its deadline has passed.
 */

"use client";

import { PublicKey } from "@solana/web3.js";
import { Button } from "@/components/ui/button";
import { getBrowserConnection, useFlintWallet, useTransactionAction } from "@/lib/wallet";
import { flintProgramId, releaseAfterReviewTxBase64, splitAfterTimeoutTxBase64 } from "@/lib/client-tx";

function friendlyTxError(): string {
  return "The transaction failed. Nothing changed on chain — try again.";
}

export function ReleaseAfterReviewButton({
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
      return releaseAfterReviewTxBase64(connection, flintProgramId(), {
        agreement: new PublicKey(agreementPda),
        cranker: new PublicKey(address),
        asset: new PublicKey(asset),
        recipient: new PublicKey(recipient),
      });
    });
  }

  return (
    <div className="flint-stack">
      <Button type="button" disabled={!connected || action.busy} onClick={() => void release()}>
        {action.busy ? "Working…" : "Release to recipient"}
      </Button>
      {action.error === null ? null : <p role="alert" className="flint-error-text">{friendlyTxError()}</p>}
    </div>
  );
}

export function SplitButton({
  agreementPda,
  asset,
  payer,
  recipient,
  onSettled,
}: {
  agreementPda: string;
  asset: string;
  payer: string;
  recipient: string;
  onSettled: () => void;
}) {
  const { address, connected } = useFlintWallet();
  const action = useTransactionAction(onSettled);

  async function split() {
    if (address === null) return;
    await action.run(async () => {
      const connection = getBrowserConnection();
      return splitAfterTimeoutTxBase64(connection, flintProgramId(), {
        agreement: new PublicKey(agreementPda),
        cranker: new PublicKey(address),
        asset: new PublicKey(asset),
        payer: new PublicKey(payer),
        recipient: new PublicKey(recipient),
      });
    });
  }

  return (
    <div className="flint-stack">
      <Button type="button" variant="outline" disabled={!connected || action.busy} onClick={() => void split()}>
        {action.busy ? "Working…" : "Split 50/50"}
      </Button>
      {action.error === null ? null : <p role="alert" className="flint-error-text">{friendlyTxError()}</p>}
    </div>
  );
}
