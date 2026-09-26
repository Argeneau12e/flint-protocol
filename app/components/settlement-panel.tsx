/**
 * The actions available on an agreement right now (acceptances 7.1.3, 7.1.4).
 *
 * This is where the state machine becomes something a person can act on, so it is
 * worth being precise about the three cases that are easy to conflate:
 *
 *   - **Release** is the payer's alone. Only the address recorded in
 *     `payerAddress` may sign it (Section 4.2, threat row 1). When the connected
 *     wallet is not that address, the button is replaced by an explanation naming
 *     the payer — not merely hidden, which would leave a recipient staring at a
 *     page with no explanation at all.
 *   - **Refund** is anyone's. Once an agreement is expired and still funded, any
 *     wallet can crank it, and the program always pays the *stored* payer
 *     (Section 4.2, rows 1 and 2). The cranker is not a beneficiary and cannot
 *     become one; the copy says so, because "claim refund" on its own invites the
 *     opposite assumption, and the protocol's liveness guarantee rests on
 *     strangers being willing to click it.
 *   - **Neither** is available in the other states, and the panel says which and
 *     why rather than rendering an inert control.
 *
 * One detail matters for the correctness of the *displayed* state: a client-side
 * clock is never used to decide whether an agreement has expired. The `expired`
 * flag arrives from the server, which read the Clock sysvar (Section 4.5). A
 * browser with a wrong clock must not be able to show a refund button for a live
 * agreement, or hide one for a dead one.
 *
 * Both actions go through `useTransactionAction`, so each has the loading, success
 * and error states Section 9 requires, and each refreshes the server component
 * afterwards, so the status on screen is re-read from chain.
 */

"use client";

import { useRouter } from "next/navigation";
import { ActionFeedback, ConnectButton, shortAddress } from "@/components/agreement-ui";
import { useFlintWallet, useTransactionAction } from "@/lib/wallet";
import type { AgreementStatus } from "@/lib/frs1-types";

/** Which settlement the panel is asking the server to build. */
type Settlement = "release" | "refund";

export function SettlementPanel({
  id,
  recipient,
  amountDisplay,
  symbol,
  status,
  expired,
  payerAddress,
  expiresAtIso,
  secondsUntilExpiry,
}: {
  id: string;
  recipient: string;
  amountDisplay: string;
  symbol: string;
  status: AgreementStatus;
  expired: boolean;
  payerAddress: string | null;
  expiresAtIso: string;
  secondsUntilExpiry: number;
}) {
  const router = useRouter();
  const { address, connected } = useFlintWallet();

  const refresh = () => router.refresh();
  const release = useTransactionAction(refresh);
  const refund = useTransactionAction(refresh);

  /** Asks the server to build one settlement transaction, then signs it. */
  async function settle(settlement: Settlement, action: ReturnType<typeof useTransactionAction>) {
    await action.run(async () => {
      const response = await fetch(`/api/agreements/${id}/settle?recipient=${recipient}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settlement, signer: address }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        transaction?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          body.error ?? `The server refused to build the ${settlement} (HTTP ${response.status}).`,
        );
      }
      if (typeof body.transaction !== "string") {
        throw new Error("The server's response was not a transaction. Nothing was signed.");
      }
      return body.transaction;
    });
  }

  // ---- terminal states: nothing transitions out (Section 4.2) ----
  if (status === "released" || status === "refunded") {
    return (
      <section className="flint-section" aria-labelledby="settle-heading">
        <h2 id="settle-heading" className="text-lg font-semibold">
          {status === "released" ? "Paid" : "Refunded"}
        </h2>
        <p className="flint-note mt-3">
          {status === "released"
            ? "The payer released the escrow to the recipient. This is final: released is a terminal state, and no instruction can move these funds again. The transaction that did it is the receipt."
            : "The agreement expired without a release, and the escrow was returned to the payer. This is final: refunded is a terminal state."}
        </p>
        <p className="mt-3 text-sm">
          Find that transaction on the Solana explorer, or paste its signature into
          the verification page, to check it as a receipt.
        </p>
      </section>
    );
  }

  // ---- pending: shareable, but nothing to settle yet ----
  if (status === "pending") {
    return (
      <section className="flint-section" aria-labelledby="settle-heading">
        <h2 id="settle-heading" className="text-lg font-semibold">
          Waiting to be funded
        </h2>
        <p className="flint-note mt-3">
          No one has funded this agreement yet, so the escrow is empty and there is
          nothing to release or refund. Share the Blink from the recipient&rsquo;s
          Flint page: whoever approves it in a Solana wallet becomes the payer.
        </p>
        {expired ? (
          <p className="flint-note flint-error mt-3">
            This agreement has expired, so it can no longer be funded. The
            recipient would need to propose a new one with a later expiry.
          </p>
        ) : null}
        <div className="mt-3">
          <ConnectButton />
        </div>
      </section>
    );
  }

  // ---- funded: the only state with a choice in it ----
  const isPayer = address !== null && address === payerAddress;

  return (
    <section className="flint-section" aria-labelledby="settle-heading">
      <h2 id="settle-heading" className="text-lg font-semibold">
        The funds are in escrow
      </h2>
      <p className="flint-muted mt-1 text-sm">
        <code>{amountDisplay}</code> {symbol} is held by the agreement&rsquo;s own
        escrow account, not by either party. Nobody can take it out except by the
        two paths below, and which one is open depends on whether it has expired.
      </p>

      <div className="mt-3">
        <ConnectButton />
      </div>

      {/* ---- release: payer only, and only before expiry ---- */}
      <div className="flint-section">
        <h3 className="font-semibold">Release to the recipient</h3>
        {expired ? (
          <p className="flint-note flint-error mt-2">
            This agreement expired at {expiresAtIso}, so it can no longer be
            released. Once the expiry passes, the refund below is the only remaining
            path — the program will not move funds to the recipient after the
            deadline.
          </p>
        ) : isPayer ? (
          <>
            <p className="flint-muted mt-1 text-sm">
              You are the payer for this agreement. Approving this moves the
              escrowed <code>{amountDisplay}</code> {symbol} to the recipient (
              <code>{shortAddress(recipient)}</code>) and is final.
            </p>
            <button
              type="button"
              className="flint-button mt-2"
              disabled={release.busy}
              onClick={() => void settle("release", release)}
            >
              {release.busy ? "Releasing…" : "Release the funds"}
            </button>
            <ActionFeedback
              busy={release.busy}
              message={release.message}
              error={release.error}
              success={
                release.stage === "success"
                  ? "Released. This transaction signature is the receipt — check it on the verification page."
                  : null
              }
            />
          </>
        ) : (
          <p className="flint-note mt-2">
            Only the payer can release these funds, and the payer is{" "}
            <code>{payerAddress ?? "not recorded"}</code>. You are connected as{" "}
            <code>{shortAddress(address)}</code>. If you are the payer, connect that
            wallet instead — a release signed by any other address is rejected by
            the program.
          </p>
        )}
      </div>

      {/* ---- refund: permissionless, once expired (acceptance 7.1.4) ---- */}
      <div className="flint-section">
        <h3 className="font-semibold">Refund to the payer</h3>
        {!expired ? (
          <p className="flint-note mt-2">
            Not available yet. A refund only becomes possible once the agreement has
            expired — it expires at {expiresAtIso}
            {secondsUntilExpiry > 0
              ? `, in about ${Math.max(1, Math.round(secondsUntilExpiry / 60))} minutes.`
              : "."}{" "}
            Until then the funds are the recipient&rsquo;s to claim, not the
            payer&rsquo;s to reclaim: a funded, unexpired agreement is escrow, not a
            delayed transfer.
          </p>
        ) : (
          <>
            <p className="flint-muted mt-1 text-sm">
              This agreement expired at {expiresAtIso} with the money still in
              escrow. <strong>Anyone</strong> can trigger the refund, including you
              — it is permissionless by design, so the payer is never stuck waiting
              on a counterparty to act. The program always sends the escrowed{" "}
              <code>{amountDisplay}</code> {symbol} to the stored payer (
              <code>{payerAddress ?? "unknown"}</code>); the wallet that triggers it
              receives nothing and pays only the transaction fee.
            </p>
            <button
              type="button"
              className="flint-button mt-2"
              disabled={refund.busy || !connected}
              onClick={() => void settle("refund", refund)}
            >
              {refund.busy ? "Refunding…" : "Claim the refund for the payer"}
            </button>
            {!connected ? (
              <p className="flint-hint mt-1">
                Connect any wallet to trigger the refund — it does not have to be the
                payer&rsquo;s.
              </p>
            ) : null}
            <ActionFeedback
              busy={refund.busy}
              message={refund.message}
              error={refund.error}
              success={
                refund.stage === "success"
                  ? "Refunded. The escrowed funds are back with the payer, and this transaction signature is the receipt."
                  : null
              }
            />
          </>
        )}
      </div>
    </section>
  );
}
