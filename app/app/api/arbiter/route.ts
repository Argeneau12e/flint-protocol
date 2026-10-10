/** Resolve a dispute as the Config's arbiter. */
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../../lib/solana";
import { readConfig, ConfigError } from "../../../lib/config";
import {
  AgreementNotFoundError,
  BadAgreementRefError,
  deployment,
  loadAgreementView,
  type AgreementView,
} from "../../../lib/agreement-view";
import { BN } from "@anchor-lang/core";
import {
  readConfig as readChainConfig,
  buildResolveDisputeTransaction,
  serializeForClient,
} from "../../../lib/flint-program";
import { internalFailureMessage, logInternalFailure } from "../../../lib/errors";
import { DisputeOutcome } from "../../../lib/frs1-types";

export const dynamic = "force-dynamic";

interface DisputeRuling {
  id: string;
  recipient: string;
  outcome: DisputeOutcome;
  address?: string;
  dep?: { programId: PublicKey; assetMint: PublicKey; symbol: string };
}

interface Deployment {
  programId: PublicKey;
  assetMint: PublicKey;
  symbol: string;
}

function fail(message: string, status = 400): Response {
  return new Response(
    JSON.stringify({ error: message }, null, 2),
    {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

/**
 * Resolves a dispute as the Config's arbiter.
 *
 * Flow (mirrors `agreements/[id]/settle`):
 *  1. Load the agreement view from chain for the target deployment.
 *  2. Require a live "disputed" agreement that has a frozen `arbiterDeadline`.
 *  3. Require the connected address (when supplied) to be the Config's arbiter —
 *     `resolve_dispute` accepts only that key as signer.
 *  4. Build + serialize the `resolve_dispute` transaction for the caller to sign.
 *
 * `recipient` is the counterparty's wallet address (half of the PDA seed, along
 * with `id`); `dep` is an optional deployment override. On error this route
 * returns a JSON error with an explicit status code — never a 500 for bad input.
 */
export async function POST(request: Request): Promise<Response> {
  let body: DisputeRuling;
  try {
    body = (await request.json()) as DisputeRuling;
  } catch {
    return fail("The request body was not valid JSON.");
  }

  if (body.id === undefined || body.id === "") {
    return fail('Missing required field: "id".');
  }
  if (body.recipient === undefined || body.recipient === "") {
    return fail('Missing required field: "recipient".');
  }
  if (body.outcome === undefined) {
    return fail('Missing required field: "outcome".');
  }

  let connection = getConnection();

  // Resolve the deployment: explicit `dep` from the request, otherwise the
  // deployed Config's app-layer values (same helper the /api/meta and
  // /api/agreements/[id]/settle surfaces share).
  let programId: PublicKey;
  let assetMint: PublicKey;
  let symbol: string;
  let arbiter: PublicKey;
  try {
    const dep = body.dep ?? deployment();
    programId = dep.programId;
    assetMint = dep.assetMint;
    symbol = dep.symbol;

    const onChain = await readChainConfig(connection, programId).catch(() => null);
    if (onChain === null) {
      return fail("Flint is not configured: the on-chain Config account does not exist.", 503);
    }
    arbiter = onChain.arbiter;
  } catch (error) {
    if (error instanceof ConfigError) {
      return fail(`Flint is not configured: ${error.problems.join("; ")}`, 503);
    }
    throw error;
  }

  let view: AgreementView;
  try {
    view = await loadAgreementView(
      connection,
      programId,
      body.id,
      body.recipient,
      assetMint,
      symbol,
    );
  } catch (error) {
    if (error instanceof AgreementNotFoundError) {
      return fail(error.message, 404);
    }
    if (error instanceof BadAgreementRefError) {
      return fail(error.message, 400);
    }
    throw error;
  }

  const agreement = view.agreement;

  // The arbiter only rules on an in-flight dispute (disputed before the frozen
  // arbiter deadline). After the deadline, dispute.ts's SplitButton becomes the
  // only path to a fixed 50/50 settlement.
  if (agreement.status !== "disputed") {
    return fail(
      `Only a disputed agreement may be resolved; this one is ${agreement.status}.`,
    );
  }
  if (agreement.arbiterDeadline === null) {
    return fail("This dispute has no arbiter deadline and cannot be resolved now.");
  }

  // Validate the split recipientBps (1..9999) at the boundary too.
  if (body.outcome.kind === "split") {
    const bps = body.outcome.recipientBps;
    if (
      !Number.isInteger(bps) ||
      bps < 1 ||
      bps > 9999 ||
      typeof body.outcome.recipientBps !== "number"
    ) {
      return fail(
        `For split, recipientBps must be an integer between 1 and 9999 (got ${bps}).`,
      );
    }
  }

  // Only the Config's arbiter may act as the dispute signer.
  if (body.address !== undefined && body.address !== arbiter.toBase58()) {
    return fail("Only the Config's arbiter may resolve this dispute.", 409);
  }

  // `resolve_dispute` carries the full on-chain account set: the agreement PDA,
  // arbiter (from Config), asset (the deposit mint), and the stored payer and
  // recipient. The instruction's `config` and the associated token accounts are
  // derived by the builder when omitted. Only a delivered dispute has a stored
  // payer; `dispute` is the transition that sets it.
  const outcome =
    body.outcome.kind === "release"
      ? { release: {} }
      : body.outcome.kind === "refund"
      ? { refund: {} }
      : { split: { recipientBps: new BN(body.outcome.recipientBps) } };

  if (agreement.payerAddress === null) {
    return fail("This disputed agreement has no stored payer and cannot be resolved.");
  }

  try {
    const transaction = await buildResolveDisputeTransaction(connection, programId, {
      agreement: new PublicKey(view.pda),
      arbiter,
      outcome,
      asset: new PublicKey(agreement.asset),
      payer: new PublicKey(agreement.payerAddress),
      recipient: new PublicKey(agreement.recipientAddress),
    });

    return new Response(
      JSON.stringify(
        {
          transaction: serializeForClient(transaction),
          message:
            "Approve this in your wallet to rule on this dispute. The funds will be released, refunded, or split according to the outcome.",
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
    logInternalFailure("building the resolve_dispute transaction", cause);
    return fail(internalFailureMessage(), 500);
  }
}
