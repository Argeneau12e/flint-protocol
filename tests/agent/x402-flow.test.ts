/**
 * The agent / x402 flow, end to end against Solana devnet.
 *
 * Acceptance criteria under test (FLINT_BUILD_CONTEXT.md Section 7.2):
 *   1. a priced endpoint returns HTTP 402 with a valid FRS-1 agreement;
 *   2. the policy engine is deterministic (see policy-engine.test.ts — hermetic,
 *      no chain, no model);
 *   3. on pass, the agent pays and settles through the *same* escrow program, and
 *      a receiptProof is captured;
 *   4. on fail, it does not pay, and the refusal is logged;
 *   5. verification is identical for an agent-settled and a human-settled
 *      agreement.
 *
 * Two deliberate choices about how these tests are built:
 *
 *   - **A real socket.** The responder is exercised over real HTTP against a real
 *     `node:http` server that wraps the actual route handler, so the 402 status,
 *     the `X-PAYMENT` header round trip and the retry are tested as they will be
 *     used, not as a direct function call that skips the wire.
 *   - **Real devnet transactions.** Every assertion about money is an assertion
 *     about token balances read back from chain. Nothing here is mocked, because
 *     "the funds moved" is the claim under test.
 *
 * Cluster: devnet, per Section 6.3. Needs `app/.env.local` (see
 * `scripts/provision-devnet.mjs`).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { GET as x402Responder } from "../../app/app/api/x402/route";
import { readConfig } from "../../app/lib/config";
import { getConnection } from "../../app/lib/solana";
import { loadKeypair, type LoadedKeypair } from "../../app/lib/keys";
import { runAgent } from "../../app/lib/agent";
import {
  agreementPda,
  escrowAta,
  fundAgreement,
  proposeAgreement,
  readAgreement,
  releaseToRecipient,
} from "../../app/lib/flint-program";
import {
  formatUuid,
  newUuidBytes,
  toFrs1Agreement,
  type DecodableAgreement,
} from "../../app/lib/frs1-chain";
import { verifyFunding, verifySettlement, type VerificationCheck } from "../../app/lib/verify";
import { readDecisions } from "../../app/lib/decision-log";
import { chainNowSeconds } from "../../app/lib/chain-clock";
import { policyForScenario } from "../../app/lib/demo-policy";
import type { Frs1Agreement } from "../../app/lib/frs1-types";

/** Wraps the real route handler in a real HTTP server. */
async function startResponder(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const port = (server.address() as AddressInfo).port;
        const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
          method: req.method ?? "GET",
          headers: req.headers as Record<string, string>,
          ...(body.length > 0 ? { body } : {}),
        });
        const response = await x402Responder(request);
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        res.writeHead(response.status, headers);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/x402`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const config = readConfig();
const connection = getConnection();
const service: LoadedKeypair = loadKeypair(config.serviceKeypairPath, "service");
const agent: LoadedKeypair = loadKeypair(config.agentKeypairPath, "agent");
const mint = config.assetMint;
const price = config.priceBaseUnits;

let responder: { url: string; close: () => Promise<void> };

/** The agent's balance in the asset, straight from chain. */
async function agentBalance(): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, agent.keypair.publicKey, true);
  return (await getAccount(connection, ata)).amount;
}

/** The recipient's balance in the asset, straight from chain. */
async function serviceBalance(): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, service.keypair.publicKey, true);
  return (await getAccount(connection, ata)).amount;
}

/** The escrow balance for an agreement PDA, straight from chain. */
async function escrowBalance(pda: PublicKey): Promise<bigint> {
  return (await getAccount(connection, escrowAta(mint, pda))).amount;
}

/** Names the checks that failed, so a failure report says which invariant broke. */
function describeFailures(
  verification: { ok: boolean; checks: VerificationCheck[] } | null,
): string {
  if (verification === null) return "no verification was run";
  return verification.checks
    .filter((check) => !check.passed)
    .map((check) => `${check.name} (${check.detail})`)
    .join("; ");
}

before(async () => {
  responder = await startResponder();
  const sol = await connection.getBalance(agent.keypair.publicKey);
  const tokens = await agentBalance();
  assert.isTrue(sol > 0, `The agent wallet needs SOL for fees; it has ${sol} lamports.`);
  assert.isTrue(
    tokens >= BigInt(price),
    `The agent wallet needs at least ${price} base units of the asset; it has ${tokens}. ` +
      `Re-run: node scripts/provision-devnet.mjs`,
  );
});

after(async () => {
  await responder.close();
});

describe("agent / x402 flow on devnet (Section 7.2)", () => {
  it("test_402_returns_a_valid_frs1_agreement — the priced endpoint proposes on chain (7.2.1)", async () => {
    const response = await fetch(responder.url);
    assert.equal(response.status, 402, "an unpaid request must be answered with 402");

    const body = (await response.json()) as {
      x402Version: number;
      error: string;
      accepts: Array<{
        scheme: string;
        network: string;
        maxAmountRequired: string;
        asset: { address: string; decimals?: number };
        payTo: string;
        maxTimeoutSeconds: number;
        extra: { protocol: string; agreementPda: string; agreement: Frs1Agreement };
      }>;
    };

    // The x402 envelope an agent negotiates against.
    assert.equal(body.x402Version, 1);
    assert.equal(body.error, "payment_required");
    assert.equal(body.accepts.length, 1);
    const requirement = body.accepts[0];
    assert.equal(requirement.scheme, "flint-escrow-v1");
    assert.equal(requirement.network, "solana-devnet");
    assert.equal(requirement.maxAmountRequired, price);
    assert.equal(requirement.asset.address, mint.toBase58());
    assert.equal(requirement.payTo, service.address, "the recipient is the service wallet");

    // The FRS-1 object, field for field (Section 4.1).
    const agreement = requirement.extra.agreement;
    assert.equal(requirement.extra.protocol, "FRS-1");
    assert.equal(agreement.status, "pending", "a proposal is pending");
    assert.isNull(agreement.payerAddress, "there is no payer before funding (Section 4.2)");
    assert.equal(agreement.recipientAddress, service.address);
    assert.equal(agreement.amount, price);
    assert.equal(agreement.asset, mint.toBase58());
    assert.equal(agreement.condition.type, "manual-confirmation");
    assert.isFalse(agreement.disputedFlag);
    assert.isNull(agreement.disputedAt);
    assert.isUndefined(agreement.receiptProof, "no receipt before settlement (Section 4.7)");
    assert.match(
      agreement.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      "the id is a v4 uuid, as the schema says",
    );

    // The published id must map back to the stored bytes, or nobody could find
    // this agreement again: re-derive the PDA from the object alone (4.5).
    const derived = agreementPda(
      new PublicKey(agreement.recipientAddress),
      Buffer.from(agreement.id.replace(/-/g, ""), "hex"),
      config.programId,
    )[0].toBase58();
    assert.equal(
      derived,
      requirement.extra.agreementPda,
      "the agreement PDA is re-derivable from the published FRS-1 object",
    );

    // It exists on chain, with exactly those terms, and the escrow is its ATA.
    const pda = new PublicKey(requirement.extra.agreementPda);
    const raw = await readAgreement(connection, config.programId, pda);
    assert.isNotNull(raw, "the 402 is not a proposal on paper: the account exists");
    const onChain = toFrs1Agreement(raw as unknown as DecodableAgreement);
    assert.equal(onChain.id, agreement.id);
    assert.equal(onChain.status, "pending");
    assert.equal(onChain.amount, agreement.amount);
    assert.equal(onChain.recipientAddress, agreement.recipientAddress);
    assert.equal(
      onChain.escrowAddress,
      escrowAta(mint, pda).toBase58(),
      "escrowAddress is the agreement PDA's ATA for the asset (Section 4.5)",
    );
    assert.equal(agreement.escrowAddress, onChain.escrowAddress);

    // The expiry is in the future according to the chain's own clock.
    const now = await chainNowSeconds(connection);
    assert.isAbove(
      agreement.expiresAt,
      now,
      "a proposal that cannot be paid in time is refused at creation (Section 4.6)",
    );
    assert.isAtMost(
      requirement.maxTimeoutSeconds,
      config.agreementTtlSeconds,
      "the advertised timeout matches the configured TTL",
    );

    // Nothing was paid: an unpaid 402 must not have moved a token.
    assert.equal((await escrowBalance(pda)).toString(), "0");
  });

  it("test_agent_pays_and_settles_within_policy — money moves, receipt captured (7.2.3)", async () => {
    const agentBefore = await agentBalance();
    const serviceBefore = await serviceBalance();

    const result = await runAgent({
      connection,
      programId: config.programId,
      agent: agent.keypair,
      policy: policyForScenario("pay", service.address, mint.toBase58(), price),
      resourceUrl: responder.url,
      settle: true,
      spentSoFar: "0",
      decisionLogPath: config.decisionLogPath,
    });

    // The agent got its resource.
    assert.equal(result.outcome, "paid", result.notes.join("\n"));
    assert.equal(result.httpStatus, 200);
    assert.isNotNull(result.resource, "the endpoint served the protected payload");

    // A payment and a settlement happened, and the receipt is the settlement.
    assert.isNotNull(result.fundingTx, "the agent funded the escrow");
    assert.isNotNull(result.settlementTx, "the agent settled the agreement");
    assert.equal(result.receiptProof, result.settlementTx);
    // The harness verified its own claims from chain; the failed checks are
    // reported by name, so a failure here says which invariant broke.
    assert.isTrue(
      result.verification.payment?.ok,
      `payment verification failed: ${describeFailures(result.verification.payment)}`,
    );
    assert.isTrue(
      result.verification.settlement?.ok,
      `settlement verification failed: ${describeFailures(result.verification.settlement)}`,
    );

    // The money actually moved, measured on chain rather than asserted.
    const pda = new PublicKey(result.agreementPda as string);
    assert.equal((await escrowBalance(pda)).toString(), "0", "escrow is empty after settlement");
    assert.equal(
      (await agentBalance()).toString(),
      (agentBefore - BigInt(price)).toString(),
      "the agent paid exactly the agreed amount",
    );
    assert.equal(
      (await serviceBalance()).toString(),
      (serviceBefore + BigInt(price)).toString(),
      "the recipient was paid exactly the agreed amount",
    );

    // The agreement settled through the same program and the same state machine.
    const settled = toFrs1Agreement(
      (await readAgreement(connection, config.programId, pda)) as unknown as DecodableAgreement,
    );
    assert.equal(settled.status, "released");
    assert.equal(settled.payerAddress, agent.address, "the funder is the stored payer");
    assert.equal(settled.amount, price);

    // The receipt is independently verifiable by anyone, with no trust in the
    // agent: the same verifier the page uses recomputes it from the signature.
    const report = await verifySettlement(
      connection,
      config.programId,
      result.settlementTx as string,
    );
    assert.isTrue(
      report.ok,
      report.checks.filter((c) => !c.passed).map((c) => c.detail).join("; "),
    );
    assert.equal(report.settlementKind, "release");
    assert.equal(report.receiptProof, result.settlementTx);

    // The decision was recorded, and so was what it produced: the log's last entry
    // for this agreement carries the settlement signature, which is the receipt.
    const entries = readDecisions(config.decisionLogPath, 10).filter(
      (candidate) => candidate.agreementPda === result.agreementPda,
    );
    const decisionEntry = entries.find((candidate) => candidate.code === "ok");
    assert.isNotNull(decisionEntry, "the decision itself is on the record");
    assert.equal(decisionEntry?.outcome, "allowed");
    const settledEntry = entries.find((candidate) => candidate.settlementTx !== undefined);
    assert.isNotNull(settledEntry, "the outcome is on the record too");
    assert.equal(settledEntry?.settlementTx, result.settlementTx);
    assert.isAbove(decisionEntry?.checks.length ?? 0, 0, "the log keeps the full evaluation");
  });

  it("test_agent_refuses_when_over_spend_cap — no payment, refusal logged (7.2.4)", async () => {
    const agentBefore = await agentBalance();
    const serviceBefore = await serviceBalance();

    const result = await runAgent({
      connection,
      programId: config.programId,
      agent: agent.keypair,
      policy: policyForScenario("refuse_spend_cap", service.address, mint.toBase58(), price),
      resourceUrl: responder.url,
      settle: true,
      spentSoFar: "0",
      decisionLogPath: config.decisionLogPath,
    });

    assert.equal(result.outcome, "refused", result.notes.join("\n"));
    assert.equal(result.refusal?.code, "spend_cap_exceeded");
    assert.include(result.refusal?.reason ?? "", price);

    // Nothing was signed, nothing was sent.
    assert.isNull(result.fundingTx, "a refused payment sends no transaction");
    assert.isNull(result.settlementTx);
    assert.isNull(result.receiptProof);
    assert.isNull(result.verification.payment, "there is no payment to verify");
    assert.isNull(result.resource, "the protected payload was not served");

    // The agreement the server proposed is untouched and still empty.
    const pda = new PublicKey(result.agreementPda as string);
    const raw = await readAgreement(connection, config.programId, pda);
    assert.equal(
      toFrs1Agreement(raw as unknown as DecodableAgreement).status,
      "pending",
      "the agreement is still pending: the agent never funded it",
    );
    assert.equal((await escrowBalance(pda)).toString(), "0");
    assert.equal((await agentBalance()).toString(), agentBefore.toString(), "the agent spent nothing");
    assert.equal((await serviceBalance()).toString(), serviceBefore.toString(), "the recipient got nothing");

    // The refusal is on the record, with a reason a human can read.
    const logged = readDecisions(config.decisionLogPath, 5).slice(-1)[0];
    assert.equal(logged.outcome, "refused");
    assert.equal(logged.code, "spend_cap_exceeded");
    assert.isNull(logged.payer, "no payer was recorded, because no payer acted");
    assert.isUndefined(logged.fundingTx);
    assert.isNotEmpty(logged.reason);
  });

  it("test_agent_refuses_when_recipient_not_allowlisted — no payment, refusal logged (7.2.4)", async () => {
    const agentBefore = await agentBalance();

    const result = await runAgent({
      connection,
      programId: config.programId,
      agent: agent.keypair,
      policy: policyForScenario("refuse_recipient", service.address, mint.toBase58(), price),
      resourceUrl: responder.url,
      settle: true,
      spentSoFar: "0",
      decisionLogPath: config.decisionLogPath,
    });

    assert.equal(result.outcome, "refused", result.notes.join("\n"));
    assert.equal(result.refusal?.code, "recipient_not_allowlisted");
    assert.include(result.refusal?.reason ?? "", service.address);
    assert.isNull(result.fundingTx);
    assert.equal((await agentBalance()).toString(), agentBefore.toString(), "the agent spent nothing");

    const pda = new PublicKey(result.agreementPda as string);
    assert.equal((await escrowBalance(pda)).toString(), "0");
    assert.equal(
      readDecisions(config.decisionLogPath, 5).slice(-1)[0].code,
      "recipient_not_allowlisted",
    );
  });

  it("test_verification_is_identical_for_agent_and_human_settlements (7.2.5)", async () => {
    // (a) An agent-settled agreement: the harness, the policy engine, the wire.
    const agentRun = await runAgent({
      connection,
      programId: config.programId,
      agent: agent.keypair,
      policy: policyForScenario("pay", service.address, mint.toBase58(), price),
      resourceUrl: responder.url,
      settle: true,
      spentSoFar: "0",
      decisionLogPath: config.decisionLogPath,
    });
    assert.equal(agentRun.outcome, "paid", agentRun.notes.join("\n"));

    // (b) A human-settled agreement: same program, same instructions, a different
    //     payer wallet that pays for itself, exactly as a person's wallet will in
    //     Phase 3. No x402, no policy engine, no agent anywhere in this block.
    const humanPayer = Keypair.generate();
    const solTransfer = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: service.keypair.publicKey,
        toPubkey: humanPayer.publicKey,
        lamports: Math.floor(0.1 * LAMPORTS_PER_SOL),
      }),
    );
    await connection.sendTransaction(solTransfer, [service.keypair]);
    const humanAta = await getOrCreateAssociatedTokenAccount(
      connection,
      service.keypair,
      mint,
      humanPayer.publicKey,
    );
    await mintTo(
      connection,
      service.keypair,
      mint,
      humanAta.address,
      service.keypair,
      10n * BigInt(price),
    );

    const now = await chainNowSeconds(connection);
    const proposed = await proposeAgreement(connection, config.programId, service.keypair, {
      id: newUuidBytes(),
      amount: price,
      asset: mint,
      expiresAt: now + config.agreementTtlSeconds,
      title: "Freelance sprint (human flow)",
      memo: "paid by a person, not an agent",
    });
    const humanEscrow = escrowAta(mint, proposed.agreement);
    const humanFunding = await fundAgreement(
      connection,
      config.programId,
      humanPayer,
      proposed.agreement,
      humanAta.address,
      humanEscrow,
    );
    const humanSettlement = await releaseToRecipient(
      connection,
      config.programId,
      humanPayer,
      proposed.agreement,
      humanEscrow,
      getAssociatedTokenAddressSync(mint, service.keypair.publicKey, true),
    );

    // (c) The same verifier, called the same way, for both settlements.
    const agentReport = await verifySettlement(
      connection,
      config.programId,
      agentRun.settlementTx as string,
    );
    const humanReport = await verifySettlement(connection, config.programId, humanSettlement);

    for (const [label, report] of [
      ["agent", agentReport],
      ["human", humanReport],
    ] as const) {
      assert.isTrue(
        report.ok,
        `${label} settlement failed verification: ${report.checks
          .filter((c) => !c.passed)
          .map((c) => c.detail)
          .join("; ")}`,
      );
      assert.equal(report.settlementKind, "release");
      assert.equal(report.facts.agreement?.status, "released");
      assert.equal(report.facts.escrowBalance, "0");
    }

    // Identical check sets, in the same order: no flow-specific check exists.
    assert.deepEqual(
      agentReport.checks.map((check) => check.name),
      humanReport.checks.map((check) => check.name),
      "the verifier runs the same checks for both flows",
    );
    // Identical FRS-1 object shape, from the same reader, for both flows. Optional
    // fields may legitimately be present on one and absent on the other (this test's
    // human-flow proposal advertises no `agentPolicy`), so those are compared
    // separately rather than being allowed to hide a difference in the required set.
    const OPTIONAL = ["handle", "agentPolicy", "receiptProof"];
    const required = (report: typeof agentReport): string[] =>
      Object.keys(report.facts.agreement ?? {})
        .filter((field) => !OPTIONAL.includes(field))
        .sort();
    assert.deepEqual(
      required(agentReport),
      required(humanReport),
      "both agreements carry the same required FRS-1 fields, read by the same code",
    );
    // And the optional term fields, where both flows set them, must agree. The
    // receipt is deliberately excluded: it identifies one specific transaction, so
    // two different settlements must carry two different receipts.
    for (const field of ["handle", "agentPolicy"] as const) {
      const inAgent = (agentReport.facts.agreement ?? {})[field];
      const inHuman = (humanReport.facts.agreement ?? {})[field];
      if (inAgent !== undefined && inHuman !== undefined) {
        assert.deepEqual(inAgent, inHuman, `${field} must agree when both flows set it`);
      }
    }
    // Each flow's own object carries its own receipt, and it is that flow's signature.
    assert.equal(
      agentReport.facts.agreement?.receiptProof,
      agentRun.settlementTx,
      "the agent-settled object carries the agent's own settlement as its receipt",
    );
    assert.equal(
      humanReport.facts.agreement?.receiptProof,
      humanSettlement,
      "the human-settled object carries the human's own settlement as its receipt",
    );
    // The facts that must agree, do.
    assert.equal(agentReport.facts.agreement?.amount, humanReport.facts.agreement?.amount);
    assert.equal(agentReport.facts.agreement?.asset, humanReport.facts.agreement?.asset);
    assert.equal(
      agentReport.facts.agreement?.recipientAddress,
      humanReport.facts.agreement?.recipientAddress,
    );

    // The only intended difference: who paid, and which transactions did it.
    assert.equal(agentReport.facts.agreement?.payerAddress, agent.address);
    assert.equal(humanReport.facts.agreement?.payerAddress, humanPayer.publicKey.toBase58());
    assert.notEqual(agentRun.settlementTx, humanSettlement);

    // The human flow's *payment* verifies through the same payment path too.
    const humanPayment = await verifyFunding(
      connection,
      config.programId,
      humanFunding,
      proposed.agreement.toBase58(),
    );
    assert.isTrue(humanPayment.ok, "the human flow's funding verifies identically");
  });

  it("test_receipt_cannot_be_forged — only a real settlement of this agreement is a receipt (row 7)", async () => {
    // A signature that does not exist at all.
    const invented = "4".repeat(64);
    const inventedReport = await verifySettlement(connection, config.programId, invented);
    assert.isFalse(inventedReport.ok, "an invented signature is not a receipt");
    assert.isNull(inventedReport.receiptProof);
    assert.isFalse(inventedReport.checks[0].passed);

    // A real transaction that is not a Flint settlement: a plain SOL transfer.
    const foreign = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: service.keypair.publicKey,
        toPubkey: agent.keypair.publicKey,
        lamports: 100_000,
      }),
    );
    const foreignSignature = await connection.sendTransaction(foreign, [service.keypair]);
    const foreignReport = await verifySettlement(connection, config.programId, foreignSignature);
    assert.isFalse(
      foreignReport.ok,
      "a real transaction that is not a settlement is not a receipt",
    );
    assert.equal(foreignReport.settlementKind, null);
    assert.isNull(foreignReport.receiptProof);

    // And a real *payment* is still not a *receipt*: the same signature the
    // responder accepts as proof of payment must be refused as a settlement.
    const run = await runAgent({
      connection,
      programId: config.programId,
      agent: agent.keypair,
      policy: policyForScenario("pay", service.address, mint.toBase58(), price),
      resourceUrl: responder.url,
      settle: false, // pay, but do not settle
      spentSoFar: "0",
      decisionLogPath: config.decisionLogPath,
    });
    assert.equal(run.outcome, "paid", run.notes.join("\n"));
    assert.isNotNull(run.fundingTx);

    const fundingAsPayment = await verifyFunding(
      connection,
      config.programId,
      run.fundingTx as string,
      run.agreementPda as string,
    );
    assert.isTrue(fundingAsPayment.ok, "the funding transaction is a valid payment");

    const fundingAsReceipt = await verifySettlement(
      connection,
      config.programId,
      run.fundingTx as string,
    );
    assert.isFalse(
      fundingAsReceipt.ok,
      "a payment is not a receipt: nothing was settled",
    );
    assert.isNull(fundingAsReceipt.receiptProof);
  });
});
