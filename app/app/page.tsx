/**
 * The Overview — the front door, rebuilt around one question: *what can I do here?*
 *
 * Everything this page used to lead with (the schema table, the state machine, the
 * condition grammar, the environment block) is reference material: correct, worth
 * keeping, and useless to someone who has never used Flint and wants to make a
 * payment. That material now lives under Docs, and this page does the four things a
 * first visit actually needs — say what it is in a sentence, show the shape of the
 * flow, name the two audiences, and state the boundary honestly.
 *
 * The two buttons are the two actions worth taking before anyone reads anything.
 */

import Link from "next/link";

const STEPS = [
  {
    at: "01",
    title: "Create",
    body: "The recipient sets the amount, the expiry and the condition, then shares one link.",
  },
  {
    at: "02",
    title: "Fund",
    body: "Whoever funds it first becomes the payer. The terms lock permanently.",
  },
  {
    at: "03",
    title: "Release or refund",
    body: "The payer confirms delivery, or takes the money back once it has expired.",
  },
  {
    at: "04",
    title: "Verify",
    body: "Ten checks over the settlement, recomputed from the chain rather than from us.",
  },
] as const;

const GUARANTEES = [
  "Fixed amount and asset",
  "Real escrow with an expiry",
  "Payer-signed release",
  "Deterministic agent policy",
  "Verifiable receipt",
] as const;

const REFUSALS = [
  "Partial settlement",
  "Arbitrated disputes",
  "Oracle conditions",
  "Recurring payments",
  "Cross-chain settlement",
] as const;

export default function OverviewPage() {
  return (
    <div className="flint-stack">
      <section className="flint-hero">
        <p className="flint-eyebrow">FRS-1 on Solana</p>
        <h1 className="flint-display">Payments that hold until the work is done.</h1>
        <p className="flint-lede">
          A fixed amount goes into escrow, a condition decides the release, and every
          settlement can be checked on chain by anyone. One protocol for people, and for
          software agents.
        </p>
        <div className="flint-row" style={{ marginTop: "1.75rem", gap: "0.75rem" }}>
          <Link href="/agreement/new" className="flint-button flint-primary">
            Create an agreement
          </Link>
          <Link href="/verify" className="flint-button">
            Verify a receipt
          </Link>
        </div>
      </section>

      <div className="flint-grid flint-cols-4">
        {STEPS.map((step) => (
          <div className="flint-card flint-step" key={step.at}>
            <b>{step.at}</b>
            <h3>{step.title}</h3>
            <p className="flint-muted">{step.body}</p>
          </div>
        ))}
      </div>

      <div className="flint-grid flint-cols-2">
        <div className="flint-card">
          <p className="flint-eyebrow">For people</p>
          <h3>A freelancer shares a Blink</h3>
          <p className="flint-muted">
            The client opens the link in their wallet, funds the escrow, and confirms
            delivery. No account, no invoice software.
          </p>
        </div>
        <div className="flint-card">
          <p className="flint-eyebrow">For agents</p>
          <h3>A priced endpoint answers 402</h3>
          <p className="flint-muted">
            The agent checks a deterministic spend policy, pays through x402, and logs
            why. No model decides whether money moves.
          </p>
        </div>
      </div>

      <section className="flint-block" aria-labelledby="guarantees-heading">
        <h2 id="guarantees-heading">What v1 guarantees, and what it refuses to</h2>
        <div className="flint-card">
          <div className="flint-grid flint-cols-2">
            <div>
              <h3>Guaranteed by the program</h3>
              <ul className="flint-checks" style={{ marginTop: "0.75rem" }}>
                {GUARANTEES.map((item) => (
                  <li key={item}>
                    <span>{item}</span>
                    <span className="flint-tag flint-tag-ok">Yes</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Out of scope by design</h3>
              <ul className="flint-checks" style={{ marginTop: "0.75rem" }}>
                {REFUSALS.map((item) => (
                  <li key={item}>
                    <span>{item}</span>
                    <span className="flint-tag flint-tag-no">No</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="flint-muted" style={{ fontSize: "var(--flint-text-sm)", marginTop: "1.25rem" }}>
            A receipt proves a state transition happened for a specific amount, signed by
            the address the program required. It does not prove the real-world work was
            delivered — that is the payer&rsquo;s attestation, not a cryptographic fact.
          </p>
        </div>
      </section>
    </div>
  );
}
