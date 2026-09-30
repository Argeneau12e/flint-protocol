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
import { readConfig } from "@/lib/config";
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

export default async function NewAgreementPage() {
  let config = null;
  let configError: string | null = null;
  let decimals: number | null = null;
  try {
    config = readConfig();
    decimals = (await getMint(getConnection(), config.assetMint)).decimals;
  } catch (error) {
    configError = (error as Error).message;
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
            This deployment is not configured, so agreements cannot be created.
            <br />
            <code>{configError}</code>
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
        conditionDescription={DEFAULT_CONDITION_DESCRIPTION}
        cluster={CLUSTER}
      />

      <section className="flint-block" aria-labelledby="what-next">
        <h2 id="what-next">What happens after you share it</h2>
        <div className="flint-card">
          <ol className="flint-list flint-muted">
            <li>A payer opens the Blink in a Solana wallet and approves it.</li>
            <li>
              The exact amount moves into the agreement&rsquo;s own escrow account.
              The agreement becomes <code>funded</code>, and that wallet is recorded
              as the payer.
            </li>
            <li>
              The payer releases the money to you by signing a confirmation. That
              signature is the receipt, and it can be verified by anyone afterwards.
            </li>
            <li>
              If the expiry passes with no confirmation, the money goes back to the
              payer instead — and anyone can trigger that refund, including you.
            </li>
          </ol>
          <p
            className="flint-note"
            style={{ fontSize: "var(--flint-text-sm)", marginTop: "var(--flint-space-4)" }}
          >
            <strong>About the condition:</strong> v1 enforces exactly one condition
            type, <code>manual-confirmation</code> — the payer signs to release the
            funds. There is no automated or oracle-checked condition in this build,
            so nothing about the work itself is verified on chain. A receipt proves
            the payment happened; it does not prove the work was delivered.
          </p>
        </div>
      </section>
    </>
  );
}
