/**
 * The create form, and the Blink it produces (acceptance 7.1.1).
 *
 * A controlled form with per-field validation, because the failures are specific
 * and the person filling it in is the one who has to understand them: "the amount
 * has to be a number with at most 6 decimal places" is actionable, "invalid
 * input" is not (Section 9).
 *
 * Two rules shape the flow:
 *
 *   1. **Nothing is signed until the terms are valid.** The submit button is
 *      disabled while a field is wrong, and the reason is shown next to the field
 *      rather than in a summary at the top that a person has to hunt for.
 *   2. **Success produces a share, not a dead end.** Creating an agreement is not
 *      the point — sharing it is. So the success state is the Blink URL, in a
 *      copyable field, with the plain page link beside it, and an explicit next
 *      step. A person who creates an agreement and then has nothing to send has
 *      not been given the thing they came for.
 *
 * The address that signs is the recipient's, and the form cannot proceed without
 * one, because the program makes the recipient the only signer of `create`
 * (Section 4.5).
 */

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionFeedback, ConnectButton, Field } from "@/components/agreement-ui";
import { parseDisplayAmount } from "@/lib/display";
import { useFlintWallet, useTransactionAction } from "@/lib/wallet";

/** The server's answer to a create request. */
interface Created {
  id: string;
  recipient: string;
  transaction: string;
  message: string;
}

/**
 * The explorer link, built here rather than passed in as a prop.
 *
 * A function cannot cross the server/client boundary — Next throws "Functions
 * cannot be passed directly to Client Components" at render time — and this page
 * is server-rendered, so the form takes the cluster name and builds the URL itself.
 * (The bug this fixes was invisible to `next build` and to every API-level test:
 * the create page is `force-dynamic`, so it only failed when actually requested.)
 */
function explorerTxUrl(signature: string, cluster: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}

export function CreateForm({
  assetMint,
  assetSymbol,
  decimals,
  expiryPresets,
  conditionDescription,
  cluster,
}: {
  assetMint: string;
  assetSymbol: string;
  decimals: number | null;
  expiryPresets: ReadonlyArray<{ minutes: number; label: string }>;
  conditionDescription: string;
  cluster: string;
}) {
  const router = useRouter();
  const { address, connected } = useFlintWallet();

  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [expiry, setExpiry] = useState<number>(expiryPresets[1]?.minutes ?? 1440);

  // Created state is separate from the action state: a create that succeeded
  // stays on screen, with its links, until the person asks for another one.
  const [created, setCreated] = useState<Created | null>(null);

  const scale = decimals ?? 0;
  const amountCheck = useMemo(() => parseDisplayAmount(amount, scale), [amount, scale]);

  // Validation mirrors the server's rules rather than trusting the server to be
  // the only line of defence: a person should not be made to approve a wallet
  // prompt for a transaction that is going to be refused.
  const titleError = title.trim() === "" ? "Give the agreement a title." : null;
  const shortExpiryWarning =
    expiry < 60
      ? "That is a very short window. If it expires unconfirmed, you can never be paid."
      : null;

  const invalid = titleError !== null || !amountCheck.ok;
  const ready = connected && !invalid;

  const action = useTransactionAction(() => {
    // The agreement exists on chain now. Re-read the page rather than trusting
    // local state: the page is chain-derived (Section 6.2), and this keeps the
    // "no payer yet" fact coming from the chain instead of from a guess.
    router.refresh();
  });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;

    await action.run(async () => {
      const response = await fetch("/api/agreements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipient: address,
          title: title.trim(),
          amount: amount.trim(),
          memo: memo.trim(),
          expiryMinutes: expiry,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as Partial<Created> & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          body.error ?? `The server refused to build the agreement (HTTP ${response.status}).`,
        );
      }
      if (typeof body.transaction !== "string" || typeof body.id !== "string") {
        throw new Error("The server's response was not a transaction. Nothing was signed.");
      }
      setCreated({
        id: body.id,
        recipient: address ?? "",
        transaction: body.transaction,
        message: body.message ?? "",
      });
      return body.transaction;
    });
  }

  // ---- success: the shareable Blink, which is the point of the whole page ----
  if (created !== null) {
    const blink = `${window.location.origin}/api/actions/flint/${created.id}?recipient=${created.recipient}`;
    const page = `${window.location.origin}/agreement/${created.id}?recipient=${created.recipient}`;
    return (
      <section className="flint-section" aria-labelledby="created-heading">
        <h2 id="created-heading" className="text-lg font-semibold">
          The agreement is on chain
        </h2>
        <p className="flint-muted mt-1 text-sm">
          It is <code>pending</code>: the terms are set, the escrow is open and
          empty, and no payer exists yet. Share the Blink — whoever approves it in
          a Solana wallet becomes the payer.
        </p>

        <ActionFeedback
          busy={action.busy}
          message={action.message}
          error={action.error}
          success={
            action.stage === "success"
              ? `Created on ${cluster}.${
                  action.signature === null ? "" : ` Transaction ${action.signature}.`
                } That is the creation signature, not a receipt — a receipt is the release or the refund.`
              : null
          }
          signatureUrl={action.signature === null ? null : explorerTxUrl(action.signature, cluster)}
        />

        <div className="mt-3">
          <label htmlFor="blink-url" className="flint-label">
            Blink — share this
          </label>
          <p className="flint-hint" id="blink-url-hint">
            A Solana Actions URL. It unfurls as a payment card in a compatible
            wallet (Phantom&rsquo;s in-app browser, dial.to) and can be pasted
            straight into a chat.
          </p>
          <CopyableField id="blink-url" value={blink} />
        </div>

        <div className="mt-3">
          <label htmlFor="page-url" className="flint-label">
            Agreement page — for someone who prefers a browser
          </label>
          <CopyableField id="page-url" value={page} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <a
            className="flint-button"
            href={`/agreement/${created.id}?recipient=${created.recipient}`}
          >
            Open the agreement
          </a>
          <button
            type="button"
            className="flint-button"
            onClick={() => {
              setCreated(null);
              action.reset();
              setTitle("");
              setAmount("");
              setMemo("");
            }}
          >
            Create another agreement
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="flint-section" aria-labelledby="terms-heading">
      <h2 id="terms-heading" className="text-lg font-semibold">
        The terms
      </h2>
      <p className="flint-muted mt-1 text-sm">
        These become immutable the moment anyone funds the agreement.
      </p>

      <form onSubmit={submit} className="mt-3 flex flex-col gap-4" noValidate>
        <div className="flint-wallet-row">
          <ConnectButton />
        </div>

        <Field
          id="title"
          label="What is this payment for?"
          hint="Shown to the payer in their wallet before they approve. A specific title prevents a mistaken payment."
        >
          <input
            id="title"
            name="title"
            className="flint-input"
            value={title}
            maxLength={128}
            onChange={(event) => setTitle(event.target.value)}
            aria-describedby="title-hint"
            aria-invalid={titleError !== null}
          />
          {titleError === null ? null : <p className="flint-error-text">{titleError}</p>}
        </Field>

        <Field
          id="amount"
          label={`Amount (${assetSymbol})`}
          hint={
            decimals === null
              ? `The asset's decimal scale could not be read, so this is in base units. Mint ${assetMint}.`
              : `In ${assetSymbol}. Up to ${decimals} decimal places. Fixed forever once funded.`
          }
        >
          <input
            id="amount"
            name="amount"
            className="flint-input flint-num"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-describedby="amount-hint"
            aria-invalid={!amountCheck.ok}
          />
          <p className={amountCheck.ok ? "flint-hint" : "flint-error-text"}>
            {amountCheck.ok ? (
              <>
                Exactly{" "}
                <span className="flint-num">{amountCheck.baseUnits}</span> base units
                will be escrowed.
              </>
            ) : amount.trim() === "" ? (
              "Enter an amount."
            ) : (
              amountCheck.error
            )}
          </p>
        </Field>

        <Field
          id="expiry"
          label="Expires after"
          hint="After this, you can never be paid, and the payer can take the money back. The chain clock decides when, not this device."
        >
          <select
            id="expiry"
            name="expiry"
            value={expiry}
            onChange={(event) => setExpiry(Number(event.target.value))}
            aria-describedby="expiry-hint"
          >
            {expiryPresets.map((preset) => (
              <option key={preset.minutes} value={preset.minutes}>
                {preset.label}
              </option>
            ))}
          </select>
          {shortExpiryWarning === null ? null : (
            <p className="flint-error-text">{shortExpiryWarning}</p>
          )}
        </Field>

        <Field
          id="memo"
          label="Note to the payer (optional)"
          hint="Included in the Blink. It cannot change what the payer is agreeing to — only the amount, asset, expiry and condition bind them."
        >
          <textarea
            id="memo"
            name="memo"
            className="flint-input"
            rows={3}
            maxLength={512}
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
            aria-describedby="memo-hint"
          />
        </Field>

        <div className="flint-note">
          <p>
            <strong>Condition: </strong>
            <code>manual-confirmation</code> — {conditionDescription}. The payer
            releases the funds by signing; nothing is checked automatically.
          </p>
          <p className="mt-1">
            <strong>Asset: </strong>
            <code>{assetMint}</code> ({assetSymbol})
          </p>
        </div>

        <ActionFeedback busy={action.busy} message={action.message} error={action.error} success={null} />

        <div>
          <button type="submit" className="flint-button" disabled={!ready || action.busy}>
            {action.busy ? "Working…" : "Create the agreement"}
          </button>
          {!connected ? (
            <p className="flint-hint mt-1">Connect a wallet above to create the agreement.</p>
          ) : invalid ? (
            <p className="flint-hint mt-1">Fill in the terms above to continue.</p>
          ) : null}
        </div>
      </form>
    </section>
  );
}

/** A read-only input holding a URL, with a copy button that says when it worked. */
function CopyableField({ id, value }: { id: string; value: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  return (
    <div className="flint-copy">
      <input
        id={id}
        className="flint-input"
        readOnly
        value={value}
        onFocus={(event) => event.currentTarget.select()}
        aria-describedby={`${id}-hint`}
      />
      <button
        type="button"
        className="flint-button"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(value)
            .then(() => setCopied("done"))
            .catch(() => setCopied("failed"));
        }}
      >
        Copy
      </button>
      <span role="status" className="flint-hint">
        {copied === "done"
          ? "Copied."
          : copied === "failed"
            ? "Could not copy — select the text and copy it manually."
            : ""}
      </span>
    </div>
  );
}
