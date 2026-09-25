/**
 * The test agent (Sections 6.2, 7.2.3/7.2.4).
 *
 * The agent is the payer's side of the flow, and it is deliberately dull: fetch,
 * read the 402, ask the deterministic policy engine, and either pay or refuse.
 * There is no model here and no cleverness — the interesting property is that the
 * *same* escrow program and the same verification path serve it and the human
 * Blink, with no special-casing anywhere.
 *
 * What it does, in order:
 *   1. `GET` the priced endpoint.
 *   2. On `402`, read the FRS-1 agreement out of the x402 envelope.
 *   3. Run the policy engine (pure, no chain, no model) with chain time and the
 *      session's running total.
 *   4. Record the decision — allowed *and* refused — in the decision log. This
 *      happens before any money moves, so a refusal is always visible (7.2.4).
 *   5. If allowed: fund the agreement (escrow), optionally settle it with
 *      `release` (the receipt), then retry with the `X-PAYMENT` header.
 *   6. Verify its own claim from the chain, so the harness reports what the
 *      verifier found rather than what it hoped.
 */

import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Frs1Agreement } from "./frs1-types";
import { agreementPda, fundAgreement, releaseToRecipient } from "./flint-program";
import { recordDecision, type DecisionLogEntry } from "./decision-log";
import { evaluateAgreement, type AgentPolicy, type PolicyDecision } from "./policy-engine";
import {
  X_PAYMENT_HEADER,
  encodeXPayment,
  type X402PaymentRequiredBody,
} from "./x402";
import { verifyFunding, verifySettlement, type VerificationCheck } from "./verify";
import { chainNowSeconds } from "./chain-clock";

/** How the run ended. `refused` and `error` both mean no money moved. */
export type AgentOutcome = "paid" | "refused" | "error";

export interface AgentRunOptions {
  connection: Connection;
  programId: PublicKey;
  /** The payer. Signs `fund`, and `release` when settling. */
  agent: Keypair;
  policy: AgentPolicy;
  /** The priced endpoint. */
  resourceUrl: string;
  /** Settle with `release` after funding, producing the receipt. */
  settle: boolean;
  /** What this agent has already spent this session, in base units. */
  spentSoFar: string;
  decisionLogPath: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface AgentRunResult {
  outcome: AgentOutcome;
  /** HTTP status the endpoint returned on the retry (or on the first response). */
  httpStatus: number;
  agreement: Frs1Agreement | null;
  agreementPda: string | null;
  decision: PolicyDecision | null;
  fundingTx: string | null;
  /** The settlement signature: this is the receipt. */
  settlementTx: string | null;
  receiptProof: string | null;
  /** The protected payload the endpoint served once paid. */
  resource: unknown;
  /** Present on refusal: why, in the engine's own words. */
  refusal: { code: string; reason: string } | null;
  /** What the verifier concluded about the agent's own claims. */
  verification: {
    payment: { ok: boolean; checks: VerificationCheck[] } | null;
    settlement: { ok: boolean; checks: VerificationCheck[] } | null;
  };
  /** A human-readable trace, for the harness page and for test failures. */
  notes: string[];
}

/** Reads the FRS-1 agreement out of a 402 body, or `null` if it is not there. */
function readAgreementFrom402(
  body: unknown,
): { agreement: Frs1Agreement; agreementPda: string } | null {
  const requirement = (body as X402PaymentRequiredBody | null)?.accepts?.[0];
  if (requirement === undefined) return null;
  const extra = requirement.extra;
  if (extra === undefined || extra.protocol !== "FRS-1") return null;
  if (typeof extra.agreementPda !== "string") return null;
  return { agreement: extra.agreement, agreementPda: extra.agreementPda };
}

/**
 * Runs the agent against a priced endpoint, exactly once.
 *
 * Never throws for a refusal: a refusal is a result, and the caller is expected to
 * show it. It does throw for genuine faults (an unfunded wallet, an RPC failure),
 * because silently reporting "error" for those would hide a broken harness.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const {
    connection,
    programId,
    agent,
    policy,
    resourceUrl,
    settle,
    spentSoFar,
    decisionLogPath,
    fetchImpl = fetch,
  } = options;

  const notes: string[] = [];
  const result: AgentRunResult = {
    outcome: "error",
    httpStatus: 0,
    agreement: null,
    agreementPda: null,
    decision: null,
    fundingTx: null,
    settlementTx: null,
    receiptProof: null,
    resource: null,
    refusal: null,
    verification: { payment: null, settlement: null },
    notes,
  };

  // 1. Ask for the resource.
  const first = await fetchImpl(resourceUrl, { method: "GET" });
  result.httpStatus = first.status;
  notes.push(`First request to ${resourceUrl} returned HTTP ${first.status}.`);

  if (first.status !== 402) {
    result.refusal = {
      code: "unexpected_status",
      reason: `Expected HTTP 402 from the priced endpoint, got ${first.status}.`,
    };
    return result;
  }

  // 2. Read the agreement out of the 402.
  const parsed = readAgreementFrom402(await first.json());
  if (parsed === null) {
    result.refusal = {
      code: "malformed_402",
      reason: "The 402 body did not carry an FRS-1 agreement object.",
    };
    return result;
  }
  result.agreement = parsed.agreement;
  result.agreementPda = parsed.agreementPda;
  notes.push(
    `The 402 carries FRS-1 agreement ${parsed.agreement.id} for ` +
      `${parsed.agreement.amount} base units to ${parsed.agreement.recipientAddress}.`,
  );

  // 3. Decide — deterministically, from the chain's clock.
  const now = await chainNowSeconds(connection);
  const decision = evaluateAgreement(parsed.agreement, policy, {
    now,
    spentSoFar,
    claimed: {
      amount: parsed.agreement.amount,
      asset: parsed.agreement.asset,
      recipient: parsed.agreement.recipientAddress,
    },
  });
  result.decision = decision;
  notes.push(`Policy decision: ${decision.allow ? "ALLOW" : "REFUSE"} (${decision.code}).`);

  // 4. Log the decision before any money moves, so refusals are never silent.
  //
  // Kept as a value, because step 6b appends a second entry describing what the
  // decision *produced* — the first entry cannot, as written, contain signatures
  // that did not exist yet.
  const entry: DecisionLogEntry = {
    at: new Date().toISOString(),
    agreementId: parsed.agreement.id,
    agreementPda: parsed.agreementPda,
    recipient: parsed.agreement.recipientAddress,
    payer: decision.allow ? agent.publicKey.toBase58() : null,
    amount: parsed.agreement.amount,
    asset: parsed.agreement.asset,
    outcome: decision.allow ? "allowed" : "refused",
    code: decision.code,
    reason: decision.reason,
    checks: decision.checks,
    effectiveSpendCap: decision.effectiveSpendCap,
    resource: resourceUrl,
  };
  recordDecision(decisionLogPath, entry);

  if (!decision.allow) {
    // 5a. Refuse. No transaction is built, signed or sent.
    result.outcome = "refused";
    result.refusal = { code: decision.code, reason: decision.reason };
    notes.push("Refused: nothing was signed, nothing was sent, no money moved.");
    return result;
  }

  // 5b. Pay: fund the agreement, which escrows exactly the agreed amount.
  const agreement = parsed.agreement;
  const derived = agreementPda(
    new PublicKey(agreement.recipientAddress),
    Buffer.from(agreement.id.replace(/-/g, ""), "hex"),
    programId,
  )[0].toBase58();
  if (derived !== parsed.agreementPda) {
    result.refusal = {
      code: "pda_mismatch",
      reason: `The 402 named agreement ${parsed.agreementPda}, but its own terms derive ${derived}.`,
    };
    return result;
  }
  const pda = new PublicKey(parsed.agreementPda);
  const asset = new PublicKey(agreement.asset);

  const source = await getOrCreateAssociatedTokenAccount(
    connection,
    agent,
    asset,
    agent.publicKey,
  );
  const escrow = getAssociatedTokenAddressSync(asset, pda, true);
  const fundingTx = await fundAgreement(
    connection,
    programId,
    agent,
    pda,
    source.address,
    escrow,
  );
  result.fundingTx = fundingTx;
  notes.push(`Funded the escrow: ${fundingTx}`);

  // 5c. Settle, when asked. The payer is the only party who can release, and the
  //     destination is validated on chain against the stored recipient.
  if (settle) {
    const recipient = new PublicKey(agreement.recipientAddress);
    // The recipient's token account may not exist yet. Creating it costs the
    // agent a little rent; the account's authority remains the recipient, so this
    // grants nobody control of their money.
    await getOrCreateAssociatedTokenAccount(connection, agent, asset, recipient);
    const destination = getAssociatedTokenAddressSync(asset, recipient, true);
    const settlementTx = await releaseToRecipient(
      connection,
      programId,
      agent,
      pda,
      escrow,
      destination,
    );
    result.settlementTx = settlementTx;
    result.receiptProof = settlementTx;
    notes.push(`Released to the recipient: ${settlementTx} (this is the receipt).`);
  }

  // 6. Retry with the payment header.
  const retry = await fetchImpl(resourceUrl, {
    method: "GET",
    headers: {
      [X_PAYMENT_HEADER]: encodeXPayment({
        agreementPda: parsed.agreementPda,
        fundingTx,
        ...(result.settlementTx === null ? {} : { settlementTx: result.settlementTx }),
      }),
    },
  });
  result.httpStatus = retry.status;
  notes.push(`Retry with ${X_PAYMENT_HEADER} returned HTTP ${retry.status}.`);

  if (retry.status === 200) {
    const body = (await retry.json()) as { resource?: unknown };
    result.resource = body.resource ?? null;
    result.outcome = "paid";
  } else {
    // The endpoint did not accept the payment. Report that rather than retrying.
    result.refusal = {
      code: "payment_rejected",
      reason: `The endpoint answered HTTP ${retry.status} to a funded agreement.`,
    };
  }

  // 6b. Record what actually happened, as a second entry.
  //
  // The decision above is written *before* any transaction exists, which is what
  // makes a crash mid-payment still leave a record. That means it cannot contain the
  // signatures — they do not exist yet. So the outcome is appended as its own entry
  // rather than by rewriting the first: the log stays append-only, and a reader sees
  // "this was decided, and this is what it produced".
  recordDecision(decisionLogPath, {
    ...entry,
    at: new Date().toISOString(),
    code: result.settlementTx === null ? "funded" : "settled",
    reason:
      result.settlementTx === null
        ? "Funded the escrow. The payment is escrowed; the payer may still release it " +
          "before the expiry, or let it refund."
        : `Released the escrow to the stored recipient. This settlement signature is the ` +
          `receipt: ${result.settlementTx}`,
    outcome: "allowed",
    fundingTx,
    ...(result.settlementTx === null ? {} : { settlementTx: result.settlementTx }),
  });

  // 7. Verify our own claims from the chain, with the same verifier the endpoint
  //    and the verification page use.
  const payment = await verifyFunding(connection, programId, fundingTx, parsed.agreementPda);
  result.verification.payment = { ok: payment.ok, checks: payment.checks };
  notes.push(
    `Payment verification: ${payment.ok ? "confirmed" : "FAILED"} ` +
      `(${payment.checks.filter((check) => !check.passed).length} failed check(s)).`,
  );

  if (result.settlementTx !== null) {
    const settlement = await verifySettlement(connection, programId, result.settlementTx);
    result.verification.settlement = { ok: settlement.ok, checks: settlement.checks };
    notes.push(
      `Settlement verification: ${settlement.ok ? "receipt valid" : "FAILED"} ` +
        `(${settlement.checks.filter((check) => !check.passed).length} failed check(s)).`,
    );
  }

  return result;
}
