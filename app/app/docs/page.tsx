/**
 * `/docs` — the reference material, moved off the front door.
 *
 * The Overview previously carried the agreement schema, the state machine, the
 * condition grammar, the environment block and the out-of-scope list. All of it is
 * true and all of it belongs somewhere; none of it helps a first-time visitor make a
 * payment, and mixing a field table into a call to action is the specific way a page
 * stops feeling easy.
 *
 * So: this page is the contract in plain view, and it is generated from the same
 * `lib/frs1-types.ts` the program's `state.rs` is mirrored from — the table cannot
 * drift from the code that reads it, which is the only reason to publish it at all.
 */

import {
  FRS1_ENFORCED_CONDITION_TYPES,
  FRS1_FIELDS,
  FRS1_STATUSES,
  FRS1_TERMINAL_STATUSES,
} from "@/lib/frs1-types";
import { CLUSTER, COMMITMENT, RPC_URL } from "@/lib/solana";
import { DEFAULT_PROGRAM_ID, USDC_DEVNET_MINT } from "@/lib/config";

export const metadata = { title: "Docs — Flint" };

/**
 * What the program enforces versus what it declines. Stated as a pair because the
 * refusals are the load-bearing half: a reader who knows what is *not* implemented
 * knows exactly how much trust each side still owes the other.
 */
const IN_SCOPE = [
  ["Amount and asset", "Both fixed at creation, in the agreement's own base units."],
  ["Parties", "An explicit recipient, and an explicit payer captured at funding."],
  ["Escrow", "Funds sit in the agreement's own token account, never the payer's."],
  ["Expiry", "A chain-clock deadline after which the payer may withdraw."],
  ["Release condition", "Exactly one type is enforced: payer-signed manual confirmation."],
  ["Agent payments", "A deterministic spend policy — no model in the pay / no-pay path."],
  ["Receipts", "A settlement re-derivable from chain data by anyone."],
] as const;

const OUT_OF_SCOPE = [
  ["Partial settlement", "An agreement pays its full amount or nothing."],
  ["Arbitrated disputes", "The dispute flag records a claim and never moves funds."],
  ["Oracle conditions", "`oracle-attested` is named in the schema and not implemented."],
  ["Milestones and recurring", "Multi-party escrow is out of v1 entirely."],
  ["Cross-chain", "This build is Solana-only, devnet-only."],
] as const;

const NOT_BUILT = [
  "A listing of live agreements. Every agreement is reachable by its link, and by nothing else.",
  "Mainnet. This deployment is devnet-only, deliberately.",
  "A facilitator. The x402 envelope is real; settlement is FRS-1 escrow, verified by recomputation from chain rather than by a facilitator's word.",
] as const;

export default function DocsPage() {
  return (
    <div className="flint-stack">
      <header>
        <p className="flint-eyebrow">Reference</p>
        <h1 className="flint-page-title">How an agreement works</h1>
      </header>

      <div className="flint-card flint-prose">
        <p>
          Flint is a fixed-sum escrow with one release condition and a deadline. The
          recipient names the terms; the first person to fund it becomes the payer and
          locks those terms forever; the money moves when the payer signs a release, or
          back to the payer after expiry. Every claim on this site is recomputed from
          chain data, including this page&rsquo;s schema table, which is rendered from the
          same types the client reads.
        </p>
      </div>

      <section className="flint-block" aria-labelledby="scope-heading">
        <h2 id="scope-heading">Guaranteed, and refused</h2>
        <div className="flint-grid flint-cols-2">
          <div className="flint-card">
            <h3>Guaranteed</h3>
            <dl className="flint-kv-group">
              {IN_SCOPE.map(([term, note]) => (
                <div className="flint-kv" key={term}>
                  <dt>{term}</dt>
                  <dd className="flint-muted">{note}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="flint-card">
            <h3>Refused by design</h3>
            <dl className="flint-kv-group">
              {OUT_OF_SCOPE.map(([term, note]) => (
                <div className="flint-kv" key={term}>
                  <dt>{term}</dt>
                  <dd className="flint-muted">{note}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <section className="flint-block" aria-labelledby="lifecycle-heading">
        <h2 id="lifecycle-heading">The lifecycle</h2>
        <div className="flint-card">
          <p className="flint-muted flint-fine">
            <code>pending</code> is the only state with money in it that has not been
            decided. <code>released</code> and <code>refunded</code> are terminal — no
            instruction transitions out of either, which is what makes a receipt final.
          </p>
          <div className="flint-row" style={{ marginTop: "1rem" }}>
            {FRS1_STATUSES.map((status) => (
              <span
                className={
                  FRS1_TERMINAL_STATUSES.includes(status)
                    ? "flint-tag flint-tag-gold"
                    : "flint-tag"
                }
                key={status}
                title={
                  FRS1_TERMINAL_STATUSES.includes(status)
                    ? "Terminal: nothing transitions out of this state"
                    : "Transient: an instruction can move on from this state"
                }
              >
                {status}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="flint-block" aria-labelledby="conditions-heading">
        <h2 id="conditions-heading">The one condition that is enforced</h2>
        <div className="flint-card flint-prose">
          <p>
            <code>{FRS1_ENFORCED_CONDITION_TYPES.join(", ")}</code>. A release is valid
            when the transaction is signed by the address stored as the payer at funding.
            That is the whole rule.
          </p>
          <p className="flint-muted flint-fine">
            <code>oracle-attested</code> exists as a name in the schema so that a later
            version can add it without changing the shape of an agreement. No transition
            may depend on it today, and a free-text description never gates a payment.
          </p>
        </div>
      </section>
      <section className="flint-block" aria-labelledby="schema-heading">
        <h2 id="schema-heading">The agreement, field by field</h2>
        <div className="flint-card flint-card-flush">
          <div className="flint-scroll-x">
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
        </div>
      </section>

      <section className="flint-block" aria-labelledby="environment-heading">
        <h2 id="environment-heading">This deployment</h2>
        <div className="flint-card">
          <dl className="flint-kv-group">
            <div className="flint-kv">
              <dt>Cluster</dt>
              <dd className="flint-num">{CLUSTER}</dd>
            </div>
            <div className="flint-kv">
              <dt>Commitment</dt>
              <dd className="flint-num">{COMMITMENT}</dd>
            </div>
            <div className="flint-kv">
              <dt>Program</dt>
              <dd className="flint-num">{DEFAULT_PROGRAM_ID}</dd>
            </div>
            <div className="flint-kv">
              <dt>Asset (USDC devnet)</dt>
              <dd className="flint-num">{USDC_DEVNET_MINT}</dd>
            </div>
            <div className="flint-kv">
              <dt>RPC</dt>
              <dd className="flint-num">{RPC_URL}</dd>
            </div>
          </dl>
        </div>
      </section>
      <section className="flint-block" aria-labelledby="not-built-heading">
        <h2 id="not-built-heading">Not built yet</h2>
        <div className="flint-card flint-prose">
          <ul className="flint-list flint-muted">
            {NOT_BUILT.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="flint-muted flint-fine">
            Listed so this page cannot be mistaken for a finished product. Everything else
            &#32;— the escrow program, the Blink flow, the agent flow, the verifier — runs end
            to end on devnet.
          </p>
        </div>
      </section>
    </div>
  );
}
