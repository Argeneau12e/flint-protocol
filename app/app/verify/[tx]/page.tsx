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
import type { VerificationCheck } from "@/lib/verify";
import type { Frs1Agreement } from "@/lib/frs1-types";

export const dynamic = "force-dynamic";

/** The FRS-1 object, rendered field by field. */
function AgreementTable({ agreement }: { agreement: Frs1Agreement }) {
  const rows: Array<[string, string]> = [
    ["id", agreement.id],
    ["status", agreement.status],
    ["amount", `${agreement.amount} base units`],
    ["asset", agreement.asset],
    ["recipientAddress", agreement.recipientAddress],
    ["payerAddress", agreement.payerAddress ?? "— (not funded yet)"],
    ["escrowAddress", agreement.escrowAddress],
    ["expiresAt", `${agreement.expiresAt} (unix seconds, chain clock)`],
    ["condition", `${agreement.condition.type} — ${agreement.condition.description}`],
    ["title", agreement.title],
    ["memo", agreement.memo === "" ? "—" : agreement.memo],
    ["disputedFlag", String(agreement.disputedFlag)],
    ["disputedAt", agreement.disputedAt === null ? "—" : String(agreement.disputedAt)],
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
    <div className="mt-3 overflow-x-auto">
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
    <div className="mt-3 overflow-x-auto">
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
              <td>{check.passed ? "pass" : "FAIL"}</td>
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
  const connection = getConnection();

  let config;
  try {
    config = readConfig();
  } catch {
    config = null;
  }
  if (config === null) {
    return (
      <div className="flint-shell">
        <h1 className="text-2xl font-semibold">Verification unavailable</h1>
        <p className="flint-note mt-3">
          This deployment has no program configured, so a receipt cannot be
          recomputed. See <code>app/.env.example</code>.
        </p>
      </div>
    );
  }

  // A settlement signature gets the full receipt report; anything else is treated
  // as a payment claim. The transaction itself decides which — not the caller.
  const settlement = await verifySettlement(connection, config.programId, tx);
  const isSettlement = settlement.settlementKind !== null;
  const payment = isSettlement ? null : await verifyFunding(connection, config.programId, tx);
  const facts = isSettlement ? settlement.facts : payment?.facts ?? settlement.facts;
  const checks = isSettlement ? settlement.checks : payment?.checks ?? settlement.checks;
  const ok = isSettlement ? settlement.ok : payment?.ok ?? false;

  return (
    <div className="flint-shell">
      <h1 className="text-2xl font-semibold">Payment verification</h1>
      <p className="flint-muted mt-2">
        Everything below was recomputed from Solana devnet when this page was
        requested. Nothing is taken from the URL except the signature being checked,
        and a signature is treated as a claim, not as proof.
      </p>

      <p className="mt-3">
        <code>{tx}</code> <a href={explorerTxUrl(tx)}>view on explorer</a>
      </p>

      <section className="flint-section" aria-labelledby="verdict-heading">
        <h2 id="verdict-heading" className="text-lg font-semibold">
          Verdict
        </h2>
        <p className="flint-note mt-3">
          {ok
            ? isSettlement
              ? "Verified: this transaction settled the agreement on chain, and its signature is the receipt."
              : "Verified: this transaction funded the agreement, and the money is in its escrow."
            : "Not verified: at least one check failed. That is the expected answer for a fabricated or unrelated signature."}
        </p>
        <ChecksTable checks={checks} />
      </section>

      <section className="flint-section" aria-labelledby="agreement-heading">
        <h2 id="agreement-heading" className="text-lg font-semibold">
          The agreement
        </h2>
        {facts.agreement === null ? (
          <p className="flint-note mt-3">
            No FRS-1 agreement account is associated with this transaction.
            {facts.closed
              ? " The account does not exist — a cancelled agreement is closed, and a cancelled agreement never held funds."
              : ""}
          </p>
        ) : (
          <>
            <p className="flint-muted mt-1 text-sm">
              Agreement account{" "}
              <a href={explorerAddressUrl(facts.agreementPda)}>
                <code>{facts.agreementPda}</code>
              </a>
              {facts.escrowBalance === null ? null : (
                <>
                  {" "}
                  · escrow holds <code>{facts.escrowBalance}</code> base units of{" "}
                  <code>{facts.escrowMint}</code>
                </>
              )}
            </p>
            <AgreementTable agreement={facts.agreement} />
          </>
        )}
      </section>

      <section className="flint-section" aria-labelledby="limits-heading">
        <h2 id="limits-heading" className="text-lg font-semibold">
          What this receipt does and does not prove
        </h2>
        <p className="flint-note mt-3">
          It proves that a specific state transition happened, for a specific amount
          and asset, authorised by the address the program required. It does not
          prove the underlying work was delivered — that is the payer&rsquo;s
          attestation, and no signature can make it a fact.
        </p>
        <p className="mt-3">
          <Link href="/">Back to the Flint overview</Link>
        </p>
      </section>
    </div>
  );
}
