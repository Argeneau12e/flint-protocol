/**
 * One agreement, as the person who was sent the link sees it (Section 5a).
 *
 * This page has exactly one job: let the payer understand the request and pay
 * it. Everything the earlier version led with — the FRS-1 field table, the
 * escrow and agreement accounts, the condition enum, the unix expiry, the
 * agreement id, the receipts section — is protocol-level detail that does not
 * change what a payer does, so it now lives in the single closed *Technical
 * details* disclosure rendered by `PaymentRequest` (and, in full, on /docs).
 *
 * The settlement affordances are the one exception, and only in the one state
 * where they exist: a *funded* agreement is the only state with a choice in it
 * (Section 4.2), and the payer is the one who makes that choice. So the panel is
 * rendered for `funded` and nowhere else — a pending agreement has nothing to
 * settle, and the terminal states have nothing left to do.
 *
 * Every value on screen is read fresh from chain on each request (Section 6.2),
 * including the "now" behind the deadline, which comes from the Clock sysvar
 * rather than from this server's or the reader's clock.
 */

import Link from "next/link";
import {
  AgreementNotFoundError,
  BadAgreementRefError,
  deployment,
  loadAgreementView,
} from "@/lib/agreement-view";
import { CLUSTER, explorerAddressUrl, getConnection } from "@/lib/solana";
import { AssetLabel } from "@/components/asset-label";
import { PaymentRequest } from "@/components/payment-request";
import { SettlementPanel } from "@/components/settlement-panel";
import { Term } from "@/components/agreement-ui";

export const dynamic = "force-dynamic";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * `2 October 2026, 14:30 UTC` — the only date format on the payer's page.
 *
 * Assembled from UTC parts rather than through `toLocaleString`, which would
 * render differently per server locale and per ICU build; a deadline that reads
 * differently in two places is the kind of difference a payment cannot afford.
 * The seconds-level ISO form and the raw unix value stay in the technical
 * disclosure, where an exact value is what is wanted.
 */
function humanDate(unixSeconds: number): string {
  const at = new Date(unixSeconds * 1000);
  const day = at.getUTCDate();
  const month = MONTHS[at.getUTCMonth()];
  const year = at.getUTCFullYear();
  const hour = String(at.getUTCHours()).padStart(2, "0");
  const minute = String(at.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hour}:${minute} UTC`;
}

/**
 * Both failure modes a link can have, stated rather than thrown at a person.
 *
 * A link carries the agreement id *and* the recipient's address, because
 * together they are the agreement's identity on chain — so a bare id is a bad
 * link rather than a missing agreement, and the two are worth telling apart.
 */
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
  const expiresAtHuman = humanDate(agreement.expiresAt);
  const nowHuman = humanDate(view.now);

  /**
   * The technical details disclosure: every protocol fact about this agreement,
   * in one place, closed until asked for.
   *
   * Server-rendered and handed to the client card as children — the facts come
   * from chain reads that only the server does, and passing them as props would
   * be the same bytes with more ceremony.
   */
  const technical = (
    <>
      <dl className="flint-terms" style={{ marginTop: "var(--flint-space-3)" }}>
        <Term term="Status">
          <code>{agreement.status}</code>
          {view.expired && agreement.status === "funded" ? " (past its deadline)" : ""}
        </Term>
        <Term term="Amount">
          <span className="flint-num">{agreement.amount}</span> base units —{" "}
          <span className="flint-num">{view.amountDisplay}</span>{" "}
          <AssetLabel symbol={view.symbol} />
          {view.decimals === null ? " (the asset's scale could not be read)" : ""}
        </Term>
        <Term term="Asset">
          <a href={`https://explorer.solana.com/address/${agreement.asset}?cluster=${CLUSTER}`}>
            <code>{agreement.asset}</code>
          </a>
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
          <span className="flint-num">{expiresAtHuman}</span>{" "}
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
        {agreement.memo === "" ? null : <Term term="Note as written">{agreement.memo}</Term>}
        {agreement.disputedFlag ? (
          <Term term="Disputed">
            flagged{agreement.disputedAt === null ? "" : ` at ${agreement.disputedAt}`}. Advisory
            only — it never moves money and never blocks a refund.
          </Term>
        ) : null}
      </dl>

      <p className="flint-fine">
        A receipt is the <em>settlement</em> transaction — the release or the refund. Flint stores
        none: it is derived from the chain, so paste the signature into the verification page and
        it is recomputed against the account rather than trusted.
      </p>
      <p className="flint-row">
        <Link href="/verify">Verify a receipt</Link>
        <Link href="/docs">How an agreement works</Link>
      </p>
    </>
  );

  return (
    <div className="flint-stack">
      <PaymentRequest
        id={view.id}
        recipient={view.recipient}
        pda={view.pda}
        title={agreement.title}
        memo={agreement.memo}
        amountDisplay={view.amountDisplay}
        symbol={view.symbol}
        status={agreement.status}
        expired={view.expired}
        expiresAtHuman={expiresAtHuman}
        nowHuman={nowHuman}
        cluster={CLUSTER}
        technical={technical}
      />

      {/* Funded is the only state with a choice in it, and the payer is the one
          who makes it (4.2) — so this is the only state that renders the panel. */}
      {agreement.status === "funded" ? (
        <SettlementPanel
          id={view.id}
          recipient={view.recipient}
          amountDisplay={view.amountDisplay}
          symbol={view.symbol}
          status={agreement.status}
          expired={view.expired}
          payerAddress={agreement.payerAddress}
          expiresAtIso={expiresAtHuman}
          secondsUntilExpiry={view.secondsUntilExpiry}
        />
      ) : null}
    </div>
  );
}
