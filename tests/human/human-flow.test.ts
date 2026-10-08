/**
 * The human / escrow flow, end to end against Solana devnet.
 *
 * Acceptance criteria under test (FLINT_BUILD_CONTEXT.md Section 7.1). Criterion 5
 * (the verification page) was delivered in Phase 2 and is exercised here through
 * `verifyFunding`/`verifySettlement` — the *same* code that page calls — so these
 * tests assert the verification path without re-testing the page's rendering:
 *
 *   1. a recipient can create an agreement and get back a shareable Blink, with
 *      `payerAddress` still unset;
 *   2. opening the Blink lets a client fund it — the funder becomes `payerAddress`,
 *      funds move into the escrow ATA, status → `funded`;
 *   3. the payer can sign a release — funds reach the recipient, status → `released`,
 *      and the settlement signature verifies as a receipt;
 *   4. after expiry, *anyone* can trigger the refund — funds return to the payer,
 *      status → `refunded`, and that signature verifies too.
 *
 * Four choices about how this is built, each load-bearing:
 *
 *   - **Over a real socket.** The Blink and the settlement endpoints are wrapped
 *     in a `node:http` server, so the Actions headers, the status codes and the
 *     base64 POST body are exercised as a real Blink client would exercise them,
 *     not as direct function calls that skip the wire. "It works in our own UI" is
 *     explicitly not the bar for criterion 2.
 *   - **Funding goes through the Blink's POST response.** The payer's transaction
 *     is the one the HTTP endpoint returned, deserialised and signed — the same
 *     path a Phantom in-app browser takes. The test never calls
 *     `buildFundTransaction` itself for the funding step.
 *   - **Money is asserted from chain.** Balances are read back with `getAccount`;
 *     nothing is mocked, because "the funds moved" is the claim under test.
 *   - **The browser wallet is simulated by a keypair.** The client half
 *     (`lib/wallet.ts`) is a thin `signTransaction` + `sendRawTransaction`, so
 *     signing with a `Keypair` exercises the same contract. The React components
 *     are deliberately not under test: they are presentation, and what they render
 *     is re-read from chain by the page anyway.
 *
 * Cluster: devnet (Section 6.3). Needs `app/.env.local`; see
 * `scripts/provision-devnet.mjs`.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { GET as blinkGet, POST as blinkPost } from "../../app/app/api/actions/flint/[id]/route";
import { POST as createAgreement } from "../../app/app/api/agreements/route";
import { POST as settleAgreement } from "../../app/app/api/agreements/[id]/settle/route";
import { readConfig } from "../../app/lib/config";
import { getConnection } from "../../app/lib/solana";
import { loadKeypair } from "../../app/lib/keys";
import {
  agreementPda,
  escrowAta,
  fundAgreement,
  proposeAgreement,
  readAgreement,
  releaseToRecipient,
} from "../../app/lib/flint-program";
import { toFrs1Agreement, formatUuid, newUuidBytes, type DecodableAgreement } from "../../app/lib/frs1-chain";
import { verifyFunding, verifySettlement } from "../../app/lib/verify";
import { chainNowSeconds } from "../../app/lib/chain-clock";
import { parseDisplayAmount } from "../../app/lib/display";

/** Wraps the real route handlers in a real HTTP server, as a Blink client would see them. */
async function startServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const port = (server.address() as AddressInfo).port;
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

        let response: Response;
        if (url.pathname.startsWith("/api/actions/flint/")) {
          const id = decodeURIComponent(url.pathname.slice("/api/actions/flint/".length));
          const context = { params: Promise.resolve({ id }) };
          response =
            req.method === "POST"
              ? await blinkPost(
                  new Request(url, {
                    method: "POST",
                    headers: req.headers as Record<string, string>,
                    ...(body.length > 0 ? { body } : {}),
                  }),
                  context,
                )
              : await blinkGet(
                  new Request(url, { method: "GET", headers: req.headers as Record<string, string> }),
                  context,
                );
        } else if (url.pathname === "/api/agreements") {
          response = await createAgreement(
            new Request(url, { method: "POST", headers: req.headers as Record<string, string>, body }),
          );
        } else if (url.pathname.endsWith("/settle")) {
          const parts = url.pathname.split("/");
          const id = decodeURIComponent(parts[parts.length - 2] ?? "");
          response = await settleAgreement(
            new Request(url, { method: "POST", headers: req.headers as Record<string, string>, body }),
            { params: Promise.resolve({ id }) },
          );
        } else {
          response = new Response("not found", { status: 404 });
        }

        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        res.writeHead(response.status, headers);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(error instanceof Error ? (error.stack ?? error.message) : String(error));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Signs a base64 transaction the way the browser wallet does, then confirms it.
 *
 * Deliberately the same sequence as `lib/wallet.ts`: deserialize, sign, send, wait
 * for confirmation. A test that submitted optimistically could pass on a
 * transaction that never landed.
 */
async function signAndSubmit(
  connection: ReturnType<typeof getConnection>,
  base64: string,
  signer: Keypair,
): Promise<string> {
  const transaction = Transaction.from(Buffer.from(base64, "base64"));
  transaction.partialSign(signer);
  const raw = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  const signature = await connection.sendRawTransaction(raw);
  const blockhash = transaction.recentBlockhash;
  assert.isString(blockhash, "the endpoint's transaction carried a blockhash");
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    { signature, blockhash: blockhash as string, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed",
  );
  return signature;
}

/** Sleeps — for the one thing that genuinely takes wall-clock time: an expiry. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Flint human flow — Blink funding, release, and permissionless refund (Section 7.1)", () => {
  const connection = getConnection();
  const config = readConfig();
  const mint = config.assetMint;
  const price = config.priceBaseUnits;

  // Roles are the Section 4.5 ones, and deliberately *not* the agent flow's: the
  // recipient is a fresh keypair standing in for the freelancer, so nothing here
  // can pass because the x402 service wallet happened to double as the recipient.
  let recipient: Keypair;
  let payer: Keypair;
  /** A third party, used to prove the refund really is permissionless. */
  let stranger: Keypair;
  let server: { origin: string; close: () => Promise<void> };

  /**
   * Mints whole multiples of the price to a wallet, for a payer to pay with.
   *
   * `mintTo(connection, payer, mint, destination, authority, amount)`: the service
   * wallet is the mint *authority* (provisioning created the mint) and pays the fee,
   * while the wallet being credited is the *destination*. The two are different
   * wallets here, so the order matters — the SPL token program itself rejects a
   * mismatch with "owner does not match".
   */
  async function fundWallet(keypair: Keypair, multiples: number): Promise<void> {
    const authority = loadKeypair(config.serviceKeypairPath, "service");
    const signature = await mintTo(
      connection,
      authority.keypair,
      mint,
      getAssociatedTokenAddressSync(mint, keypair.publicKey, true),
      authority.keypair,
      BigInt(price) * BigInt(multiples),
    );
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  }

  /** The Blink URL, exactly as the create page hands it to a recipient. */
  function blinkFor(id: string, recipientAddress: string): string {
    return `${server.origin}/api/actions/flint/${id}?recipient=${recipientAddress}`;
  }

  /** The settlement endpoint, as the agreement page calls it. */
  function settleUrl(id: string, recipientAddress: string): string {
    return `${server.origin}/api/agreements/${id}/settle?recipient=${recipientAddress}`;
  }

  /** Reads the agreement straight off the chain. */
  async function read(id: string) {
    const [pda] = agreementPda(
      new PublicKey(recipient.publicKey),
      Buffer.from(id.replace(/-/g, ""), "hex"),
      config.programId,
    );
    const raw = await readAgreement(connection, config.programId, pda);
    assert.isNotNull(raw, `the agreement account ${pda.toBase58()} exists`);
    return {
      pda: pda.toBase58(),
      escrow: escrowAta(mint, pda).toBase58(),
      agreement: toFrs1Agreement(raw as unknown as DecodableAgreement),
    };
  }

  /** Waits until the chain clock says the agreement has expired. */
  async function waitForExpiry(expiresAt: number): Promise<void> {
    // Sleeps in short steps and re-reads the Clock sysvar each time (Section 4.5):
    // a host clock would be the wrong thing to trust, and the whole test is about
    // the chain's idea of time.
    for (let waited = 0; waited < 180_000; waited += 3_000) {
      if ((await chainNowSeconds(connection)) >= expiresAt) return;
      await sleep(3_000);
    }
    assert.fail(`the agreement (expiry ${expiresAt}) never expired on the chain clock`);
  }

  /**
   * Moves SOL from the provisioned service wallet into a freshly generated key.
   *
   * Transferred rather than airdropped, and that is a deliberate choice rather
   * than an optimisation: the public devnet faucet rate-lips hard, and a suite
   * that needs three wallets would intermittently die on a 429 that has nothing to
   * do with the code under test. The service wallet is already funded, so this is
   * deterministic and costs no faucet quota.
   */
  async function fundWithSol(from: Keypair, to: Keypair, sol: number): Promise<void> {
    const signature = await connection.sendTransaction(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: from.publicKey,
          toPubkey: to.publicKey,
          lamports: sol * LAMPORTS_PER_SOL,
        }),
      ),
      [from],
    );
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  }

  before(async () => {
    // The two provisioned devnet wallets take the two protocol roles, which is what
    // they are for: the service wallet is the mint authority (provisioning created
    // the mint) and signs `create` as the recipient; the agent wallet is the payer.
    //
    // Reusing them rather than generating three fresh keysets is deliberate, and
    // not only to save the setup cost. A fresh keyset needs SOL, and the devnet
    // faucet is heavily rate-limited — a suite that depends on airdrops fails for
    // reasons that have nothing to do with the code under test. Agreement identity
    // comes from the uuid (a PDA seed alongside the recipient, Section 4.5), so a
    // reused recipient can never collide with a previous run's agreement.
    const service = loadKeypair(config.serviceKeypairPath, "service");
    const agent = loadKeypair(config.agentKeypairPath, "agent");
    recipient = service.keypair;
    payer = agent.keypair;

    // The stranger is the whole point of the refund test (7.1.4), so it has to be a
    // real third party — neither the payer nor the recipient.
    stranger = Keypair.generate();

    // Wallet provisioning, kept deliberately frugal.
    //
    // Every transfer here is spent out of the two provisioned wallets, and the x402
    // suite draws on the same ones — so a generous top-up in this suite is a
    // reliability problem for the *next* one, and the public devnet faucet is
    // rate-limited enough that topping back up from outside is not reliable either.
    // Hence: transfer only what the transaction actually needs, and only when the
    // target is short.
    const agentBalance = await connection.getBalance(payer.publicKey);
    const serviceBalance = await connection.getBalance(recipient.publicKey);
    // The payer only ever pays transaction fees here — it is the *recipient* that
    // pays the rent for each `create` — so its floor is small.
    if (agentBalance < 0.02 * LAMPORTS_PER_SOL && serviceBalance > 0.02 * LAMPORTS_PER_SOL) {
      await fundWithSol(recipient, payer, 0.02);
    }
    assert.isAbove(
      await connection.getBalance(recipient.publicKey),
      0,
      "the recipient still has SOL to pay `create` rent",
    );
    assert.isAbove(
      await connection.getBalance(payer.publicKey),
      0,
      "the payer still has SOL for transaction fees",
    );

    // The stranger only ever pays a single transaction fee — it cranks the refund
    // and receives nothing (Section 4.2) — so this is the minimum that works.
    if ((await connection.getBalance(stranger.publicKey)) < 0.01 * LAMPORTS_PER_SOL) {
      await fundWithSol(payer, stranger, 0.01);
    }

    // The payer needs a token account in the test mint. Note the argument order:
    // (connection, feePayer, mint, owner). The service wallet is the mint authority
    // and pays the account's rent; the *payer* is whose ATA this is. Passing the
    // recipient where the mint belongs fails with TokenOwnerOffCurve, which is the
    // program correctly refusing to treat a wallet as a mint.
    await getOrCreateAssociatedTokenAccount(
      connection,
      recipient,
      mint,
      payer.publicKey,
    );
  });

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    // Defensive: the server is only started once the wallets exist, so if setup
    // failed there is nothing to close. Without this the *real* failure is masked
    // by a "cannot read close of undefined" during teardown.
    if (server !== undefined) await server.close();
  });

  it("test_create_fund_release — 7.1.1 create, 7.1.2 fund via the Blink's POST, 7.1.3 release", async () => {
    // ---- 7.1.1: the recipient creates, and gets a shareable Blink ----
    // Through the same HTTP endpoint the create page calls, so the route's
    // validation and its uuid minting are genuinely under test.
    const createResponse = await fetch(`${server.origin}/api/agreements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipient: recipient.publicKey.toBase58(),
        title: "Landing page build",

        amount: "20.0",
        memo: "Signed off on staging. Release when live.",
        expiryMinutes: 60,
      }),
    });
    // The body is read exactly once, into text, and then parsed from that. Reading
    // it for an assertion message and again for the value would consume it twice —
    // and a failure message that throws while being constructed hides the real one.
    const createText = await createResponse.text();
    assert.equal(createResponse.status, 200, createText);
    const created = JSON.parse(createText) as {
      transaction: string;
      id: string;
      recipient: string;
    };
    assert.isString(created.transaction, "the create endpoint returns an unsigned transaction");
    assert.match(
      created.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      "the id is a v4 uuid, so the link round-trips to the stored bytes",
    );
    assert.equal(created.recipient, recipient.publicKey.toBase58());

    const createTx = await signAndSubmit(connection, created.transaction, recipient);
    assert.isString(createTx, "the recipient's create transaction confirmed");

    // 7.1.1's specific claim: a pending agreement has no payer.
    const afterCreate = await read(created.id);
    assert.equal(afterCreate.agreement.status, "pending");
    assert.isNull(
      afterCreate.agreement.payerAddress,
      "a proposed agreement names no payer (Section 4.5): nobody is bound until funding",
    );
    assert.equal(afterCreate.agreement.recipientAddress, recipient.publicKey.toBase58());
    assert.equal(afterCreate.agreement.amount, "2500000", "2.5 became 2500000 base units, exactly");
    assert.equal(afterCreate.agreement.condition.type, "manual-confirmation");

    // The Blink is shareable: GET must carry the headers and the spec's shape, or a
    // real client (Phantom, dial.to) will not unfurl it at all.
    const blinkUrl = blinkFor(created.id, created.recipient);
    const blinkResponse = await fetch(blinkUrl);
    assert.equal(blinkResponse.status, 200);
    assert.equal(blinkResponse.headers.get("x-action-version"), "1", "a client checks our Actions version");
    assert.equal(blinkResponse.headers.get("x-action-blockchain"), "solana");
    const action = (await blinkResponse.json()) as {
      type: string;
      title: string;
      description: string;
      label: string;
      icon: string;
      links: { actions: Array<{ label: string; href: string; parameters: unknown[] }> };
    };
    assert.equal(action.type, "action", "the Actions spec's `type` discriminator");
    assert.isString(action.icon, "an icon is required for a Blink card to render");
    assert.equal(action.title, "Landing page build");
    assert.isString(action.label);
    assert.isAbove(action.links.actions.length, 0, "links.actions is what a Blink client POSTs to");
    assert.deepEqual(
      action.links.actions[0].parameters,
      [],
      "no parameters: an FRS-1 amount is fixed, so there is nothing for a payer to fill in",
    );
    assert.include(action.description, "escrow", "the payer is told where the money goes");

    // ---- 7.1.2: the payer funds it, using the Blink's POST response ----
    // Balances are asserted as *deltas* from a baseline read here, because the
    // payer is a reused devnet wallet that may already hold the asset from an
    // earlier run. Asserting an absolute balance would make the test pass or fail
    // depending on what ran before it.
    const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey, true);
    const payerBefore = (await getAccount(connection, payerAta)).amount;
    await fundWallet(payer, 4);
    assert.equal(
      (await getAccount(connection, payerAta)).amount.toString(),
      (payerBefore + BigInt(price) * 4n).toString(),
      "the payer was funded with the tokens the test will spend",
    );

    const fundRequest = await fetch(action.links.actions[0].href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signer: payer.publicKey.toBase58() }),
    });
    const fundText = await fundRequest.text();
    assert.equal(fundRequest.status, 200, fundText);
    const fund = JSON.parse(fundText) as { transaction: string; message: string };
    assert.isString(fund.transaction, "the POST returns a transaction for the wallet to sign");

    const fundingTx = await signAndSubmit(connection, fund.transaction, payer);
    assert.isString(fundingTx, "the Blink's funding transaction confirmed");

    const afterFund = await read(created.id);
    assert.equal(afterFund.agreement.status, "funded");
    assert.equal(
      afterFund.agreement.payerAddress,
      payer.publicKey.toBase58(),
      "the funder became the payer, permanently (Section 4.2)",
    );

    // The money is in the escrow ATA, not with either party.
    const escrowAccount = await getAccount(connection, new PublicKey(afterFund.escrow));
    assert.equal(escrowAccount.amount.toString(), "2500000", "the escrow holds exactly the agreed amount");
    assert.equal(
      (await getAccount(connection, payerAta)).amount.toString(),
      (payerBefore + BigInt(price) * 4n - 2500000n).toString(),
      "the payer was debited exactly the agreed amount, and no more",
    );

    // A funded agreement is no longer payable: the Blink must say so rather than
    // hand a second payer a button the program would reject.
    const fundedAction = (await (await fetch(blinkUrl)).json()) as {
      disabled?: boolean;
      disabledReason?: string;
    };
    assert.isTrue(fundedAction.disabled, "an already-funded agreement unfurls as unavailable");
    assert.isString(fundedAction.disabledReason);
    const secondFund = await fetch(action.links.actions[0].href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signer: stranger.publicKey.toBase58() }),
    });
    assert.equal(secondFund.status, 409, "refusing to build a second funding transaction");
    assert.include(((await secondFund.json()) as { error: string }).error, "already been funded");

    // ---- 7.1.3: the payer signs the release ----
    // Through the settlement endpoint, which enforces payer-only authority before
    // building anything (threat row 1).
    const strangerRelease = await fetch(settleUrl(created.id, created.recipient), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settlement: "release", signer: stranger.publicKey.toBase58() }),
    });
    assert.equal(strangerRelease.status, 409, "a stranger cannot release (row 1)");
    assert.include(
      ((await strangerRelease.json()) as { error: string }).error,
      "Only the payer can release",
      "and is told who the payer is, rather than just failing",
    );

    // The funds reached the recipient. The baseline is read *before* the release is
    // built, because the recipient is a reused devnet wallet that may already hold
    // the asset from an earlier run — an absolute balance would depend on history.
    const recipientAta = getAssociatedTokenAddressSync(mint, recipient.publicKey, true);
    const recipientBefore = (await getAccount(connection, recipientAta).catch(() => null))?.amount ?? 0n;

    const releaseResponse = await fetch(settleUrl(created.id, created.recipient), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settlement: "release", signer: payer.publicKey.toBase58() }),
    });
    const releaseText = await releaseResponse.text();
    assert.equal(releaseResponse.status, 200, releaseText);
    const releaseTx = await signAndSubmit(
      connection,
      (JSON.parse(releaseText) as { transaction: string }).transaction,
      payer,
    );

    // The funds reached the recipient (delta, for the same reason as the payer).
    assert.equal(
      (await getAccount(connection, recipientAta)).amount.toString(),
      (recipientBefore + 2500000n).toString(),
      "the recipient received exactly the agreed amount",
    );
    assert.equal(
      (await read(created.id)).agreement.status,
      "released",
      "released is terminal (Section 4.2)",
    );

    // ---- the receipt, verified by recomputation (criterion 5, via the shared verifier) ----
    const settlement = await verifySettlement(connection, config.programId, releaseTx);
    assert.isTrue(
      settlement.ok,
      `the release is a valid receipt; failed: ${settlement.checks
        .filter((check) => !check.passed)
        .map((check) => check.name)
        .join(", ")}`,
    );
    assert.equal(settlement.settlementKind, "release");
    assert.equal(settlement.receiptProof, releaseTx);
    assert.equal(settlement.facts.agreement?.id, created.id);
    assert.equal(settlement.facts.agreement?.receiptProof, releaseTx);
    assert.equal(settlement.facts.escrowBalance, "0", "the escrow is empty after settlement");

    const payment = await verifyFunding(connection, config.programId, fundingTx, afterFund.pda);
    assert.isTrue(payment.ok, "the funding transaction verifies as a payment");

    // Terminal: nothing more can be settled (row 4 — no replay).
    const afterTerminal = await fetch(settleUrl(created.id, created.recipient), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settlement: "release", signer: payer.publicKey.toBase58() }),
    });
    assert.equal(afterTerminal.status, 409, "a released agreement has nothing left to settle");
  });

  it("test_expire_then_refund — 7.1.4 an expired, still-funded agreement is refundable by anyone", async () => {
    // Proposed through the program client rather than the create endpoint, because
    // this test needs a short expiry and the endpoint's own granularity is minutes.
    // The program accepts any strictly-future expiry (Section 4.6).
    //
    // 90 seconds, not 2: devnet round trips are seconds, not milliseconds, and
    // `fund` independently rejects an agreement that expired before funding
    // (Section 4.6, and the reason both ends are validated). Too tight a window
    // would fail on latency rather than on anything being tested.
    const now = await chainNowSeconds(connection);
    const id = newUuidBytes();
    const uuid = formatUuid(id);
    const expiresAt = now + 90;

    const proposed = await proposeAgreement(connection, config.programId, recipient, {
      id,
      amount: "20000000",
      asset: mint,
      expiresAt,
      title: "Consulting hours, July",
      memo: "Unclaimed retainer.",
    });
    const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey, true);
    const payerBefore = (await getAccount(connection, payerAta)).amount;
    await fundAgreement(
      connection,
      config.programId,
      payer,
      proposed.agreement,
      payerAta,
      proposed.escrow,
    );

    const funded = await read(uuid);
    assert.equal(funded.agreement.status, "funded");
    assert.equal(
      (await getAccount(connection, payerAta)).amount.toString(),
      (payerBefore - 20000000n).toString(),
      "the payer funded it directly this time, and was debited exactly 20000000",
    );

    await waitForExpiry(expiresAt);
    assert.isAtLeast(await chainNowSeconds(connection), expiresAt, "the chain clock has passed the expiry");

    // After expiry, release is illegal (row 3) and the refund is the only path — not
    // a preference, and the error says so.
    const releaseExpired = await fetch(settleUrl(uuid, recipient.publicKey.toBase58()), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settlement: "release", signer: payer.publicKey.toBase58() }),
    });
    assert.equal(releaseExpired.status, 409, "an expired agreement cannot be released (row 3)");
    assert.include(
      ((await releaseExpired.json()) as { error: string }).error,
      "refunded to the payer",
      "and is told what the remaining path is, rather than only being refused",
    );

    // The refund is offered to a wallet that is neither the payer nor the recipient.
    // That is the point of 7.1.4: the payer must never be stuck waiting on a
    // counterparty, so a stranger has to be able to unstick it.
    const refundResponse = await fetch(settleUrl(uuid, recipient.publicKey.toBase58()), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settlement: "refund", signer: stranger.publicKey.toBase58() }),
    });
    const refundText = await refundResponse.text();
    assert.equal(refundResponse.status, 200, refundText);
    const refundBody = JSON.parse(refundText) as { transaction: string; message: string };
    assert.include(
      refundBody.message,
      "not the beneficiary",
      "the response is explicit that the cranker gains nothing",
    );

    const refundTx = await signAndSubmit(connection, refundBody.transaction, stranger);
    assert.equal(
      (await read(uuid)).agreement.status,
      "refunded",
      "funded → refunded, terminal (Section 4.2)",
    );

    // The money went back to the *payer*, not to the stranger who cranked it.
    assert.equal(
      (await getAccount(connection, payerAta)).amount.toString(),
      payerBefore.toString(),
      "the payer is back to exactly the balance it had before funding, despite a third party cranking the refund",
    );
    const strangerAta = getAssociatedTokenAddressSync(mint, stranger.publicKey, true);
    const strangerAccount = await getAccount(connection, strangerAta).catch(() => null);
    assert.isTrue(
      strangerAccount === null || strangerAccount.amount === BigInt(0),
      "the cranker received nothing beyond the fee it chose to pay",
    );
    assert.equal(
      (await getAccount(connection, proposed.escrow)).amount.toString(),
      "0",
      "the escrow is empty again",
    );

    // The refund is a receipt, verified exactly as the release was.
    const settlement = await verifySettlement(connection, config.programId, refundTx);
    assert.isTrue(
      settlement.ok,
      `the refund is a valid receipt; failed: ${settlement.checks
        .filter((check) => !check.passed)
        .map((check) => check.name)
        .join(", ")}`,
    );
    assert.equal(settlement.settlementKind, "refund");
    assert.equal(settlement.receiptProof, refundTx);
    assert.equal(
      settlement.facts.agreement?.payerAddress,
      payer.publicKey.toBase58(),
      "verification recomputes the counterparty from the account, not from our request",
    );

    // Terminal: the refund cannot be cranked twice (row 4).
    const replay = await fetch(settleUrl(uuid, recipient.publicKey.toBase58()), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settlement: "refund", signer: stranger.publicKey.toBase58() }),
    });
    assert.equal(replay.status, 409, "a refunded agreement cannot be refunded again (row 4)");
  });

  it("test_bad_links_are_explained — a truncated or hand-edited link never renders as a payment", async () => {
    // The recipient is part of the identity (a PDA seed, Section 4.5), so a link
    // missing it addresses nothing. Saying so is the difference between "bad link"
    // and a page that looks like a working payment.
    const noRecipient = await fetch(
      `${server.origin}/api/actions/flint/${formatUuid(Buffer.alloc(16, 1))}`,
    );
    assert.equal(noRecipient.status, 400);
    assert.equal(noRecipient.headers.get("x-action-version"), "1", "errors are still Actions responses");
    assert.include(((await noRecipient.json()) as { error: string }).error, "recipient address");

    const notAUuid = await fetch(
      `${server.origin}/api/actions/flint/not-a-uuid?recipient=${recipient.publicKey.toBase58()}`,
    );
    assert.equal(notAUuid.status, 400);
    assert.include(((await notAUuid.json()) as { error: string }).error, "not a uuid");

    // A well-formed link to an agreement that does not exist: reported as absent
    // (a cancelled agreement closes its account — Section 4.6), not as a payment.
    const missing = await fetch(
      `${server.origin}/api/actions/flint/${formatUuid(Buffer.alloc(16, 7))}?recipient=${recipient.publicKey.toBase58()}`,
    );
    assert.equal(missing.status, 404);
    assert.include(((await missing.json()) as { error: string }).error, "cancelled");
  });
});








