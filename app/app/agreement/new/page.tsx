/**
 * Create an agreement — the recipient's side (acceptance 7.1.1).
 *
 * The recipient is a freelancer defining terms and asking to be paid; the page
 * therefore has to be good at *explaining consequences*, not at collecting
 * fields. Three of them are explained inline as they are filled in, because each
 * one binds someone to something:
 *
 *   - the amount is **fixed once funded**, and the first wallet to fund it becomes
 *     the payer permanently (Section 4.2). There is no negotiation afterwards.
 *   - the condition is `manual-confirmation` and can only be that: v1 has one
 *     enforced condition, and the payer releases the money by signing
 *     (Section 4.3). `oracle-attested` is a schema value that is deliberately not
 *     implemented, so it is not offered as a choice.
 *   - the expiry is the deadline after which the recipient can never be paid and
 *     the payer can take the money back (Section 4.2). Hence the warning about
 *     short expiries.
 *
 * On success the outcome is a **Blink** — a shareable Solana Actions URL, not
 * just a link to our page. That is the actual product of this page: an agreement
 * that a client can unfurl and pay, with no Flint account needed on the payer's
 * side. The plain page link is offered next to it because some recipients will
 * send a link to a person rather than a Blink into a chat.
 *
 * Structure only, per Section 9. No styling decisions of my own.
 */

import Link from "next/link";
import { readHumanConfig } from "@/lib/config";
import { CLUSTER, getConnection } from "@/lib/solana";
import { getMint } from "@solana/spl-token";
import { DEFAULT_CONDITION_DESCRIPTION } from "@/lib/flint-program";
import { CreateForm } from "@/components/create-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "Create a payment agreement — Flint" };

/** Sensible expiries offered as presets, in minutes. */
const EXPIRY_PRESETS = [
  { minutes: 60, label: "1 hour" },
  { minutes: 1440, label: "24 hours" },
  { minutes: 10080, label: "7 days" },
  { minutes: 43200, label: "30 days" },
];

/** Review windows offered as presets, in seconds. */
const REVIEW_WINDOW_PRESETS = [
  { seconds: 6 * 60 * 60, label: "6 hours" },
  { seconds: 12 * 60 * 60, label: "12 hours" },
  { seconds: 24 * 60 * 60, label: "24 hours" },
  { seconds: 48 * 60 * 60, label: "48 hours" },
];

export default async function NewAgreementPage() {
  let config = null;
  let decimals: number | null = null;
  try {
    config = readHumanConfig();
    decimals = (await getMint(getConnection(), config.assetMint)).decimals;
  } catch (error) {
    console.error("create page unavailable:", error);
  }

  if (config === null) {
    return (
      <div className="flint-stack">
        <header>
          <p className="flint-eyebrow">Recipient</p>
          <h1 className="flint-page-title">Create a payment agreement</h1>
        </header>
        <div className="flint-card flint-measure">
          <p className="flint-note flint-error">
            Payment requests are temporarily unavailable on this deployment.
          </p>
          <p style={{ marginTop: "var(--flint-space-4)" }}>
            <Link href="/">Back to the Flint overview</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* The form owns the page heading and the explanation of who is signing: it
          is the component that knows which step is on screen. */}
      <CreateForm
        assetMint={config.assetMint.toBase58()}
        assetSymbol={config.assetSymbol}
        decimals={decimals}
        expiryPresets={EXPIRY_PRESETS}
        reviewWindowPresets={REVIEW_WINDOW_PRESETS}
        conditionDescription={DEFAULT_CONDITION_DESCRIPTION}
        cluster={CLUSTER}
      />

      <section className="flint-block" aria-labelledby="what-next">
        <h2 id="what-next">What happens after you share it</h2>
        <div className="flint-card">
          <ol className="flint-list flint-muted">
            <li>A payer opens your link in a Solana wallet and approves it.</li>
            <li>
              The exact amount moves into the agreement&rsquo;s own escrow account.
              The agreement becomes <code>funded</code>, and that wallet is recorded
              as the payer.
            </li>
            <li>
              When the work is done, you mark it as delivered and attach proof: files,
              links or a note. A fingerprint of that proof is recorded on-chain, and
              the expiry stops applying.
            </li>
            <li>
              The payer reviews your proof and releases the funds, or raises a
              dispute. If they do neither within the review window you chose, the
              funds are released to you automatically.
            </li>
            <li>
              If the expiry passes before you deliver, the payer can take the money
              back, and anyone can trigger that refund.
            </li>
          </ol>
          <p
            className="flint-note"
            style={{ fontSize: "var(--flint-text-sm)", marginTop: "var(--flint-space-4)" }}
          >
            <strong>Why this protects you:</strong> the money is held in escrow, so the
            payer cannot withdraw it after you deliver. Anyone can check your proof
            against the on-chain record on the Verify page, and disputed agreements
            are decided by the arbiter.
          </p>
        </div>
      </section>
    </>
  );
}
