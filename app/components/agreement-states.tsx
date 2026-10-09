/**
 * Payment request states (Task 3, item 1, part 2a).
 */

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useFlintWallet } from "@/lib/wallet";
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
  const { connected } = useFlintWallet();
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
      {!connected || viewer === null ? (
        <p className="flint-hint">Recipient? Connect wallet</p>
      ) : null}
      {viewer === "visitor" || viewer === "arbiter" ? (
        <p className="flint-hint">Recipient? Connect wallet</p>
      ) : null}
    </div>
  );
}
