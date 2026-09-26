/**
 * Build the release or refund transaction for an existing agreement (Phase 3).
 *
 * Two instructions behind one endpoint, and deliberately: from the caller's point
 * of view they are the same gesture — "settle this agreement" — but the authority
 * behind them is completely different, and the whole point of the page is that
 * this difference is visible.
 *
 *   - `release` — only the stored `payerAddress` may sign (Section 4.2, threat
 *     row 1). Checked here, as well as by the program. The double check is not
 *     redundancy for its own sake: the program check produces a failed
 *     simulation, and a person who clicked "release" deserves to be told *why*
 *     they cannot, in a sentence, before their wallet is opened.
 *   - `refund` — permissionless. Anyone may crank it once the agreement is
 *     expired, and the money always goes to the stored payer regardless of who
 *     asked (rows 1 and 2, together). So this route does **not** require the
 *     signer to be anybody in particular — it only requires that the agreement
 *     is actually in a state where refund is legal, which it re-reads from chain
 *     rather than trusting the request.
 *
 * The `signer` is the address that will sign, needed because the cranker is the
 * fee payer. It is not trusted for authority: the program checks the release
 * authority against stored state, and this route uses the address only to derive
 * accounts and to set the fee payer.
 */

import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../../../../lib/solana";
import { readConfig, ConfigError } from "../../../../../lib/config";
import {
  MissingDestinationAtaError,
  buildRefundTransaction,
  buildReleaseTransaction,
  serializeForClient,
} from "../../../../../lib/flint-program";
import {
  AgreementNotFoundError,
  BadAgreementRefError,
  deployment,
  loadAgreementView,
  type AgreementView,
} from "../../../../../lib/agreement-view";

export const dynamic = "force-dynamic";

/** Which settlement path is being asked for. */
export type Settlement = "release" | "refund";

function fail(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The state check, stated as a sentence.
 *
 * Returns `null` when the requested settlement is legal right now. Kept as its
 * own function because both branches need it and because the wording is the
 * product here: these messages are what a payer or a helpful stranger reads
 * instead of a failed simulation.
 */
function blockedReason(
  view: AgreementView,
  settlement: Settlement,
  signer: PublicKey,
): string | null {
  const { agreement, expired } = view;
  if (agreement.status !== "funded") {
    return `This agreement is ${agreement.status}, not funded, so there is nothing to settle.`;
  }
  if (settlement === "release") {
    if (expired) {
      return "This agreement has expired, so it can no longer be released. The funds can be refunded to the payer instead — that is now the only path left.";
    }
    if (agreement.payerAddress === null) {
      return "This agreement records no payer, which should be impossible while it is funded.";
    }
    if (signer.toBase58() !== agreement.payerAddress) {
      return `Only the payer can release these funds. The payer is ${agreement.payerAddress}; the connected wallet is ${signer.toBase58()}.`;
    }
    return null;
  }
  // refund
  if (!expired) {
    return `This agreement has not expired yet, so it cannot be refunded. The payer can still release it before ${new Date(agreement.expiresAt * 1000).toISOString()}.`;
  }
  return null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  let view: AgreementView;
  let settlement: Settlement;
  let signer: PublicKey;
  let programId: PublicKey;
  try {
    const dep = deployment();
    readConfig(); // surfaces a configuration problem as ConfigError, below.
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

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const asked = body.settlement;
    if (asked !== "release" && asked !== "refund") {
      return fail('Say which settlement you want: "release" or "refund".');
    }
    settlement = asked;

    const signerRaw = body.signer;
    if (typeof signerRaw !== "string" || signerRaw === "") {
      return fail("The connected wallet's address is required — it signs the transaction.");
    }
    signer = new PublicKey(signerRaw);
    programId = dep.programId;
  } catch (error) {
    if (error instanceof AgreementNotFoundError) {
      return fail(error.message, 404);
    }
    if (error instanceof BadAgreementRefError) {
      return fail(error.message, 400);
    }
    if (error instanceof ConfigError) {
      return fail(`Flint is not configured: ${error.problems.join("; ")}`, 503);
    }
    throw error;
  }

  const reason = blockedReason(view, settlement, signer);
  if (reason !== null) {
    // 409: the request was well-formed, it conflicts with the chain's state.
    return fail(reason, 409);
  }

  const connection = getConnection();
  const agreement = new PublicKey(view.pda);
  const asset = new PublicKey(view.agreement.asset);

  try {
    const transaction =
      settlement === "release"
        ? await buildReleaseTransaction(connection, programId, signer, {
            agreement,
            asset,
            recipient: new PublicKey(view.recipient),
          })
        : await buildRefundTransaction(connection, programId, signer, {
            agreement,
            asset,
            // From stored state, never from the request: this is what makes a
            // permissionless refund safe to offer to anyone.
            payer: new PublicKey(view.agreement.payerAddress as string),
          });

    return new Response(
      JSON.stringify(
        {
          transaction: serializeForClient(transaction),
          message:
            settlement === "release"
              ? "Approve this in your wallet to release the escrowed funds to the recipient. This is final — released agreements cannot change."
              : "Approve this in your wallet to return the escrowed funds to the payer. You are not the beneficiary: the program always pays the payer, whatever wallet cranks this. You pay a small transaction fee.",
        },
        null,
        2,
      ),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      },
    );
  } catch (cause) {
    if (cause instanceof MissingDestinationAtaError) {
      // A specific, actionable failure: the escrow is fine, but the account the
      // money must land in has to exist first, and it belongs to a third party.
      return fail(
        `${cause.message} Until then the settlement cannot be built, because the program cannot create an account on someone else's behalf.`,
        409,
      );
    }
    return fail(
      `Could not build the ${settlement} transaction: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      500,
    );
  }
}
