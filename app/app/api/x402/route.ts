/**
 * The x402 responder: a priced endpoint that answers 402 with an FRS-1 agreement.
 *
 * Server half of the agent flow (Sections 6.1, 6.2; acceptance 7.2.1):
 *
 *   - **no `X-PAYMENT` header** — the service *proposes an agreement on chain*:
 *     the recipient wallet signs `create`, exactly as a person would when sharing a
 *     Blink (Section 4.5). The only difference is what triggered it: an HTTP
 *     request instead of a button. The answer is `402` with the x402 envelope and
 *     the FRS-1 object inside it.
 *   - **with `X-PAYMENT`** — the claim is recomputed from the chain
 *     (`verifyFunding`, plus `verifySettlement` when a settlement is named). If it
 *     holds, the protected payload is served and the answer goes in
 *     `X-PAYMENT-RESPONSE`. If it does not, the answer is another `402` carrying
 *     the reason — never a partial delivery.
 *
 * Cost model worth stating: every unauthenticated request proposes a *new*
 * agreement and so spends a little rent from the service wallet. That is the honest
 * reading of "an agreement exists before anyone pays" — a server that minted one
 * per response would be creating on-chain state for every bot that touched the URL.
 *
 * Plain Web `Request`/`Response` on purpose: no framework imports, so the tests
 * exercise this exact handler over a real socket.
 */

import { getMint } from "@solana/spl-token";
import { readConfig, ConfigError } from "../../../lib/config";
import { getConnection, explorerTxUrl } from "../../../lib/solana";
import { loadKeypair } from "../../../lib/keys";
import { proposeAgreement, readAgreement } from "../../../lib/flint-program";
import {
  newUuidBytes,
  toFrs1Agreement,
  type DecodableAgreement,
} from "../../../lib/frs1-chain";
import { chainNowSeconds } from "../../../lib/chain-clock";
import {
  X402_ERROR_PAYMENT_REQUIRED,
  X402_NETWORK,
  X402_SCHEME,
  X402_VERSION,
  X_PAYMENT_HEADER,
  X_PAYMENT_RESPONSE_HEADER,
  buildPaymentRequired,
  decodeXPayment,
} from "../../../lib/x402";
import { verifyFunding, verifySettlement } from "../../../lib/verify";

/** Always fresh: a 402 must be recomputed from the chain, never cached. */
export const dynamic = "force-dynamic";

/** The thing this endpoint sells. */
export const RESOURCE = "flint://demo/market-report";
const RESOURCE_DESCRIPTION =
  "A one-page market report, delivered only against a settled FRS-1 agreement.";

/** The protected payload. Deterministic: the same facts in, the same bytes out. */
function protectedPayload(agreementId: string, payer: string | null) {
  return {
    report: {
      title: "Solana devnet activity, last 24h",
      rows: [
        { metric: "transactions", value: "see devnet explorer" },
        { metric: "avg confirmation", value: "~400 ms" },
      ],
    },
    deliveredUnder: { agreementId, payer },
  };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export async function GET(request: Request): Promise<Response> {
  let config;
  try {
    config = readConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      return json({ error: "not_configured", problems: error.problems }, 503);
    }
    throw error;
  }

  const connection = getConnection();
  const paymentHeader = request.headers.get(X_PAYMENT_HEADER);

  // ---------------------------------------------------------------------------
  // Unpaid: propose an agreement and return 402.
  // ---------------------------------------------------------------------------
  if (paymentHeader === null) {
    const service = loadKeypair(config.serviceKeypairPath, "service");
    const now = await chainNowSeconds(connection);
    // uuid-v4 bytes, so the published id maps back to exactly these bytes and a
    // payer can re-derive the agreement PDA from the object (Section 4.5).
    const id = newUuidBytes();

    const proposed = await proposeAgreement(connection, config.programId, service.keypair, {
      id,
      amount: config.priceBaseUnits,
      asset: config.assetMint,
      expiresAt: now + config.agreementTtlSeconds,
      title: "Market report access",
      memo: `x402 request at ${new Date().toISOString()}`,
      // The agreement advertises the cap the service will accept. The program
      // stores it but never enforces it (Section 4.3): the *payer's* policy engine
      // gates payment, taking the stricter of the two caps.
      agentPolicy: { spendCap: config.priceBaseUnits, allowlist: [] },
    });

    const raw = await readAgreement(connection, config.programId, proposed.agreement);
    if (raw === null) {
      return json({ error: "agreement_not_readable" }, 502);
    }
    const agreement = toFrs1Agreement(raw as unknown as DecodableAgreement);
    let decimals: number | undefined;
    try {
      decimals = (await getMint(connection, config.assetMint)).decimals;
    } catch {
      decimals = undefined;
    }

    return json(
      buildPaymentRequired({
        agreement,
        agreementPda: proposed.agreement.toBase58(),
        resource: RESOURCE,
        description: RESOURCE_DESCRIPTION,
        decimals,
        nowSeconds: now,
      }),
      402,
      {
        "cache-control": "no-store",
        "x-flint-proposal-tx": proposed.signature,
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Paid: recompute the claim, then serve — or explain the refusal.
  // ---------------------------------------------------------------------------
  const decoded = decodeXPayment(paymentHeader);
  if (!decoded.ok) {
    const detail = "error" in decoded ? decoded.error : "unreadable payment header";
    return json(
      { error: "invalid_payment_header", detail, x402Version: X402_VERSION },
      402,
    );
  }

  const payment = await verifyFunding(
    connection,
    config.programId,
    decoded.payload.fundingTx,
    decoded.payload.agreementPda,
  );
  if (!payment.ok) {
    // Row 7: a claim that does not survive recomputation buys nothing.
    return json(
      {
        error: "payment_not_verified",
        scheme: X402_SCHEME,
        network: X402_NETWORK,
        required: X402_ERROR_PAYMENT_REQUIRED,
        checks: payment.checks,
      },
      402,
      { "cache-control": "no-store" },
    );
  }

  const agreement = payment.facts.agreement;
  const settlement = decoded.payload.settlementTx
    ? await verifySettlement(connection, config.programId, decoded.payload.settlementTx)
    : null;

  return json(
    {
      resource: protectedPayload(agreement?.id ?? "", agreement?.payerAddress ?? null),
      receipt: {
        // The receipt is the settlement, when there is one. Until then the payment
        // sits in escrow and the payer still has to release it (Section 4.2).
        status: agreement?.status ?? "unknown",
        fundingTx: decoded.payload.fundingTx,
        fundingTxUrl: explorerTxUrl(decoded.payload.fundingTx),
        settlementTx: settlement?.receiptProof ?? null,
        settlementTxUrl:
          settlement?.receiptProof === null || settlement?.receiptProof === undefined
            ? null
            : explorerTxUrl(settlement.receiptProof),
        agreementPda: payment.facts.agreementPda,
        verifyPath: `/verify/${decoded.payload.settlementTx ?? decoded.payload.fundingTx}`,
      },
      agreement,
      paymentChecks: payment.checks,
      settlementChecks: settlement?.checks ?? null,
    },
    200,
    {
      "cache-control": "no-store",
      [X_PAYMENT_RESPONSE_HEADER]: JSON.stringify({
        success: true,
        transaction: decoded.payload.fundingTx,
        settlement: settlement?.receiptProof ?? null,
        agreementPda: payment.facts.agreementPda,
      }),
    },
  );
}

/** A HEAD request is the cheap way for an agent to ask "is this priced?". */
export async function HEAD(): Promise<Response> {
  return new Response(null, { status: 402, headers: { "cache-control": "no-store" } });
}
