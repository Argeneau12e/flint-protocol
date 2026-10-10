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

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AssetLabel } from "@/components/asset-label";
import { ActionFeedback, Field, WalletStatus } from "@/components/agreement-ui";
import {
  assetDisplay,
  formatBaseUnits,
  parseDisplayAmount,
} from "@/lib/display";
import { FeeLine, feeBaseUnitsOrNull } from "@/components/fee-line";
import { MIN_AGREEMENT_WHOLE_TOKENS, wholeTokens } from "@/lib/fees";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * `2 October 2026, 14:30 UTC` — the only date format this form shows.
 *
 * Assembled from UTC parts rather than through `toLocaleString`, which would
 * render differently per device locale; the payer's page formats its deadline
 * the same way, so the two ends of the agreement read identically.
 */
function formatUtcDate(at: Date): string {
  const day = at.getUTCDate();
  const month = MONTHS[at.getUTCMonth()];
  const year = at.getUTCFullYear();
  const hour = String(at.getUTCHours()).padStart(2, "0");
  const minute = String(at.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hour}:${minute} UTC`;
}

export function CreateForm({
  assetMint,
  assetSymbol,
  decimals,
  expiryPresets,
  reviewWindowPresets,
  conditionDescription,
  cluster,
}: {
  assetMint: string;
  assetSymbol: string;
  decimals: number | null;
  expiryPresets: ReadonlyArray<{ minutes: number; label: string }>;
  reviewWindowPresets: ReadonlyArray<{ seconds: number; label: string }>;
  conditionDescription: string;
  cluster: string;
}) {
  const router = useRouter();
  const { address, connected } = useFlintWallet();

  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [expiry, setExpiry] = useState<number>(
    expiryPresets[1]?.minutes ?? 1440
  );

  const [reviewWindowSecs, setReviewWindowSecs] = useState<number>(24 * 60 * 60);

  /**
   * The deadline the current choice implies, once the browser has one.
   *
   * The expiry is fixed when the agreement is *created* — the API adds these
   * minutes to the chain clock right then, not at funding — so "24 hours" is
   * only a duration until someone says when the clock starts. Naming the
   * instant is the difference between a duration and a deadline.
   *
   * Set in an effect, not during render: this page is server-rendered, and a
   * Date computed at render time differs between server and client, which
   * React reports as a hydration mismatch — a console error the browser smoke
   * test rightly fails on. Until the effect runs the line is simply absent.
   */
  const [expiresAtGuess, setExpiresAtGuess] = useState<string | null>(null);
  useEffect(() => {
    setExpiresAtGuess(formatUtcDate(new Date(Date.now() + expiry * 60_000)));
  }, [expiry]);

  // Created state is separate from the action state: a create that succeeded
  // stays on screen, with its links, until the person asks for another one.
  const [created, setCreated] = useState<Created | null>(null);

  // The server's answer, held *out of* state until the transaction behind it is
  // confirmed. Handing `created` to state as soon as the build ended used to
  // replace the form with "The agreement is on chain" and a shareable Blink while
  // the same screen still said "Approve the request in your wallet" — and it kept
  // saying it if the request was declined or never confirmed (Section 9:
  // confirmation, not optimism).
  const builtRef = useRef<Created | null>(null);

  // Validation *visibility*, not validation itself: the rules are always
  // evaluated (the submit button depends on them), but a field only shows its
  // error after the person has been in it (blur) or tried to submit — never on
  // first render, where red text on untouched empty fields reads as a form that
  // is already broken (Phase 5a).
  const [titleTouched, setTitleTouched] = useState(false);
  const [amountTouched, setAmountTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);

  // What the amount fields call this asset. The raw symbol is mapped through
  // `assetDisplay` so no screen ever renders a bare, unexplained code.
  const asset = assetDisplay(assetSymbol);
  const scale = decimals ?? 0;
  const amountCheck = useMemo(
    () => parseDisplayAmount(amount, scale),
    [amount, scale]
  );
  const feeBaseUnitsValue = feeBaseUnitsOrNull(
    amountCheck.ok ? amountCheck.baseUnits : "0",
    decimals ?? 0,
  );

  // Validation mirrors the server's rules rather than trusting the server to be
  // the only line of defence: a person should not be made to approve a wallet
  // prompt for a transaction that is going to be refused.
  const titleError = title.trim() === "" ? "Give the agreement a title." : null;
  const shortExpiryWarning =
    expiry < 60
      ? "That is a very short window. If it expires unconfirmed, you can never be paid."
      : null;

  // The protocol minimum (20 whole tokens, from lib/fees.ts). Checked against
  // the parsed amount only — an unparseable amount already has its own error —
  // and, like every other field error, it is *shown* only after blur or a
  // submit attempt so a half-typed figure never reads as a rejection.
  const belowMinimum =
    amountCheck.ok &&
    decimals !== null &&
    wholeTokens(BigInt(amountCheck.baseUnits), decimals) < MIN_AGREEMENT_WHOLE_TOKENS
      ? `The minimum agreement is ${MIN_AGREEMENT_WHOLE_TOKENS} ${asset.label}.`
      : null;

  const invalid = titleError !== null || !amountCheck.ok || belowMinimum !== null;
  const ready = connected && !invalid;

  // Whether each field's error is allowed on screen right now (see above).
  const showTitleError = (titleTouched || attempted) && titleError !== null;
  const showAmountError =
    (amountTouched || attempted) && (!amountCheck.ok || belowMinimum !== null);

  const action = useTransactionAction(() => {
    // Confirmed. Only now does the page get to say the agreement exists, and
    // only now does it hand out a Blink — from inside the same commit that set
    // `success`, so the two can never disagree (Section 6.2, Section 9).
    if (builtRef.current !== null) {
      setCreated(builtRef.current);
      builtRef.current = null;
    }
    // The agreement exists on chain now. Re-read the page rather than trusting
    // local state: the page is chain-derived (Section 6.2), and this keeps the
    // "no payer yet" fact coming from the chain instead of from a guess.
    router.refresh();
  });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) {
      // A refused submit says so: the errors that blocked it appear next to the
      // fields instead of the button silently doing nothing (Section 9).
      setAttempted(true);
      return;
    }

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
          reviewWindowSecs,
        }),
      });
      const body = (await response
        .json()
        .catch(() => ({}))) as Partial<Created> & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          body.error ??
            `The server refused to build the agreement (HTTP ${response.status}).`
        );
      }
      if (typeof body.transaction !== "string" || typeof body.id !== "string") {
        throw new Error(
          "The server's response was not a transaction. Nothing was signed."
        );
      }
      builtRef.current = {
        id: body.id,
        recipient: address ?? "",
        transaction: body.transaction,
        message: body.message ?? "",
      };
      return body.transaction;
    });
  }

  // ---- success: the shareable Blink, which is the point of the whole page ----
  if (created !== null) {
    const blink = `${window.location.origin}/api/actions/flint/${created.id}?recipient=${created.recipient}`;
    const page = `${window.location.origin}/agreement/${created.id}?recipient=${created.recipient}`;
    return (
      <section
        className="flint-card flint-stack"
        aria-labelledby="created-heading"
      >
        <h2 id="created-heading">The agreement is on chain</h2>
        <p className="flint-muted">
          It is <code>pending</code>: the terms are set, the escrow is open and
          empty, and no payer exists yet. Share the Blink — whoever approves it
          in a Solana wallet becomes the payer.
        </p>

        <ActionFeedback
          busy={action.busy}
          message={action.message}
          error={action.error}
          success={
            action.stage === "success"
              ? `Created on ${cluster}.${
                  action.signature === null
                    ? ""
                    : ` Transaction ${action.signature}.`
                } That is the creation signature, not a receipt — a receipt is the release or the refund.`
              : null
          }
          signatureUrl={
            action.signature === null
              ? null
              : explorerTxUrl(action.signature, cluster)
          }
        />

        <div>
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

        <div>
          <label htmlFor="page-url" className="flint-label">
            Agreement page — for someone who prefers a browser
          </label>
          <CopyableField id="page-url" value={page} />
        </div>

        <div className="flint-row">
          <a
            className="flint-button flint-primary"
            href={`/agreement/${created.id}?recipient=${created.recipient}`}
          >
            Open the agreement
          </a>
          <a
            className="flint-button"
            href={`https://wa.me/?text=${encodeURIComponent(
              `Payment request: ${title.trim()} — ${page}`,
            )}`}
            target="_blank"
            rel="noreferrer"
          >
            Share on WhatsApp
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

  // The live mirror of what the payer will be asked to approve, so the person
  // setting the terms reads the same numbers in the same order the payer will.
  const expiryLabel =
    expiryPresets.find((preset) => preset.minutes === expiry)?.label ??
    `${expiry} minutes`;
  const previewAmount =
    decimals === null
      ? amountCheck.ok
        ? `${amountCheck.baseUnits} base units`
        : "—"
      : amountCheck.ok
      ? `${formatBaseUnits(amountCheck.baseUnits, decimals)} ${asset.label}`
      : "—";

  const reviewWindowLabel =
    reviewWindowSecs === 6 * 60 * 60
      ? "6 hours"
      : reviewWindowSecs === 12 * 60 * 60
      ? "12 hours"
      : reviewWindowSecs === 48 * 60 * 60
      ? "48 hours"
      : "24 hours";

  return (
    <div className="flint-stack">
      <header>
        <p className="flint-eyebrow">Step 1 of 2</p>
        <h1 id="terms-heading" className="flint-page-title">
          Create a payment agreement
        </h1>
        <p className="flint-muted" style={{ fontSize: "var(--flint-text-lg)" }}>
          You are the <strong>recipient</strong>: you set the terms and your
          connected wallet signs them, paying a small amount of rent to open the
          agreement. Whoever funds it first becomes the payer — permanently —
          and from then on the terms never change: the money waits for the payer
          to confirm delivery, or comes back to them after the expiry.
        </p>
      </header>

      <div className="flint-cols-sticky">
        <form onSubmit={submit} className="flint-stack" noValidate>
          <div className="flint-card flint-form">
            {/* Only once there is a wallet to name: when there is not, the hint
                beside the disabled submit button is the one worth reading. */}
            {connected ? (
              <div className="flint-wallet-row">
                <WalletStatus action="you, the recipient" />
              </div>
            ) : null}

            <Field
              id="title"
              label="What is this payment for?"
              hint="Shown to the payer in their wallet before they approve."
            >
              <input
                id="title"
                name="title"
                className="flint-input"
                value={title}
                maxLength={128}
                placeholder="Website redesign, milestone 1"
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => setTitleTouched(true)}
                aria-describedby="title-hint"
                aria-invalid={showTitleError}
              />
              {showTitleError ? (
                <p className="flint-error-text">{titleError}</p>
              ) : null}
            </Field>

            <Field
              id="amount"
              label={`Amount (${asset.label})`}
              hint={
                decimals === null
                  ? `The asset's decimal scale could not be read, so this is in base units. Mint ${assetMint}.`
                  : `In ${asset.label}, up to ${decimals} decimal places. Fixed forever once funded.`
              }
            >
              <input
                id="amount"
                name="amount"
                className="flint-input flint-num"
                inputMode="decimal"
                value={amount}
                placeholder="250"
                onChange={(event) => setAmount(event.target.value)}
                onBlur={() => setAmountTouched(true)}
                aria-describedby="amount-hint"
                aria-invalid={showAmountError}
              />
              {showAmountError ? (
                <p className="flint-error-text">
                  {amount.trim() === ""
                    ? "Enter an amount."
                    : !amountCheck.ok
                    ? amountCheck.error
                    : belowMinimum}
                </p>
              ) : amountCheck.ok ? (
                <p className="flint-hint">
                  {decimals === null ? (
                    <>
                      Exactly{" "}
                      <span className="flint-num">{amountCheck.baseUnits}</span>{" "}
                      base units will be escrowed (the asset&rsquo;s decimal
                      scale could not be read).
                    </>
                  ) : (
                    <>
                      Exactly{" "}
                      <span className="flint-num">
                        {formatBaseUnits(amountCheck.baseUnits, decimals)}
                      </span>{" "}
                      <AssetLabel symbol={assetSymbol} /> will be escrowed.
                    </>
                  )}
                </p>
              ) : null}
            </Field>

            <Field
              id="expiry"
              label="Expires after"
              hint="The clock starts when you create this agreement — not when someone funds it. After the deadline you can never be paid, and the payer can take the money back. The chain clock decides when, not this device."
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
              {expiresAtGuess === null ? null : (
                <p className="flint-hint">
                  Create it now and it expires about{" "}
                  <span className="flint-num">{expiresAtGuess}</span>.
                </p>
              )}
              {shortExpiryWarning === null ? null : (
                <p className="flint-error-text">{shortExpiryWarning}</p>
              )}
            </Field>

            <Field
              id="reviewWindow"
              label="Review window"
              hint="The time the payer has to review and dispute before the funds move."
            >
              <div className="flint-row" style={{ alignItems: "center", gap: 6 }}>
                <div className="flint-segment" role="group" aria-label="Review window">
                  {reviewWindowPresets.map((preset) => (
                    <button
                      key={preset.seconds}
                      type="button"
                      aria-pressed={reviewWindowSecs === preset.seconds}
                      onClick={() => setReviewWindowSecs(preset.seconds)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flint-copy-btn"
                      aria-label="What is the review window?"
                    >
                      ?
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    After delivery, the payer has this long to review and dispute.
                    When the window closes the funds can be released to you
                    without another signature.
                  </TooltipContent>
                </Tooltip>
              </div>
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

          </div>

          <div className="flint-card">
            <div className="flint-prose">
              <p
                className="flint-muted"
                style={{ fontSize: "var(--flint-text-sm)", margin: 0 }}
              >
                <strong style={{ color: "var(--flint-ink)" }}>
                  Condition:{" "}
                </strong>
                <code>manual-confirmation</code> — {conditionDescription} The
                payer releases the funds by signing; nothing is checked
                automatically.
              </p>
            </div>

            <ActionFeedback
              busy={action.busy}
              message={action.message}
              error={action.error}
              success={null}
            />

            {feeBaseUnitsValue === null ? (
              amountCheck.ok ? (
                <p className="flint-hint">
                  The fee line appears once the amount is at least{" "}
                  {MIN_AGREEMENT_WHOLE_TOKENS} {asset.label}.
                </p>
              ) : (
                <FeeLine
                  amountBaseUnits="0"
                  feeBaseUnitsRaw="0"
                  decimals={decimals ?? 0}
                  symbol={asset.label}
                />
              )
            ) : (
              <FeeLine
                amountBaseUnits={amountCheck.ok ? amountCheck.baseUnits : "0"}
                feeBaseUnitsRaw={feeBaseUnitsValue}
                decimals={decimals ?? 0}
                symbol={asset.label}
              />
            )}

            <div>
              <button
                type="submit"
                className="flint-button flint-primary"
                disabled={!ready || action.busy}
              >
                {action.busy ? "Working…" : "Create the agreement"}
              </button>
              {!connected ? (
                <p className="flint-hint">
                  Connect a wallet above to create the agreement.
                </p>
              ) : invalid ? (
                <p className="flint-hint">
                  Fill in the terms above to continue.
                </p>
              ) : null}
            </div>
          </div>
        </form>

        <aside
          className="flint-card flint-preview flint-sticky"
          aria-label="What the payer will see"
        >
          <p className="flint-eyebrow">What the payer sees</p>
          <div className="flint-amount">
            <span>{previewAmount}</span>
          </div>
          <p
            className="flint-muted"
            style={{ fontSize: "var(--flint-text-sm)" }}
          >
            {title.trim() === "" ? "An untitled agreement" : title.trim()}
          </p>
          <dl className="flint-kv-group" style={{ marginTop: "1rem" }}>
            <div className="flint-kv">
              <dt>Review window</dt>
              <dd>{reviewWindowLabel}</dd>
            </div>
            <div className="flint-kv">
              <dt>Expires after</dt>
              <dd>
                {expiryLabel}
                {expiresAtGuess === null ? null : (
                  <span
                    className="flint-muted"
                    style={{ fontSize: "var(--flint-text-sm)" }}
                  >
                    {" "}
                    — about {expiresAtGuess}
                  </span>
                )}
              </dd>
            </div>
            <div className="flint-kv">
              <dt>Asset</dt>
              <dd className="flint-num">
                <AssetLabel symbol={assetSymbol} />
              </dd>
            </div>
            <div className="flint-kv">
              <dt>Released when</dt>
              <dd>The payer confirms delivery</dd>
            </div>
            <div className="flint-kv">
              <dt>Otherwise</dt>
              <dd>Refunded to the payer after the expiry</dd>
            </div>
          </dl>
          <p
            className="flint-muted"
            style={{ fontSize: "var(--flint-text-sm)", marginTop: "1rem" }}
          >
            Nothing here can be edited once someone funds it.
          </p>
        </aside>
      </div>
    </div>
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
