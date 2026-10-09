/**
 * Dispute dialog (Task 3, item 3).
 *
 * shadcn Dialog opened by the payer Dispute button. Reason radio list uses
 * the five reason codes from DISPUTE_REASON_CODES; the optional detail stays
 * local to the page (the program stores only the reason code). Destructive
 * confirm with a short arbiter warning. On success the parent re-reads chain
 * state, which shows the Disputed state.
 */

"use client";

import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DISPUTE_REASON_CODES, type DisputeReason } from "@/lib/frs1-types";
import { disputeTxBase64, flintProgramId } from "@/lib/client-tx";
import { getBrowserConnection, useFlintWallet, useTransactionAction } from "@/lib/wallet";

const REASONS: ReadonlyArray<{ code: DisputeReason; blurb: string }> = [
  { code: "notAsDescribed", blurb: "The work does not match what was agreed." },
  { code: "incomplete", blurb: "Only part of the work was delivered." },
  { code: "notReceived", blurb: "Nothing was delivered." },
  { code: "quality", blurb: "The work is below the agreed standard." },
  { code: "other", blurb: "Something else went wrong." },
];

export function reasonLabel(code: DisputeReason): string {
  switch (code) {
    case "notAsDescribed":
      return "Not as described";
    case "incomplete":
      return "Incomplete";
    case "notReceived":
      return "Not received";
    case "quality":
      return "Quality issue";
    case "other":
      return "Other";
  }
}

export function DisputeDialog({
  open,
  onOpenChange,
  agreement,
  onDisputed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agreement: string;
  onDisputed: () => void;
}) {
  const { address } = useFlintWallet();
  const [reason, setReason] = useState<DisputeReason>("notAsDescribed");
  const [detail, setDetail] = useState("");
  const action = useTransactionAction(() => {
    onDisputed();
    onOpenChange(false);
  });

  async function submit() {
    if (address === null) return;
    const codes = Object.keys(DISPUTE_REASON_CODES) as DisputeReason[];
    if (!codes.includes(reason)) return;
    await action.run(async () => {
      const connection = getBrowserConnection();
      const programId = flintProgramId();
      return disputeTxBase64(connection, programId, {
        agreement: new PublicKey(agreement),
        payer: new PublicKey(address),
      }, reason);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="dispute-desc">
        <DialogHeader>
          <DialogTitle>Dispute this delivery</DialogTitle>
          <DialogDescription id="dispute-desc">
            The arbiter will decide where the funds go. This cannot be undone
            by you afterwards.
          </DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label="Dispute reason" className="flint-stack">
          {REASONS.map((entry) => (
            <label key={entry.code} className="flint-radio-row">
              <input
                type="radio"
                name="dispute-reason"
                value={entry.code}
                checked={reason === entry.code}
                onChange={() => setReason(entry.code)}
              />
              <span>
                <strong>{reasonLabel(entry.code)}</strong>
                <span className="flint-muted"> — {entry.blurb}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="flint-field">
          <Label htmlFor="dispute-detail">
            Detail for your own records (optional, stays on this page)
          </Label>
          <Textarea
            id="dispute-detail"
            value={detail}
            maxLength={500}
            rows={3}
            onChange={(event) => setDetail(event.target.value)}
            placeholder="What should the arbiter know?"
          />
        </div>
        {action.error === null ? null : (
          <p role="alert" className="flint-error-text">{action.error}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={action.busy} onClick={() => void submit()}>
            {action.busy ? "Submitting…" : "Confirm dispute"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
