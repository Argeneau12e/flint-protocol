/**
 * The page a payer opens from a shared link (Section 5a).
 *
 * This screen is written for someone who has never heard of FRS-1 and does not
 * need to: it shows the amount, what the payment is for, the terms in plain
 * language, and one button. Everything protocol-shaped — addresses, PDA and
 * escrow accounts, the condition enum, unix timestamps, the agreement id —
 * lives behind a single closed *Technical details* disclosure, or is not shown
 * at all, because a fact that does not change what the payer does is noise on a
 * payment request.
 *
 * Three behaviours are load-bearing:
 *
 *   1. **Nothing touches the wallet before the dialog is answered.** The
 *      confirm step explains, in the payer's terms, that the money goes into
 *      escrow rather than to the recipient, and that it comes back if delivery
 *      is never confirmed. Only the confirm action builds a transaction.
 *   2. **The progress states are the real ones.** `useTransactionAction` already
 *      publishes `preparing`/`awaiting_signature`/`submitting`/`confirming`
 *      (Phase 5a's wallet work); the wording here is the payer-facing version of
 *      those stages, and each says what is happening *now*.
 *   3. **Success is stated by chain state, not by the click.** The card renders
 *      its paid form from the agreement's status, so a reload or a second visit
 *      shows the same thing — and the receipt is offered from the funding (or
 *      later settlement) transaction, looked up from the account when this
 *      browser never witnessed it.
 */

"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { AssetLabel } from "@/components/asset-label";
import { WalletStatus } from "@/components/agreement-ui";
import {
  downloadReceiptPng,
  type ReceiptData,
} from "@/components/receipt-image";
import { assetDisplay } from "@/lib/display";
import { explorerTxUrl } from "@/lib/links";
import {
  getBrowserConnection,
  useFlintWallet,
  useTransactionAction,
  type ActionStage,
} from "@/lib/wallet";
import { PublicKey } from "@solana/web3.js";
import type { AgreementStatus } from "@/lib/frs1-types";

/**
 * The payer's wording for the signing stages the shared hook publishes.
 *
 * Deliberately not the create form's strings: a payer is watching money leave
 * their wallet, so "Processing payment…" is the honest headline and the detail
 * line carries the part that matters (nothing has moved yet / waiting for the
 * chain).
 */
const STAGE_TEXT: Partial<
  Record<ActionStage, { title: string; detail: string }>
> = {
  preparing: {
    title: "Processing payment…",
    detail: "Preparing the escrow transaction.",
  },
  awaiting_signature: {
    title: "Confirm in your wallet…",
    detail: "Nothing has moved yet — approve the request to pay.",
  },
  submitting: {
    title: "Processing payment…",
    detail: "Sending your payment to Solana.",
  },
  confirming: {
    title: "Confirming on-chain…",
    detail: "Waiting for Solana devnet to confirm it.",
  },
};

/** Where this tab remembers the signature it just produced, if it produced one. */
const SIGNATURE_KEY = "flint:funding-tx:";

export interface PaymentRequestProps {
  /** The agreement id, as it appears in the link. Used for requests, never shown. */
  id: string;
  /** The recipient's address — a PDA seed and the API's other parameter. Never shown. */
  recipient: string;
  /** The agreement PDA. Read from chain for the receipt's transaction; never shown. */
  pda: string;
  title: string;
  memo: string;
  amountDisplay: string;
  symbol: string;
  status: AgreementStatus;
  expired: boolean;
  /** The deadline, spelled out in UTC: `2 October 2026, 14:30 UTC`. */
  expiresAtHuman: string;
  /** When the page was rendered, UTC — the receipt's date line. */
  nowHuman: string;
  cluster: string;
  /** Server-rendered technical details, shown only inside the disclosure. */
  technical: ReactNode;
}

export function PaymentRequest(props: PaymentRequestProps) {
  const router = useRouter();
  const { address, connected } = useFlintWallet();

  /**
   * The signature this browser knows about.
   *
   * Two sources, in order: what this tab recorded when it paid (a reload after
   * paying must not lose the receipt), and — failing that — the most recent
   * transaction on the agreement account, read from chain. The second is what
   * makes the receipt real on a device that never saw this agreement before: for
   * a funded agreement the newest transaction *is* the funding, and once
   * released or refunded it is the settlement, which is the receipt proper.
   */
  const [chainSignature, setChainSignature] = useState<string | null>(null);
  const paid = props.status !== "pending";

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(
        `${SIGNATURE_KEY}${props.id}`
      );
      if (stored !== null && stored !== "") setChainSignature(stored);
    } catch {
      // Storage can be unavailable in a locked-down browser; the lookup below
      // still runs, so the receipt keeps its transaction either way.
    }
  }, [props.id]);

  useEffect(() => {
    if (!paid) return;
    let cancelled = false;
    void (async () => {
      try {
        const [recent] = await getBrowserConnection().getSignaturesForAddress(
          new PublicKey(props.pda),
          { limit: 1 }
        );
        if (!cancelled && recent !== undefined)
          setChainSignature(recent.signature);
      } catch {
        // A failed lookup costs the signature line on the receipt, nothing else.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paid, props.pda, props.status]);

  const action = useTransactionAction((signature) => {
    try {
      window.sessionStorage.setItem(`${SIGNATURE_KEY}${props.id}`, signature);
    } catch {
      // Not being able to remember it is no reason not to show it.
    }
    setChainSignature(signature);
    // The status on screen is re-read from chain after a settlement, never
    // remembered by this component (Section 6.2).
    router.refresh();
  });

  /** Asks the Blink endpoint to build the funding transaction, then signs it. */
  async function pay() {
    await action.run(async () => {
      const response = await fetch(
        `/api/actions/flint/${props.id}?recipient=${props.recipient}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ signer: address }),
        }
      );
      const body = (await response.json().catch(() => ({}))) as {
        transaction?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          body.error ??
            `The payment could not be prepared (HTTP ${response.status}).`
        );
      }
      if (typeof body.transaction !== "string") {
        throw new Error(
          "The payment could not be prepared. Nothing was signed."
        );
      }
      return body.transaction;
    });
  }

  const signature = chainSignature ?? action.signature;
  const settledNow = action.signature !== null;
  const paidView = paid || settledNow;
  const stage = action.busy
    ? STAGE_TEXT[action.stage] ?? {
        title: "Processing payment…",
        detail: "Preparing the escrow transaction.",
      }
    : null;
  const title =
    props.title.trim() === "" ? "Payment agreement" : props.title.trim();

  /** Everything the receipt image needs, resolved at click time. */
  function receiptData(): ReceiptData {
    const origin = window.location.origin;
    return {
      title,
      amount: props.amountDisplay,
      symbol: assetDisplay(props.symbol).label,
      status: receiptStatusLine(props.status, settledNow),
      paidAt: props.nowHuman,
      signature,
      pageUrl: `${origin}/agreement/${props.id}?recipient=${props.recipient}`,
      verifyUrl:
        signature === null
          ? `${origin}/verify`
          : `${origin}/verify/${signature}`,
      cluster: props.cluster,
    };
  }

  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  async function download() {
    setReceiptBusy(true);
    setReceiptError(null);
    try {
      await downloadReceiptPng(receiptData());
    } catch (cause) {
      setReceiptError(
        cause instanceof Error
          ? cause.message
          : "The receipt image could not be produced."
      );
    } finally {
      setReceiptBusy(false);
    }
  }

  return (
    <section className="flint-stack" aria-labelledby="request-heading">
      {paidView ? (
        <PaidCard
          status={props.status}
          settledNow={settledNow}
          expired={props.expired}
          title={title}
          amountDisplay={props.amountDisplay}
          symbol={props.symbol}
          expiresAtHuman={props.expiresAtHuman}
          signature={signature}
          cluster={props.cluster}
          receiptBusy={receiptBusy}
          receiptError={receiptError}
          onDownload={() => void download()}
        />
      ) : (
        <RequestCard
          title={title}
          memo={props.memo}
          amountDisplay={props.amountDisplay}
          symbol={props.symbol}
          expiresAtHuman={props.expiresAtHuman}
          connected={connected}
          busy={action.busy}
          onPay={() => void pay()}
        />
      )}

      {stage === null ? null : (
        <StageProgress title={stage.title} detail={stage.detail} />
      )}

      {action.error === null ? null : (
        <p role="alert" className="flint-error-text">
          {action.error}
        </p>
      )}

      {/*
        One closed disclosure, and the only place on this page a technical fact
        appears. Closed by default is the point: it is here for the payer who
        wants to check something, not for the one who just wants to pay.
      */}
      <Accordion type="single" collapsible>
        <AccordionItem value="technical">
          <AccordionTrigger>Technical details</AccordionTrigger>
          <AccordionContent>{props.technical}</AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  );
}

/**
 * The request itself: amount, what it is for, the terms in plain language, and
 * exactly one action.
 *
 * There is no second button and no field: a payer's only decision is whether to
 * pay, and the dialog behind the button is where the consequences are spelled
 * out. The terms are sentences rather than a label/value table on purpose — a
 * "Condition: manual-confirmation" row is a fact about the protocol, and this
 * reader does not need one.
 */
function RequestCard({
  title,
  memo,
  amountDisplay,
  symbol,
  expiresAtHuman,
  connected,
  busy,
  onPay,
}: {
  title: string;
  memo: string;
  amountDisplay: string;
  symbol: string;
  expiresAtHuman: string;
  connected: boolean;
  busy: boolean;
  onPay: () => void;
}) {
  return (
    <div className="flint-card flint-measure">
      <p className="flint-eyebrow">Payment request</p>
      <h1 id="request-heading" className="flint-page-title">
        {title}
      </h1>
      <p className="flint-amount">
        {amountDisplay}{" "}
        <span>
          <AssetLabel symbol={symbol} />
        </span>
      </p>
      {memo.trim() === "" ? null : <p className="flint-lede">{memo.trim()}</p>}

      <ul
        className="flint-list flint-muted"
        style={{ marginTop: "var(--flint-space-5)" }}
      >
        <li>
          Valid until {expiresAtHuman} — after that, this link can no longer be
          paid.
        </li>
        <li>
          If you pay, the recipient confirms delivery and the money is released
          to them.
        </li>
        <li>
          If that has not happened by the deadline, the money comes back to you
          — nobody can hold it past then.
        </li>
      </ul>

      <div
        className="flint-stack"
        style={{ marginTop: "var(--flint-space-6)" }}
      >
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="lg" disabled={busy} className="w-fit">
              Make payment
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <ShieldCheckIcon />
              </AlertDialogMedia>
              <AlertDialogTitle>Your money goes into escrow</AlertDialogTitle>
              <AlertDialogDescription>
                Paying puts{" "}
                <strong>
                  {amountDisplay} <AssetLabel symbol={symbol} />
                </strong>{" "}
                into an escrow account that neither side can move on its own. It
                is not sent to the recipient yet: they receive it when they
                confirm delivery. If that has not happened by {expiresAtHuman},
                the money comes back to you.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onPay}>
                Fund the escrow
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <WalletStatus action="you, the payer" />
        {connected ? null : (
          <p className="flint-hint">
            The payment is signed by the wallet connected in the bar above.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The paid states: what happened, what it means, and the receipt.
 *
 * Rendered from the agreement's *status*, not from a click, so a reload, a
 * second visit from another device, or the moment right after signing all show
 * the same card. The alert is the one place colour carries good news, and it
 * always ships with its icon and its sentence (Section 5: never colour alone).
 */
function PaidCard({
  status,
  settledNow,
  expired,
  title,
  amountDisplay,
  symbol,
  expiresAtHuman,
  signature,
  cluster,
  receiptBusy,
  receiptError,
  onDownload,
}: {
  status: AgreementStatus;
  settledNow: boolean;
  expired: boolean;
  title: string;
  amountDisplay: string;
  symbol: string;
  expiresAtHuman: string;
  signature: string | null;
  cluster: string;
  receiptBusy: boolean;
  receiptError: string | null;
  onDownload: () => void;
}) {
  const refunded = status === "refunded";
  const released = status === "released";
  // The payout sentences name the asset; the label is what the figure means.
  const asset = assetDisplay(symbol);

  return (
    <div className="flint-card flint-measure">
      <p className="flint-eyebrow">Payment</p>
      <h1 id="request-heading" className="flint-page-title">
        {title}
      </h1>

      <Alert
        variant={refunded ? "default" : "success"}
        style={{ marginTop: "var(--flint-space-5)" }}
      >
        {refunded ? <RotateCcwIcon /> : <CheckIcon />}
        <AlertTitle>
          {released
            ? "Settled"
            : refunded
            ? "Returned to you"
            : settledNow
            ? "Payment sent"
            : "Payment in escrow"}
        </AlertTitle>
        <AlertDescription>
          {released
            ? `The ${amountDisplay} ${asset.label} held for this agreement was released to the recipient.`
            : refunded
            ? `The ${amountDisplay} ${asset.label} escrow came back to you after the deadline.`
            : `Your ${amountDisplay} ${asset.label} is now held in escrow for ${title}.`}
        </AlertDescription>
      </Alert>

      <ul
        className="flint-list flint-muted"
        style={{ marginTop: "var(--flint-space-5)" }}
      >
        {refunded ? (
          <li>Nothing further is required — this agreement is finished.</li>
        ) : released ? (
          <li>
            The escrow is empty and the agreement is closed. This card and the
            transaction link below are the record of it.
          </li>
        ) : (
          <>
            <li>
              Nothing else happens until delivery is confirmed — that is what
              releases the money to the recipient.
            </li>
            {expired ? (
              <li>
                The deadline passed with the money still in escrow, so you can
                take it back: use the refund below.
              </li>
            ) : (
              <li>
                If it is not confirmed by {expiresAtHuman}, you can take the
                money back.
              </li>
            )}
          </>
        )}
      </ul>

      <div className="flint-row" style={{ marginTop: "var(--flint-space-5)" }}>
        <Button variant="outline" onClick={onDownload} disabled={receiptBusy}>
          {receiptBusy ? <Spinner /> : <DownloadIcon />}
          Download the receipt
        </Button>
        {signature === null ? null : (
          <Button variant="ghost" asChild>
            <a
              href={explorerTxUrl(signature, cluster)}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLinkIcon />
              View it on Solana Explorer
            </a>
          </Button>
        )}
      </div>

      <p className="flint-fine">
        Send the receipt to whoever asked for this payment — it is their proof
        that the money is in escrow, and the transaction line on it is checkable
        by anyone.
      </p>
      {receiptError === null ? null : (
        <p role="alert" className="flint-error-text">
          {receiptError}
        </p>
      )}
    </div>
  );
}

/**
 * What is happening right now, in the payer's words.
 *
 * Uses the library's Item + Spinner pattern: an icon that moves, a headline, and
 * a line of detail. `role="status"` makes it a live region, so the stage change
 * is announced rather than only seen.
 */
function StageProgress({ title, detail }: { title: string; detail: string }) {
  return (
    <Item
      variant="outline"
      role="status"
      aria-live="polite"
      className="flint-measure"
    >
      <ItemMedia variant="icon">
        <Spinner />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>{detail}</ItemDescription>
      </ItemContent>
    </Item>
  );
}

/** One sentence for the receipt image: where the money is, in the payer's terms. */
function receiptStatusLine(
  status: AgreementStatus,
  settledNow: boolean
): string {
  if (status === "released")
    return "Released to the recipient — the escrow is settled and empty.";
  if (status === "refunded")
    return "Returned to the payer after the deadline — the escrow is empty.";
  if (status === "funded")
    return "Held in escrow, awaiting the recipient's confirmation of delivery.";
  return settledNow
    ? "Held in escrow for this agreement."
    : "The state of this payment, as recorded on chain.";
}
