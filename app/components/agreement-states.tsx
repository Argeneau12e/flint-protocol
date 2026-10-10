/**
 * Payment request states (Task 3, item 1, part 2a).
 */

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Countdown } from "@/components/payment-ui";
import { EvidenceSheet } from "@/components/evidence-sheet";
import { FundButton } from "@/components/payment-actions";
import { ReleaseButton } from "@/components/payment-actions";
import { DisputedState, ExpiredState, InReview, TerminalState } from "@/components/agreement-review";
import type { AgreementBodyProps } from "@/components/agreement-body";

export function StateActions(props: AgreementBodyProps & { amountDisplay: string }) {
  switch (props.state) {
    case "awaiting_payment":
      return <AwaitingPayment {...props} />;
    case "funded":
      return <FundedState {...props} />;
    case "delivered_in_review":
      return <InReview {...props} />;
    case "disputed":
      return <DisputedState {...props} />;
    case "released":
    case "refunded":
    case "cancelled":
      return <TerminalState {...props} />;
    case "expired":
      return <ExpiredState {...props} />;
  }
}

function AwaitingPayment(props: AgreementBodyProps & { amountDisplay: string }) {
  const { agreement } = props;
  return (
    <div className="flint-stack" style={{ marginTop: 16 }}>
      <p aria-live="polite" className="flint-muted">
        <Countdown target={agreement.expiresAt} prefix="Expires in" />
      </p>
      <FundButton agreementPda={props.agreementPda} asset={agreement.asset} onSettled={props.onChanged} />
    </div>
  );
}

function FundedState(props: AgreementBodyProps & { amountDisplay: string }) {
  const { agreement, viewer } = props;
  const [sheetOpen, setSheetOpen] = useState(false);
  const isRecipient = viewer === "recipient";
  const isPayer = viewer === "payer";

  return (
    <div className="flint-stack" style={{ marginTop: 16 }}>
      <p aria-live="polite" className="flint-muted">
        <Countdown target={agreement.expiresAt} prefix="Expires in" />
      </p>
      {isPayer ? (
        <ReleaseButton
          agreementPda={props.agreementPda}
          asset={agreement.asset}
          recipient={agreement.recipientAddress}
          onSettled={props.onChanged}
        />
      ) : null}
      {isRecipient ? (
        <>
          <Button type="button" size="lg" onClick={() => setSheetOpen(true)}>
            Mark as delivered
          </Button>
          <EvidenceSheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            agreement={props.agreementPda}
            agreementPda={props.agreementPda}
            onClaimed={props.onChanged}
          />
        </>
      ) : null}
      {/* Everyone who is not the recipient gets the same small nudge: the button
          is keyed off chain state plus the connected wallet, so it is exactly
          the recipient — in any browser — who sees the action above. */}
      {!isRecipient ? (
        <p className="flint-hint">
          Recipient?{" "}
          <button
            type="button"
            className="flint-link-button"
            onClick={() => {
              const el = document.getElementById("wallet-connect");
              if (el !== null) {
                el.scrollIntoView({ block: "nearest" });
                el.querySelector("button")?.focus();
              }
            }}
          >
            Connect wallet
          </button>
        </p>
      ) : null}
    </div>
  );
}
