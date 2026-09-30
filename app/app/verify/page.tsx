/**
 * `/verify` — the index the landing page's "Verify a receipt" button points at
 * (Phase 5a: it previously pointed at a route that did not exist, and a 404 is
 * a dead end).
 *
 * One job: take a transaction signature, check its shape, and hand off to the
 * existing `/verify/[tx]` report. The validation lives in the client form so a
 * malformed value never navigates; this shell stays a server component so the
 * page carries its own metadata like the rest of the site.
 */

import { VerifyLookupForm } from "@/components/verify-lookup";

export const metadata = { title: "Verify a receipt — Flint" };

export default function VerifyIndexPage() {
  return (
    <div className="flint-stack">
      <header>
        <p className="flint-eyebrow">Receipts</p>
        <h1 className="flint-page-title">Verify a receipt</h1>
        <p className="flint-muted" style={{ fontSize: "var(--flint-text-lg)" }}>
          Every Flint settlement produces a receipt: the signature of the transaction that
          released — or refunded — the money. Paste it here and the result is recomputed
          from the chain, nothing else.
        </p>
      </header>

      <div className="flint-card flint-measure">
        <VerifyLookupForm />
      </div>
    </div>
  );
}
