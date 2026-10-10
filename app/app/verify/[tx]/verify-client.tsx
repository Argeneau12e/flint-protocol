/** Proof snapshot for a verification receipt: the evidence hash, its reference,
 *  the settlement receipt, and any dispute fields. Rendered by the /verify/[tx]
 *  report; read-only, no client logic.
 *
 * Puts the three facts a receipt must carry on screen: what was claimed, the
 * evidence that backs it, and the transaction that settled the claim.
 */

import type { Frs1Agreement } from "@/lib/frs1-types";

/** `agreement` may be null when no FRS-1 agreement account exists for the tx. */
interface VerifyProofCardProps {
  /** The FRS-1 agreement recomputed from the chain for this transaction. */
  agreement: Frs1Agreement | null;
}

/** A 64-character hex sha256 whose value is all zeros means "no claim yet". */
function isZeroHash(value: string): boolean {
  return value === "0".repeat(64);
}

export function VerifyProofCard({ agreement }: VerifyProofCardProps) {
  if (agreement === null) {
    return (
      <div className="flint-card">
        <h2 id="proof-heading">The proof</h2>
        <p className="flint-note" style={{ marginTop: "var(--flint-space-4)" }}>
          No FRS-1 agreement account is associated with this transaction.
        </p>
      </div>
    );
  }
  const disclosedEvidence =
    agreement.evidenceHash !== "" && !isZeroHash(agreement.evidenceHash);

  return (
    <div className="flint-card">
      <h2 id="proof-heading">The proof</h2>

      {disclosedEvidence ? (
        <div className="flint-row flint-row-between" style={{ marginTop: "var(--flint-space-4)" }}>
          <span className="flint-eyebrow">Evidence hash</span>
          <code className="flint-num">{agreement.evidenceHash}</code>
        </div>
      ) : (
        <p
          className="flint-note"
          style={{ marginTop: "var(--flint-space-4)" }}
        >
          No claim has been filed for this agreement yet.
        </p>
      )}

      {agreement.evidenceRef !== "" ? (
        <div
          className="flint-row flint-row-between"
          style={{ marginTop: "var(--flint-space-2)" }}
        >
          <span className="flint-muted">Evidence reference</span>
          <code className="flint-num flint-break">{agreement.evidenceRef}</code>
        </div>
      ) : null}

      {agreement.receiptProof !== undefined && agreement.receiptProof !== null ? (
        <div
          className="flint-row flint-row-between"
          style={{ marginTop: "var(--flint-space-2)" }}
        >
          <span className="flint-muted">Settlement receipt</span>
          <a className="flint-button" href={`https://explorer.solana.com/tx/${agreement.receiptProof}`}>
            View on explorer
          </a>
        </div>
      ) : null}

      {agreement.disputedAt !== null ? (
        <div className="flint-card" style={{ marginTop: "var(--flint-space-4)" }}>
          <p className="flint-note flint-error" style={{ marginTop: "var(--flint-space-4)" }}>
            Disputed — the payer rejected the delivery claim.
          </p>

          {agreement.disputeReason !== null ? (
            <div
              className="flint-row flint-row-between"
              style={{ marginTop: "var(--flint-space-2)" }}
            >
              <span className="flint-muted">Reason</span>
              <code className="flint-num">{agreement.disputeReason}</code>
            </div>
          ) : null}

          {agreement.arbiterDeadline !== null ? (
            <div
              className="flint-row flint-row-between"
              style={{ marginTop: "var(--flint-space-2)" }}
            >
              <span className="flint-muted">Arbiter deadline</span>
              <code className="flint-num">
                {new Date(agreement.arbiterDeadline * 1000).toLocaleString()}
              </code>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
