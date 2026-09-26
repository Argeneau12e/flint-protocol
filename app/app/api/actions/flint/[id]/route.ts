/**
 * The Blink: a Solana Actions endpoint for funding one agreement (Phase 3).
 *
 * Acceptance 7.1.2 — "opening the Blink in a Solana wallet lets the client fund
 * it". The hard part of that criterion is that the Blink has to work in *someone
 * else's* client (Phantom's in-app browser, dial.to), not just in a page of ours,
 * so this route speaks the Actions protocol rather than our own internal shape.
 *
 * Two endpoints, one resource, per the spec:
 *
 *   - `GET`  — the action's *description*: what is being paid, to whom, by when,
 *     and what happens if it is not confirmed. Rendered by the client as a card
 *     before anything is signed. It carries the `X-Action-Version` /
 *     `X-Action-Blockchain` headers a client checks before unfurling at all.
 *   - `POST` — the *transaction*, unsigned, base64. The client signs it with the
 *     payer's key and submits. The server holds no key and cannot fund anything
 *     by itself.
 *
 * The two facts worth stating about the `fund` transaction this builds:
 *
 *   1. **The amount is never a parameter.** The program reads it off the
 *      agreement, so the transaction carries no amount at all. A Blink that took
 *      an amount in the request would be a client-chosen amount, which is
 *      exactly what a fixed-amount agreement (Section 4.2) exists to prevent.
 *   2. **The funder's token account is created idempotently if missing.** A Blink
 *      that only worked for a wallet which already held the asset would be a Blink
 *      that fails for most people the first time they try it.
 *
 * GET reports the agreement's *live* state, read from chain. An already-funded
 * or already-released agreement therefore unfurls as an honest "already paid"
 * card rather than a button that a payer could sign and have rejected.
 */

import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../../../../lib/solana";
import { readConfig, ConfigError } from "../../../../../lib/config";
import {
  buildFundTransaction,
  serializeForClient,
} from "../../../../../lib/flint-program";
import {
  AgreementNotFoundError,
  BadAgreementRefError,
  deployment,
  loadAgreementView,
  type AgreementView,
} from "../../../../../lib/agreement-view";
import { actionsError, actionsHeaders, actionsPreflight, BLINK_ICON } from "../../../../../lib/actions";
import { amountLabel } from "../../../../../lib/display";
import { agreementUrl, requestOrigin } from "../../../../../lib/links";

export const dynamic = "force-dynamic";

/**
 * `OPTIONS` — the CORS preflight a browser sends before it will read or POST a
 * Blink from another origin (Phantom's in-app browser, dial.to, a widget). Without
 * it the card silently fails to unfurl in exactly the clients this has to work in.
 */
export async function OPTIONS(): Promise<Response> {
  return actionsPreflight();
}

/** Plain Web `Request`/`Response`, so the tests drive this handler directly. */
function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // An Actions response describes live chain state; a cached card would show
      // a payer terms that have since expired or been paid.
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/** Turns a load failure into the reason a client should show, not a stack trace. */
function loadError(error: unknown): Response {
  if (error instanceof BadAgreementRefError) {
    return actionsError(error.detail, 400);
  }
  if (error instanceof AgreementNotFoundError) {
    return actionsError(
      "This agreement does not exist on Solana. It was most likely cancelled by its recipient, " +
        "which closes the account (the money was never held by a cancelled agreement).",
      404,
    );
  }
  throw error;
}

/** Why the card cannot be paid right now, or `null` when it can. */
function unpayableReason(view: AgreementView): string | null {
  const { agreement, expired, secondsUntilExpiry } = view;
  switch (agreement.status) {
    case "pending":
      return expired
        ? "This agreement has expired. An expired agreement cannot be funded — the recipient would have to propose a new one with a later expiry."
        : null;
    case "funded":
      return "This agreement has already been funded. The funds are in escrow until the payer releases them, or until the expiry, when they can be refunded.";
    case "released":
      return "This agreement has already been released to the recipient. Nothing is left to pay.";
    case "refunded":
      return "This agreement expired unconfirmed and was refunded to the payer. It is finished.";
    case "cancelled":
      return "This agreement was cancelled by its recipient and can never be paid.";
    default:
      return `This agreement is in an unexpected state and cannot be paid. (${secondsUntilExpiry}s to expiry)`;
  }
}

/** A short, human expiry phrase. Chain clock, so never a host-clock guess. */
function expiryPhrase(view: AgreementView): string {
  if (view.agreement.status !== "pending") return "";
  const seconds = view.secondsUntilExpiry;
  if (seconds <= 0) return "It has already expired.";
  if (seconds < 90) return `It expires in about ${seconds} seconds.`;
  if (seconds < 5400) return `It expires in about ${Math.round(seconds / 60)} minutes.`;
  if (seconds < 172800) return `It expires in about ${Math.round(seconds / 3600)} hours.`;
  return `It expires in about ${Math.round(seconds / 86400)} days.`;
}

/**
 * `GET` — describe the action so a Blink client can unfurl it.
 *
 * The response shape is the Actions spec's, deliberately: `type`/`icon`/`title`/
 * `description` plus a `links.actions` array whose `href` points back at this same
 * URL, which the client POSTs to when the person taps. A Blink that only had a
 * `transaction` field would render in some clients and silently do nothing in
 * others; `links.actions` is the portable part of the spec.
 *
 * The `parameters` array is intentionally **empty**. An FRS-1 agreement is a
 * fixed amount for a fixed asset (Section 4.2), so there is nothing for a payer
 * to fill in — and a rendered input would invite exactly the negotiation the
 * protocol has already ruled out.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  let view: AgreementView;
  let origin: string;
  try {
    const { programId, assetMint, symbol } = deployment();
    const { id } = await context.params;
    const recipient = new URL(request.url).searchParams.get("recipient");
    view = await loadAgreementView(getConnection(), programId, id, recipient, assetMint, symbol);
    // The client-facing origin (proxy/tunnel aware) — a card advertising
    // `localhost` would be unPOSTable from any other machine (see `requestOrigin`).
    origin = requestOrigin(request);
  } catch (error) {
    if (error instanceof BadAgreementRefError || error instanceof AgreementNotFoundError) {
      return loadError(error);
    }
    if (error instanceof ConfigError) {
      return actionsError(`Flint is not configured: ${error.problems.join("; ")}`, 503);
    }
    throw error;
  }

  const { agreement } = view;
  const amount = amountLabel(view.amountDisplay, 0, view.symbol);
  const reason = unpayableReason(view);
  const title = agreement.title === "" ? "Flint payment agreement" : agreement.title;

  const description = [
    `${amount} (${agreement.amount} base units) to ${agreement.recipientAddress}, held in escrow.`,
    expiryPhrase(view),
    "Paying means your wallet becomes the payer, permanently: you can release the money to the recipient at any point before it expires, and if you do nothing the recipient never gets it. If it expires unconfirmed, the money can be refunded to you by anyone.",
    reason ?? "",
    agreement.memo === "" ? "" : `Note from the recipient: ${agreement.memo}`,
  ]
    .filter((line) => line !== "")
    .join("\n\n");

  return json(
    {
      type: "action",
      icon: BLINK_ICON,
      title,
      description,
      label: reason === null ? `Pay ${amount}` : "Already paid or unavailable",
      // The agreement's own page: a Blink client shows a link, and someone who
      // would rather read the terms in a browser needs somewhere to go.
      links: {
        actions: [
          {
            label: reason === null ? `Pay ${amount}` : "Unavailable",
            href: `${origin}/api/actions/flint/${view.id}?recipient=${view.recipient}`,
            parameters: [],
          },
        ],
        apps: [
          { label: "Open in browser", uri: agreementUrl(origin, view.id, view.recipient) },
        ],
      },
      // A client rendering only `links.actions` still gets the reason, rather than
      // a button the program would reject.
      ...(reason === null ? {} : { disabled: true, disabledReason: reason }),
    },
    200,
    actionsHeaders(),
  );
}

/** A POST whose signing address could not be determined. */
class SignerError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "SignerError";
  }
}

/**
 * The signing address, from whichever place the client put it.
 *
 * `account` is the Actions spec's own field name — the one a real Blink client
 * sends (`{"account": "<address>", "type": "transaction"}`), verified against
 * `@dialectlabs/blinks`, the reference implementation Dialect co-authored. A
 * route that only understood `signer` would pass every wire-format test here and
 * then 400 the first real client, which is exactly the class of bug this whole
 * exercise exists to catch. `signer` is kept as Flint's own alias (our create page
 * and tests use it), and `X-Signer` as the header fallback.
 *
 * A Blink client may send no body at all (there is nothing to ask the payer — see
 * the empty `parameters` above), so the address's absence is a *normal* case.
 * Only a body that is present and unparseable, or an address that is not a Solana
 * address, is an error. The `type` field a spec client also sends is ignored:
 * Flint builds one kind of transaction here regardless of it.
 */
function readSigner(where: unknown, headerValue: string | null): string {
  const fromBody =
    typeof where === "object" && where !== null
      ? "account" in where
        ? (where as { account?: unknown }).account
        : (where as { signer?: unknown }).signer
      : undefined;
  const candidate = typeof fromBody === "string" ? fromBody : (headerValue ?? "");
  if (candidate === "") {
    throw new SignerError(
      "Flint needs the address that will sign, as {\"account\": \"<address>\"} (the Actions spec's field) or {\"signer\": \"<address>\"} in the POST body — or an X-Signer header — so the token account it creates belongs to your wallet.",
    );
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(candidate)) {
    throw new SignerError(`"${candidate}" is not a valid Solana address.`);
  }
  return candidate;
}

/**
 * `POST` — return the unsigned `fund` transaction for the payer's wallet.
 *
 * The `signer` is the address that will sign, which is needed because it is both
 * the fee payer and the owner of the token account the transaction creates. It is
 * *not* trusted: the program checks the funder against the agreement, and this
 * route only uses the address to derive accounts the signing wallet must own. A
 * caller who names someone else's address gets back a transaction that wallet's
 * signature would be required for, which they cannot submit themselves.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  let view: AgreementView;
  let signer: PublicKey;
  let programId: PublicKey;
  try {
    const dep = deployment();
    const { id } = await context.params;
    const recipient = new URL(request.url).searchParams.get("recipient");
    view = await loadAgreementView(
      getConnection(),
      dep.programId,
      id,
      recipient,
      dep.assetMint,
      dep.symbol,
    );
    const raw = await readBody(request);
    signer = new PublicKey(readSigner(raw, request.headers.get("x-signer")));
    programId = dep.programId;
  } catch (error) {
    if (error instanceof BadAgreementRefError || error instanceof AgreementNotFoundError) {
      return loadError(error);
    }
    if (error instanceof ConfigError) {
      return actionsError(`Flint is not configured: ${error.problems.join("; ")}`, 503);
    }
    if (error instanceof SignerError) {
      return actionsError(error.detail, 400);
    }
    throw error;
  }

  // Refuse before building, with the reason the person would otherwise have to
  // learn by reading a failed simulation.
  const reason = unpayableReason(view);
  if (reason !== null) {
    return actionsError(reason, 409);
  }

  try {
    const transaction = await buildFundTransaction(getConnection(), programId, signer, {
      agreement: new PublicKey(view.pda),
      asset: new PublicKey(view.agreement.asset),
    });
    return json(
      {
        transaction: serializeForClient(transaction),
        message:
          "Approve this in your wallet to fund the agreement. The amount is fixed by the agreement and cannot be changed.",
      },
      200,
      actionsHeaders(),
    );
  } catch (cause) {
    return actionsError(
      `Could not build the funding transaction: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      500,
    );
  }
}

/** The POST body, tolerating the (normal) empty one. */
async function readBody(request: Request): Promise<unknown> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return {};
  }
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SignerError(
      "The request body was not valid JSON. Flint's Blink takes no payment parameters; send {\"signer\": \"<your address>\"} or nothing at all.",
    );
  }
}
