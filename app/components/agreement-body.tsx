/**
 * Payment request body (Task 3, item 1, part 1).
 */

"use client";

import Link from "next/link";
import { Tooltip, TooltipContent } from "@/components/ui/tooltip";
import { TooltipTrigger } from "@/components/ui/tooltip";
import type { DerivedAgreementState } from "@/lib/agreement-state";
import type { AgreementViewer } from "@/lib/agreement-state";
import type { Frs1Agreement } from "@/lib/frs1-types";
import { assetDisplay, formatBaseUnits } from "@/lib/display";
import { explorerTxUrl } from "@/lib/links";
import { MonoValue, StatusPill } from "@/components/payment-ui";
import { FeeLine, feeBaseUnitsOrNull } from "@/components/fee-line";
import { ProofView, StatusTimeline } from "@/components/proof-view-timeline";
import { StateActions } from "@/components/agreement-states";

export interface AgreementBodyProps {
  agreement: Frs1Agreement;
  agreementPda: string;
  viewer: AgreementViewer | null;
  state: DerivedAgreementState;
  reviewEndsAt: number | null;
  decimals: number | null;
  symbol: string;
  cluster: string;
  siteUrl: string;
  onChanged: () => void;
}

export function AgreementBody(props: AgreementBodyProps) {
  const { agreement, state, decimals, symbol } = props;
  const asset = assetDisplay(symbol);
  const amountDisplay =
    decimals === null ? agreement.amount : formatBaseUnits(agreement.amount, decimals);
  const feeRaw = decimals === null ? null : feeBaseUnitsOrNull(agreement.amount, decimals);

  return (
    <div className="flint-stack">
      <header>
        <p className="flint-eyebrow">Payment request</p>
        <h1 className="flint-page-title">{agreement.title === "" ? "Untitled agreement" : agreement.title}</h1>
        <div className="flint-row" style={{ marginTop: 8 }}>
          <StatusPill state={state} />
        </div>
      </header>

      <div className="flint-pay-grid">
        <div className="flint-card">
          <p className="flint-amount-big">
            {amountDisplay}{" "}
            <span style={{ fontSize: "1.125rem", color: "var(--flint-muted)" }}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span style={{ textDecoration: asset.tooltip === null ? "none" : "underline dotted" }}>
                    {asset.label}
                  </span>
                </TooltipTrigger>
                {asset.tooltip === null ? null : <TooltipContent>{asset.tooltip}</TooltipContent>}
              </Tooltip>
              {asset.badge === null ? null : <span className="flint-badge">{asset.badge}</span>}
            </span>
          </p>
          {feeRaw === null || decimals === null ? null : (
            <FeeLine
              amountBaseUnits={agreement.amount}
              feeBaseUnitsRaw={feeRaw}
              decimals={decimals}
              symbol={asset.label}
            />
          )}
          {agreement.memo === "" ? null : (
            <p className="flint-muted" style={{ marginTop: 12 }}>{agreement.memo}</p>
          )}
          <dl className="flint-kv-group" style={{ marginTop: 12 }}>
            <div className="flint-kv">
              <dt>Recipient</dt>
              <dd><MonoValue value={agreement.recipientAddress} label="Recipient address" /></dd>
            </div>
            <div className="flint-kv">
              <dt>Payer</dt>
              <dd>
                {agreement.payerAddress === null ? (
                  <span className="flint-muted">none yet — whoever funds this becomes the payer</span>
                ) : (
                  <MonoValue value={agreement.payerAddress} label="Payer address" />
                )}
              </dd>
            </div>
            <div className="flint-kv">
              <dt>Agreement</dt>
              <dd><MonoValue value={props.agreementPda} label="Agreement address" /></dd>
            </div>
          </dl>
          <StateActions {...props} amountDisplay={amountDisplay} />
        </div>

        <aside className="flint-side-col">
          <div className="flint-card">
            <h3>Status</h3>
            <StatusTimeline agreement={agreement} />
          </div>
          <ReceiptCard {...props} />
        </aside>
      </div>
    </div>
  );
}

function ReceiptCard(props: AgreementBodyProps) {
  const { agreement, agreementPda, cluster } = props;
  const done =
    agreement.status === "released" ||
    agreement.status === "refunded" ||
    agreement.status === "split" ||
    agreement.status === "cancelled";
  return (
    <div className="flint-card">
      <h3>Receipt details</h3>
      <dl className="flint-kv-group">
        <div className="flint-kv">
          <dt>Agreement</dt>
          <dd><MonoValue value={agreementPda} label="Agreement address" /></dd>
        </div>
        <div className="flint-kv">
          <dt>Escrow</dt>
          <dd><MonoValue value={agreement.escrowAddress} label="Escrow address" /></dd>
        </div>
        <div className="flint-kv">
          <dt>Evidence hash</dt>
          <dd><MonoValue value={agreement.evidenceHash} label="Evidence hash" /></dd>
        </div>
      </dl>
      {agreement.receiptProof === undefined ? null : (
        <p style={{ marginTop: 8 }}>
          <a href={explorerTxUrl(agreement.receiptProof, cluster)} target="_blank" rel="noreferrer">
            View the settlement transaction
          </a>
        </p>
      )}
      {done ? (
        <p style={{ marginTop: 8 }}>
          <Link href="/verify">Verify this receipt</Link>
        </p>
      ) : null}
    </div>
  );
}
