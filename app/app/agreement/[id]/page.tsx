/**
 * One agreement, and what its current state allows (acceptances 7.1.3, 7.1.4).
 *
 * This page is the human flow's centre of gravity, and it has one job beyond
 * showing terms: **offer exactly the actions the current state permits, and
 * explain the ones it does not.** The state machine (Section 4.2) has five states
 * and each one allows something different, so each is rendered with its own
 * affordance rather than a single "settle" button that is sometimes wrong:
 *
 *   - `pending`  → nothing to do but share the Blink. No release (no funds, no
 *                  payer) and no refund (no funds, not expired).
 *   - `funded`, before expiry → **release**, payer only. The button is rendered
 *                  for the payer and *explained* for everyone else, because
 *                  "the button is missing" is a worse answer than "only the
 *                  payer can do this, and the payer is <address>".
 *   - `funded`, after expiry → release is gone (row 3) and **refund** is
 *                  available to **anyone**. This is the acceptance criterion that
 *                  is easiest to get wrong in the honest direction: making the
 *                  payer wait for their own money back is a liveness bug, not a
 *                  safety feature, so the affordance is offered to every connected
 *                  wallet and the copy is explicit that the cranker receives
 *                  nothing while the payer receives everything.
 *   - `released` / `refunded` → terminal. Nothing transitions out (Section 4.2),
 *                  so the page says so instead of offering a dead button.
 *   - `cancelled` → the account is closed (Section 4.6), so this page cannot even
 *                  load it; the sibling error state handles it.
 *
 * Everything rendered is read fresh from chain on each request (Section 6.2), and
 * the client re-reads it after a settlement by refreshing — so the status on
 * screen is never the status this component hoped for.
 *
 * Structure only, per Section 9.
 */

import Link from "next/link";
import {
  AgreementNotFoundError,
  BadAgreementRefError,
  deployment,
  loadAgreementView,
} from "@/lib/agreement-view";
import { getConnection, explorerAddressUrl } from "@/lib/solana";
import { SettlementPanel } from "@/components/settlement-panel";
import { Term } from "@/components/agreement-ui";

export const dynamic = "force-dynamic";

/** The state as a tag. The tone says which way the money went, not just where it is. */
const STATUS_TONES: Record<string, string> = {
  pending: "flint-tag-gold",
  funded: "flint-tag-gold",
  released: "flint-tag-ok",
  refunded: "flint-tag-warn",
  cancelled: "flint-tag-warn",
};

/** Both failure modes a link can have, stated rather than thrown at a person. */
function LinkProblem({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="flint-stack">
      <header>
        <p className="flint-eyebrow">Agreement</p>
        <h1 className="flint-page-title">{heading}</h1>
      </header>
      <div className="flint-card flint-measure">
        <p className="flint-note flint-error">{children}</p>
        <p className="flint-muted" style={{ marginTop: "var(--flint-space-3)" }}>
          A Flint link carries both the agreement id and the recipient&rsquo;s
          address, because together they are the agreement&rsquo;s identity on chain.
        </p>
        <p style={{ marginTop: "var(--flint-space-4)" }}>
          <Link href="/">Back to the Flint overview</Link>
        </p>
      </div>
    </div>
  );
}

export default async function AgreementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ recipient?: string }>;
}) {
  const { id } = await params;
  // `searchParams` yields `undefined` for an absent key; the reader's signature
  // distinguishes absent from empty, so normalise once here rather than making
  // every caller remember which is which.
  const { recipient } = await searchParams;
  const recipientParam = recipient ?? null;

  let view;
  try {
    const { programId, assetMint, symbol } = deployment();
    view = await loadAgreementView(getConnection(), programId, id, recipientParam, assetMint, symbol);
  } catch (error) {
    if (error instanceof BadAgreementRefError) {
      return (
        <LinkProblem heading="That link is incomplete">{error.detail}</LinkProblem>
      );
    }
    if (error instanceof AgreementNotFoundError) {
      return (
        <LinkProblem heading="No agreement at that address">
          There is no FRS-1 account at{" "}
          <a href={explorerAddressUrl(error.pda)}>
            <code>{error.pda}</code>
          </a>
          . The two likeliest reasons: the recipient cancelled it before anyone
          funded it, which closes the account and returns its rent; or the id and
          the address in this link do not belong together.
        </LinkProblem>
      );
    }
    throw error;
  }

  const { agreement } = view;
  const expiresIn = new Date(agreement.expiresAt * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  return (
    <div className="flint-stack">
      <header>
        <p className="flint-eyebrow">Agreement</p>
        <h1 className="flint-page-title">
          {agreement.title === "" ? "Payment agreement" : agreement.title}
        </h1>
        <p className="flint-muted" style={{ marginTop: "var(--flint-space-3)" }}>
          An FRS-1 payment agreement. Everything below was read from Solana devnet
          when this page loaded, and the status is recomputed from the account
          rather than remembered by this page.
        </p>

        <p className="flint-row" style={{ marginTop: "var(--flint-space-4)" }}>
          <span className="flint-muted">Status</span>
          <span className={`flint-tag ${STATUS_TONES[agreement.status] ?? ""}`}>
            {agreement.status}
          </span>
          {view.expired && agreement.status === "funded" ? (
            <span className="flint-tag flint-tag-warn">expired</span>
          ) : null}
        </p>
      </header>

      <SettlementPanel
        id={view.id}
        recipient={view.recipient}
        amountDisplay={view.amountDisplay}
        symbol={view.symbol}
        status={agreement.status}
        expired={view.expired}
        payerAddress={agreement.payerAddress}
        expiresAtIso={expiresIn}
        secondsUntilExpiry={view.secondsUntilExpiry}
      />

      <section className="flint-card" aria-labelledby="terms-heading">
        <h2 id="terms-heading">The terms</h2>
        <dl className="flint-terms" style={{ marginTop: "var(--flint-space-4)" }}>
          <Term term="Amount">
            <span className="flint-num">{view.amountDisplay}</span> {view.symbol}
          </Term>
          <Term term="Asset">
            <code>{agreement.asset}</code>
          </Term>
          <Term term="Recipient">
            <code>{agreement.recipientAddress}</code>
          </Term>
          <Term term="Payer">
            {agreement.payerAddress === null ? (
              <span className="flint-muted">
                none yet — whoever funds this agreement becomes the payer
              </span>
            ) : (
              <code>{agreement.payerAddress}</code>
            )}
          </Term>
          <Term term="Expires">
            <span className="flint-num">{expiresIn}</span> UTC{" "}
            <span className="flint-muted">
              (unix <span className="flint-num">{agreement.expiresAt}</span>, chain clock)
            </span>
          </Term>
          <Term term="Condition">
            <code>{agreement.condition.type}</code> — {agreement.condition.description}
          </Term>
          <Term term="Escrow">
            <a href={explorerAddressUrl(view.escrow)}>
              <code>{view.escrow}</code>
            </a>
          </Term>
          <Term term="Agreement account">
            <a href={explorerAddressUrl(view.pda)}>
              <code>{view.pda}</code>
            </a>
          </Term>
          <Term term="Id">
            <code>{agreement.id}</code>
          </Term>
          {agreement.memo === "" ? null : <Term term="Note">{agreement.memo}</Term>}
          {agreement.disputedFlag ? (
            <Term term="Disputed">
              yes, flagged{agreement.disputedAt === null ? "" : ` at ${agreement.disputedAt}`}.
              This is advisory only — it never moves money and never blocks a
              refund.
            </Term>
          ) : null}
        </dl>
      </section>

      <section className="flint-card flint-stack" aria-labelledby="receipt-heading">
        <h2 id="receipt-heading">Receipts</h2>
        <p className="flint-muted">
          A receipt is the <em>settlement</em> transaction — the release or the
          refund. Flint stores none: it is derived from the chain, so paste the
          signature into the verification page and it will be recomputed against
          the account rather than trusted.
        </p>
        <p>
          <Link className="flint-button flint-primary" href="/verify/">
            Verify a receipt
          </Link>
        </p>
        <p className="flint-muted">
          A receipt proves a specific amount moved under specific terms, authorised
          by the address the program required. It does not prove the work was
          actually delivered — that is the payer&rsquo;s attestation, and no
          signature turns it into a fact.
        </p>
      </section>
    </div>
  );
}
