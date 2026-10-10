/**
 * Payment request states (Task 3, item 1, part 2b): review, dispute, terminal.
 */

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Countdown, MonoValue } from "@/components/payment-ui";
import { ProofView } from "@/components/proof-view";
import { VerifyFile } from "@/components/verify-file";
import { DisputeDialog, reasonLabel } from "@/components/dispute-dialog";
import { RefundButton, ReleaseButton } from "@/components/payment-actions";
import { ReleaseAfterReviewButton } from "@/components/late-actions";
import { SplitButton } from "@/components/late-actions";
import type { AgreementBodyProps } from "@/components/agreement-body";

type Props = AgreementBodyProps & { amountDisplay: string };

export function InReview(props: Props) {
  const { agreement, viewer, reviewEndsAt } = props;
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const isPayer = viewer === "payer";
  const isRecipient = viewer === "recipient";
  const now = Math.floor(Date.now() / 1000);
  const windowOver = reviewEndsAt !== null && now >= reviewEndsAt;
  const reviewUrl =
    typeof window === "undefined" ? "" : window.location.href;

  return (
    <div className="flint-stack" style={{ marginTop: 16 }}>
      {isRecipient && !isPayer ? (
        <p><strong>Delivered, awaiting review.</strong></p>
      ) : null}
      {reviewEndsAt === null ? null : (
        <p aria-live="polite" className="flint-muted">
          <Countdown target={reviewEndsAt} prefix="Auto-release in" />
        </p>
      )}
      <ProofView agreement={agreement} />
      <VerifyFile evidenceRef={agreement.evidenceRef} onChainHash={agreement.evidenceHash} />
      {isPayer ? (
        <div className="flint-row">
          <Button type="button" variant="outline" onClick={() => setDisputeOpen(true)}>
            Dispute
          </Button>
          <ReleaseButton
            agreementPda={props.agreementPda}
            asset={agreement.asset}
            recipient={agreement.recipientAddress}
            onSettled={props.onChanged}
          />
        </div>
      ) : null}
      {isRecipient ? (
        <div className="flint-card">
          <h4>Send review link to payer</h4>
          <MonoValue value={reviewUrl} label="Review link" />
          <div className="flint-row">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(reviewUrl).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied." : "Copy"}
            </Button>
            <a
              className="flint-button"
              href={`https://wa.me/?text=${encodeURIComponent(`Please review this delivery: ${reviewUrl}`)}`}
              target="_blank"
              rel="noreferrer"
            >
              Share on WhatsApp
            </a>
          </div>
        </div>
      ) : null}
      {windowOver ? (
        <ReleaseAfterReviewButton
          agreementPda={props.agreementPda}
          asset={agreement.asset}
          recipient={agreement.recipientAddress}
          onSettled={props.onChanged}
        />
      ) : null}
      <DisputeDialog
        open={disputeOpen}
        onOpenChange={setDisputeOpen}
        agreement={props.agreementPda}
        onDisputed={props.onChanged}
      />
    </div>
  );
}

export function DisputedState(props: Props) {
  const { agreement } = props;
  const now = Math.floor(Date.now() / 1000);
  const pastDeadline =
    agreement.arbiterDeadline !== null && now >= agreement.arbiterDeadline;

  return (
    <div className="flint-stack" style={{ marginTop: 16 }}>
      <p>
        <strong>Awaiting arbiter.</strong>{" "}
        {agreement.disputeReason === null
          ? "The payer disputed this delivery."
          : `Reason: ${reasonLabel(agreement.disputeReason)}.`}
      </p>
      {agreement.arbiterDeadline === null ? null : (
        <p aria-live="polite" className="flint-muted">
          <Countdown target={agreement.arbiterDeadline} prefix="Arbiter fallback in" />
        </p>
      )}
      <ProofView agreement={agreement} />
      <VerifyFile evidenceRef={agreement.evidenceRef} onChainHash={agreement.evidenceHash} />
      {pastDeadline && agreement.payerAddress !== null ? (
        <SplitButton
          agreementPda={props.agreementPda}
          asset={agreement.asset}
          payer={agreement.payerAddress}
          recipient={agreement.recipientAddress}
          onSettled={props.onChanged}
        />
      ) : null}
    </div>
  );
}

export function TerminalState(props: Props) {
  return (
    <div className="flint-stack" style={{ marginTop: 16 }}>
      <p className="flint-muted">
        This agreement is {props.state}. Nothing further is required.
      </p>
      <ProofView agreement={props.agreement} />
    </div>
  );
}

export function ExpiredState(props: Props) {
  const { agreement } = props;
  return (
    <div className="flint-stack" style={{ marginTop: 16 }}>
      <p className="flint-muted">
        This agreement expired with {agreement.status === "funded" ? "funds in escrow" : "no funds"}.
      </p>
      {agreement.status === "funded" && agreement.payerAddress !== null ? (
        <RefundButton
          agreementPda={props.agreementPda}
          asset={agreement.asset}
          payer={agreement.payerAddress}
          onSettled={props.onChanged}
        />
      ) : null}
    </div>
  );
}
