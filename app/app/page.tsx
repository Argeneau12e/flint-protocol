/**
 * Flint's front door.
 *
 * Two jobs, and it says both out loud: explain the FRS-1 boundary in one place
 * (the schema, the state machine, what is deliberately not implemented), and point
 * at the two things you can actually *do* right now — run the test agent against the
 * priced endpoint, or verify a receipt. Structure only; the design track owns
 * everything visual (FLINT_BUILD_CONTEXT.md Section 9).
 */

import Link from "next/link";
import {
  FRS1_ENFORCED_CONDITION_TYPES,
  FRS1_FIELDS,
  FRS1_STATUSES,
  FRS1_TERMINAL_STATUSES,
} from "@/lib/frs1-types";
import { CLUSTER, RPC_URL } from "@/lib/solana";

const BOUNDARY_YES = [
  "fixed amount and fixed asset",
  "explicit recipient, and an explicit payer once funded",
  "expiry",
  "escrow: funds sit in the agreement's own token account, not the payer's",
  "one mechanically enforced condition — payer-signed manual confirmation",
  "deterministic agent spend policy (no LLM in the pay/no-pay path)",
  "a verifiable receipt for each settlement",
];

const BOUNDARY_NO = [
  "partial settlement — an agreement pays its full amount or nothing",
  "arbitrated or subjective disputes (the dispute flag never moves funds)",
  "oracle-attested or any real-world conditions",
  "multi-party escrow, milestones, recurring payments",
  "cross-chain settlement; this build is Solana-only",
];

const NOT_BUILT_YET = [
  "the human flow: the Blink landing page and wallet connect (Phase 3)",
  "a listing of live agreements, and anything that touches mainnet (Phase 4)",
  "a facilitator: the x402 envelope is real, but settlement is FRS-1 escrow, verified by recomputation from chain rather than by a facilitator's word",
];

export default function HomePage() {
  return (
    <div className="flint-shell">
      <h1 className="text-2xl font-semibold">Flint — FRS-1 payment agreements</h1>
      <p className="flint-muted mt-2">
        An escrowed, expiring payment agreement on Solana: a fixed amount, a fixed
        asset, a real escrow, an expiry, and a settlement you can verify afterwards
        from the chain. This build is at Phase 2 of 5 — the escrow program and the
        agent/x402 flow work end to end on devnet.
      </p>

      <nav aria-label="Try it" className="mt-4 flex flex-wrap gap-3">
        <Link className="flint-button" href="/agent">
          Run the test agent
        </Link>
        <Link className="flint-button" href="/verify/">
          Verify a receipt
        </Link>
      </nav>

      {/* TODO-DESIGN: status/progress indicator slot. */}
      <section className="flint-section" aria-labelledby="boundary-heading">
        <h2 id="boundary-heading" className="text-lg font-semibold">
          What FRS-1 v1 guarantees — and what it deliberately does not
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="font-medium">Guaranteed</h3>
            <ul className="flint-list flint-muted mt-1">
              {BOUNDARY_YES.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-medium">Explicitly out of scope</h3>
            <ul className="flint-list flint-muted mt-1">
              {BOUNDARY_NO.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="flint-note mt-4 text-sm">
          A receipt proves that a specific state transition happened, for a
          specific amount and asset, signed by the address the program required.
          It does not prove that the real-world work was delivered — that is the
          payer&rsquo;s attestation, not a cryptographic fact.
        </p>
      </section>

      <section className="flint-section" aria-labelledby="schema-heading">
        <h2 id="schema-heading" className="text-lg font-semibold">
          FRS-1 agreement schema
        </h2>
        <p className="flint-muted mt-1 text-sm">
          Every field, rendered from <code>app/lib/frs1-types.ts</code> — the
          TypeScript mirror of <code>programs/flint-escrow/src/state.rs</code>.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="flint-table">
            <caption>FRS-1 v1 agreement object</caption>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Type</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {FRS1_FIELDS.map((field) => (
                <tr key={field.name}>
                  <th scope="row">
                    <code>{field.name}</code>
                  </th>
                  <td>
                    <code>{field.type}</code>
                  </td>
                  <td className="flint-muted">{field.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flint-section" aria-labelledby="status-heading">
        <h2 id="status-heading" className="text-lg font-semibold">
          Status state machine
        </h2>
        <p className="flint-muted mt-1 text-sm">
          The recipient proposes an agreement; whoever funds it first becomes the
          payer, permanently. Released and refunded are terminal — nothing
          transitions out of them.
        </p>
        <ul className="flint-list mt-3">
          {FRS1_STATUSES.map((status) => {
            const terminal = FRS1_TERMINAL_STATUSES.includes(status);
            return (
              <li key={status}>
                <code>{status}</code>
                <span
                  className={
                    terminal
                      ? "flint-badge flint-badge-terminal"
                      : "flint-badge"
                  }
                >
                  {terminal ? "terminal" : "transient"}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flint-section" aria-labelledby="condition-heading">
        <h2 id="condition-heading" className="text-lg font-semibold">
          Conditions
        </h2>
        <p className="flint-muted mt-1 text-sm">
          v1 enforces exactly one condition type on-chain:{" "}
          <code>{FRS1_ENFORCED_CONDITION_TYPES.join(", ")}</code>.{" "}
          <code>oracle-attested</code> is a named schema value and is
          deliberately not implemented — no transition may ever depend on it, and
          a free-text description never gates anything.
        </p>
      </section>

      <section className="flint-section" aria-labelledby="env-heading">
        <h2 id="env-heading" className="text-lg font-semibold">
          Environment
        </h2>
        <dl className="mt-2 text-sm">
          <div className="flex gap-2">
            <dt className="font-medium">Cluster:</dt>
            <dd>
              <code>{CLUSTER}</code>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">RPC:</dt>
            <dd>
              <code>{RPC_URL}</code>
            </dd>
          </div>
        </dl>
      </section>

      <section className="flint-section" aria-labelledby="pending-heading">
        <h2 id="pending-heading" className="text-lg font-semibold">
          Not built yet
        </h2>
        <p className="flint-muted mt-1 text-sm">
          Listed so this page cannot be mistaken for a finished product.
        </p>
        <ul className="flint-list flint-muted mt-2">
          {NOT_BUILT_YET.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="flint-note mt-4 text-sm">
          Next: Phase 3 — the human flow. A freelancer shares an agreement as a
          Solana Blink; the client pays the same escrow program the agent pays, and
          both receipts verify the same way.
        </p>
      </section>

      {/* TODO-DESIGN: empty-state illustration slot for the future agreement list. */}
    </div>
  );
}
