/**
 * The public verification page: "was this payment real, and did it settle?"
 *
 * Acceptance 7.2.5 requires this to work *identically* for an agent-settled
 * agreement and a human-settled one. It does, structurally: the page takes a
 * transaction signature and calls the same `verifyFunding` / `verifySettlement`
 * functions the x402 responder uses. No branch anywhere — in this file or in those
 * functions — asks who initiated the payment. One code path, one report, both
 * audiences.
 *
 * Everything rendered is recomputed from the chain on each request. Nothing is
 * read from the URL except the signature being checked, and a signature is treated
 * as a claim, not as proof.
 *
 * Structure only, per Section 9: semantic HTML, real headings, error states, no
 * styling decisions of my own.
 */

import Link from "next/link";
import { explorerAddressUrl, explorerTxUrl, getConnection } from "@/lib/solana";
import { readConfig } from "@/lib/config";
import { verifyFunding, verifySettlement } from "@/lib/verify";
import type { VerificationCheck, VerifyDisplay } from "@/lib/verify";
import type { Frs1Agreement } from "@/lib/frs1-types";
import { assetDisplay, formatBaseUnits } from "@/lib/display";
import { isTransactionSignature } from "@/lib/signature";
import { getMint } from "@solana/spl-token";

export const dynamic = "force-dynamic";

/** The FRS-1 object, rendered field by field. */
function AgreementTable({
  agreement,
  formatAmount,
}: {
  agreement: Frs1Agreement;
  formatAmount: (baseUnits: string, mint: string) => string;
}) {
  const rows: Array<[string, string]> = [
    ["id", agreement.id],
    ["status", agreement.status],
    ["amount", formatAmount(agreement.amount, agreement.asset)],
    ["asset", agreement.asset],
    ["recipientAddress", agreement.recipientAddress],
    ["payerAddress", agreement.payerAddress ?? "— (not funded yet)"],
    ["escrowAddress", agreement.escrowAddress],
    ["expiresAt", `${agreement.expiresAt} (unix seconds, chain clock)`],
    ["condition", `${agreement.condition.type} — ${agreement.condition.description}`],
    ["title", agreement.title],
    ["memo", agreement.memo === "" ? "—" : agreement.memo],
    ["reviewWindowSecs", String(agreement.reviewWindowSecs)],
    ["claimedAt", agreement.claimedAt === null ? "—" : String(agreement.claimedAt)],
    ["evidenceHash", agreement.evidenceHash],
    ["evidenceRef", agreement.evidenceRef === "" ? "—" : agreement.evidenceRef],
    ["disputedAt", agreement.disputedAt === null ? "—" : String(agreement.disputedAt)],
    ["arbiterDeadline", agreement.arbiterDeadline === null ? "—" : String(agreement.arbiterDeadline)],
    ["disputeReason", agreement.disputeReason ?? "—"],
    ["feeAmount", agreement.feeAmount],
    ["handle", agreement.handle ?? "—"],
    [
      "agentPolicy",
      agreement.agentPolicy === undefined
        ? "—"
        : `spendCap ${agreement.agentPolicy.spendCap}, ${agreement.agentPolicy.allowlist.length} allowlisted recipient(s)`,
    ],
    ["receiptProof", agreement.receiptProof ?? "— (not settled)"],
  ];
  return (
    <div className="flint-scroll-x" style={{ marginTop: "var(--flint-space-4)" }}>
      <table className="flint-table">
        <caption>FRS-1 agreement, recomputed from chain</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([field, value]) => (
            <tr key={field}>
              <th scope="row">
                <code>{field}</code>
              </th>
              <td>
                <code>{value}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every check, passes included: the report is the evidence. */
function ChecksTable({ checks }: { checks: VerificationCheck[] }) {
  return (
    <div className="flint-scroll-x" style={{ marginTop: "var(--flint-space-4)" }}>
      <table className="flint-table">
        <caption>Checks, all of them</caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Result</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => (
            <tr key={check.name}>
              <th scope="row">
                <code>{check.name}</code>
              </th>
              <td>
                <span
                  className={`flint-tag ${check.passed ? "flint-tag-ok" : "flint-tag-no"}`}
                >
                  {check.passed ? "pass" : "FAIL"}
                </span>
              </td>
              <td className="flint-muted">{check.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function VerifyPage({
  params,
}: {
  params: Promise<{ tx: string }>;
}) {
  const { tx } = await params;

  // Shape first: a malformed deep link gets an explanation and two ways out,
  // not an exception page and not a chain round-trip destined to fail (5a).
  if (!isTransactionSignature(tx)) {
    return (
      <div className="flint-stack">
        <header>
          <p className="flint-eyebrow">Receipt</p>
          <h1 className="flint-page-title">That is not a transaction signature</h1>
        </header>
        <div className="flint-card flint-measure">
          <p className="flint-note flint-error">
            A receipt&rsquo;s signature is 64 bytes encoded as base58 — usually 87–88
            characters, letters and digits only. The URL contained something else, so
            there is nothing here to verify.
          </p>
          <div className="flint-row" style={{ marginTop: "var(--flint-space-4)" }}>
            <Link className="flint-button flint-primary" href="/verify">
              Look up a different signature
            </Link>
            <Link className="flint-button" href="/">
              Back to the Flint overview
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const connection = getConnection();

  let config;
  try {
    config = readConfig();
  } catch {
    config = null;
  }
  if (config === null) {
    return (
      <div className="flint-stack">
        <header>
          <p className="flint-eyebrow">Receipt</p>
          <h1 className="flint-page-title">Verification unavailable</h1>
        </header>
        <div className="flint-card flint-measure">
          <p className="flint-note flint-error">
            This deployment has no program configured, so a receipt cannot be
            recomputed. See <code>app/.env.example</code>.
          </p>
        </div>
      </div>
    );
  }

  // A settlement signature gets the full receipt report; anything else is treated
  // as a payment claim. The transaction itself decides which — not the caller.
  // The deployment's own asset, so every amount renders as a figure with its
  // symbol instead of raw base units (Phase 5a). An agreement on some *other*
  // mint deliberately gets no symbol and no scale: never label a mint with a
  // symbol that was not confirmed for it, and never guess a scale.
  let display: VerifyDisplay | undefined;
  try {
    const mint = await getMint(connection, config.assetMint);
    display = {
      mint: config.assetMint.toBase58(),
      decimals: mint.decimals,
      symbol: assetDisplay(config.assetSymbol).label,
    };
  } catch {
    display = undefined;
  }
  const formatAmount = (baseUnits: string, mintAddress: string): string =>
    display !== undefined && mintAddress === display.mint
      ? `${formatBaseUnits(baseUnits, display.decimals)}${
          display.symbol ? ` ${display.symbol}` : ""
        }`
      : `${baseUnits} base units`;

  const settlement = await verifySettlement(connection, config.programId, tx, display);
  const isSettlement = settlement.settlementKind !== null;
  const payment = isSettlement ? null : await verifyFunding(connection, config.programId, tx, undefined, display);
  const facts = isSettlement ? settlement.facts : payment?.facts ?? settlement.facts;
  const checks = isSettlement ? settlement.checks : payment?.checks ?? settlement.checks;
  const ok = isSettlement ? settlement.ok : payment?.ok ?? false;

  return (
    <div className="flint-stack">
      <header>
        <p className="flint-eyebrow">Receipt</p>
        <h1 className="flint-page-title">Payment verification</h1>
        <p className="flint-muted" style={{ marginTop: "var(--flint-space-3)" }}>
          Everything below was recomputed from Solana devnet when this page was
          requested. Nothing is taken from the URL except the signature being checked,
          and a signature is treated as a claim, not as proof.
        </p>
      </header>

      <div className="flint-card flint-row flint-row-between">
        <code className="flint-num">{tx}</code>
        <a className="flint-button" href={explorerTxUrl(tx)}>
          View on explorer
        </a>
      </div>

      <section className="flint-card" aria-labelledby="verdict-heading">
        <h2 id="verdict-heading">Verdict</h2>
        <p className={`flint-note ${ok ? "flint-success" : "flint-error"}`} style={{ marginTop: "var(--flint-space-4)" }}>
          {ok
            ? isSettlement
              ? "Verified: this transaction settled the agreement on chain, and its signature is the receipt."
              : "Verified: this transaction funded the agreement, and the money is in its escrow."
            : "Not verified: at least one check failed. That is the expected answer for a fabricated or unrelated signature."}
        </p>
        <ChecksTable checks={checks} />
      </section>

      <section className="flint-card" aria-labelledby="agreement-heading">
        <h2 id="agreement-heading">The agreement</h2>
        {facts.agreement === null ? (
          <p className="flint-note" style={{ marginTop: "var(--flint-space-4)" }}>
            No FRS-1 agreement account is associated with this transaction.
            {facts.closed
              ? " The account does not exist — a cancelled agreement is closed, and a cancelled agreement never held funds."
              : ""}
          </p>
        ) : (
          <>
            <p className="flint-muted" style={{ marginTop: "var(--flint-space-3)" }}>
              Agreement account{" "}
              <a href={explorerAddressUrl(facts.agreementPda)}>
                <code>{facts.agreementPda}</code>
              </a>
              {facts.escrowBalance === null ? null : (
                <>
                  {" "}
                  · escrow holds{" "}
                  <code>{formatAmount(facts.escrowBalance, facts.escrowMint ?? "")}</code>
                </>
              )}
            </p>
            <AgreementTable agreement={facts.agreement} formatAmount={formatAmount} />
          </>
        )}
      </section>

      <section className="flint-card flint-measure" aria-labelledby="limits-heading">
        <h2 id="limits-heading">What this receipt does and does not prove</h2>
        <p className="flint-muted" style={{ marginTop: "var(--flint-space-3)" }}>
          It proves that a specific state transition happened, for a specific amount
          and asset, authorised by the address the program required. It does not
          prove the underlying work was delivered — that is the payer&rsquo;s
          attestation, and no signature can make it a fact.
        </p>
      </section>
    </div>
  );
}
