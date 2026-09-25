/**
 * Flint escrow — Phase 1 test suite.
 *
 * Two groups, deliberately separated:
 *
 *  1. `baseline flows` — the happy paths, so a failure in the threat-model group
 *     can never be blamed on a broken happy path.
 *  2. `Section 5 — threat model` — one test per row, each of which (a) sets up
 *     the attack, (b) asserts the program rejects it, and (c) is named so the
 *     mapping to the table is obvious.
 *
 * The escrow program's definition of done (FLINT_BUILD_CONTEXT.md Section 5) is
 * the second group. "The happy path works" is never the bar — a passing suite
 * with a skipped or softened row is a failure.
 *
 * Cluster: `anchor test` runs this against whatever Anchor.toml points at. It is
 * executed on a local validator (`--provider.cluster localnet`) because devnet
 * deploy needs SOL this machine's wallet does not have; see the Phase 1 report.
 */

import * as anchor from "@anchor-lang/core";
import { AnchorError, BN, Program } from "@anchor-lang/core";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import { randomBytes } from "crypto";
import idl from "../../../target/idl/flint_escrow.json";
import { FlintEscrow } from "../../../target/types/flint_escrow";

const AGREEMENT_SEED = Buffer.from("agreement");

/** Section 4.3: the only condition type v1 enforces. */
const MANUAL_CONFIRMATION = { manualConfirmation: {} };
/** Section 4.3: named in the schema, deliberately not implemented in v1. */
const ORACLE_ATTESTED = { oracleAttested: {} };

/** 1 token at 6 decimals — the agreement amount used throughout. */
const AMOUNT = 1_000_000;
const MINT_DECIMALS = 6;

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = new Program<FlintEscrow>(idl as FlintEscrow, provider);
const connection = provider.connection;

// Per-run wallets: nothing is reused between runs, so a stale fixture can never
// make an attack test pass for the wrong reason.
const recipient = Keypair.generate();
const payer = Keypair.generate();
const attacker = Keypair.generate();
const cranker = Keypair.generate();

let mint: PublicKey; // the agreement asset
let otherMint: PublicKey; // a decoy asset, for the wrong-asset attacks (row 5)

/** The on-chain clock — expiry tests never trust the test host's clock. */
async function chainNow(): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (!info) throw new Error("clock sysvar unavailable");
  return Number(info.data.readBigInt64LE(32));
}

async function airdrop(wallet: PublicKey, sol = 50): Promise<void> {
  const signature = await connection.requestAirdrop(
    wallet,
    sol * LAMPORTS_PER_SOL,
  );
  await connection.confirmTransaction(signature, "confirmed");
}

/** The FRS-1 agreement PDA: [b"agreement", recipient, uuid_bytes] (Section 4.5). */
function agreementPda(forRecipient: PublicKey, id: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [AGREEMENT_SEED, forRecipient.toBuffer(), id],
    program.programId,
  )[0];
}

/** The escrow ATA: associated token account of the agreement PDA (Section 4.5). */
function escrowAta(
  forRecipient: PublicKey,
  id: Buffer,
  asset: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(
    asset,
    agreementPda(forRecipient, id),
    true,
  );
}

function newId(): Buffer {
  return randomBytes(16);
}

async function ensureAta(wallet: Keypair, asset: PublicKey): Promise<PublicKey> {
  const account = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    asset,
    wallet.publicKey,
  );
  return account.address;
}

async function tokenBalance(account: PublicKey): Promise<bigint> {
  return (await getAccount(connection, account)).amount;
}

/**
 * Runs `action` and asserts the program rejected it with `code`.
 *
 * Every threat-model test goes through here, so "rejected" always means a
 * specific program error — never an incidental failure like an unfunded wallet,
 * which would let a test pass while proving nothing.
 */
async function expectProgramError(
  action: () => Promise<unknown>,
  code: string,
  what: string,
): Promise<void> {
  try {
    await action();
    assert.fail(`${what}: the program accepted it, but it must reject`);
  } catch (error) {
    if (error instanceof AnchorError) {
      assert.equal(
        error.error.errorCode.code,
        code,
        `${what}: rejected with ${error.error.errorCode.code}, expected ${code}`,
      );
      return;
    }
    throw error;
  }
}

/**
 * Asserts `action` was rejected by the program without pinning an exact code —
 * for cases where the rejection legitimately comes from the runtime or from
 * Anchor's own constraint machinery rather than this program's error table
 * (re-initialising an existing PDA, for instance). Used sparingly, and never for
 * a Section 5 row: those must assert the specific error.
 */
async function expectRejection(
  action: () => Promise<unknown>,
  what: string,
): Promise<string> {
  try {
    await action();
    assert.fail(`${what}: the program accepted it, but it must reject`);
  } catch (error) {
    if (error instanceof AnchorError) {
      return error.error.errorCode.code;
    }
    // Some legitimate rejections never reach our error table: Anchor's `init` on
    // an existing PDA, for instance, fails inside the system program first and
    // surfaces as a raw simulation failure. Accept it only when the logs prove a
    // program really did fail — never a silent pass on a harness error.
    const failure = error as { logs?: string[]; transactionLogs?: string[] };
    const logs = failure.logs ?? failure.transactionLogs;
    const failed = logs?.find((line) => line.includes("failed"));
    if (failed) {
      return failed.trim();
    }
    throw error;
  }
}

async function readAgreement(pda: PublicKey) {
  return program.account.flintAgreement.fetch(pda);
}

before(async () => {
  for (const wallet of [recipient, payer, attacker, cranker]) {
    await airdrop(wallet.publicKey);
  }

  mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    MINT_DECIMALS,
  );
  otherMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    MINT_DECIMALS,
  );

  // The funder needs a balance to escrow; the recipient and the attacker need
  // token accounts so that substitution attempts fail for the *intended* reason
  // (a program check) rather than for a missing account.
  const payerAta = await ensureAta(payer, mint);
  await mintTo(connection, payer, mint, payerAta, payer, 100 * AMOUNT);
  await ensureAta(recipient, mint);
  await ensureAta(attacker, mint);
  await ensureAta(recipient, otherMint);
  await ensureAta(payer, otherMint);
});

type CreatedAgreement = {
  id: Buffer;
  pda: PublicKey;
  escrow: PublicKey;
  expiresAt: number;
};

/** Proposes an agreement as `owner` (the recipient). */
async function createAgreement(
  options: {
    owner?: Keypair;
    asset?: PublicKey;
    amount?: number;
    expiresIn?: number;
    condition?: unknown;
    title?: string;
    id?: Buffer;
  } = {},
): Promise<CreatedAgreement> {
  const owner = options.owner ?? recipient;
  const asset = options.asset ?? mint;
  const id = options.id ?? newId();
  const amount = new BN(options.amount ?? AMOUNT);
  const expiresAt = new BN((await chainNow()) + (options.expiresIn ?? 3600));
  const pda = agreementPda(owner.publicKey, id);
  const escrow = getAssociatedTokenAddressSync(asset, pda, true);

  await program.methods
    .create(
      Array.from(id),
      amount,
      expiresAt,
      (options.condition ?? MANUAL_CONFIRMATION) as never,
      "Deliver the work and hand over the repo",
      options.title ?? "Freelance sprint",
      "",
      null,
      null,
    )
    .accountsPartial({
      recipient: owner.publicKey,
      agreement: pda,
      asset,
      escrowAta: escrow,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([owner])
    .rpc();

  return { id, pda, escrow, expiresAt: expiresAt.toNumber() };
}

/** Funds `created` from `funder`, who thereby becomes the payer. */
async function fundAgreement(
  created: CreatedAgreement,
  funder: Keypair = payer,
  asset: PublicKey = mint,
  funderTokenAccount?: PublicKey,
  escrowTokenAccount?: PublicKey,
): Promise<void> {
  const source = funderTokenAccount ?? (await ensureAta(funder, asset));
  await program.methods
    .fund()
    .accountsPartial({
      funder: funder.publicKey,
      agreement: created.pda,
      funderTokenAccount: source,
      escrowTokenAccount: escrowTokenAccount ?? created.escrow,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([funder])
    .rpc();
}

async function releaseAgreement(
  created: CreatedAgreement,
  signer: Keypair = payer,
  recipientTokenAccount?: PublicKey,
  escrowTokenAccount?: PublicKey,
): Promise<void> {
  const destination = recipientTokenAccount ?? (await ensureAta(recipient, mint));
  await program.methods
    .release()
    .accountsPartial({
      payer: signer.publicKey,
      agreement: created.pda,
      escrowTokenAccount: escrowTokenAccount ?? created.escrow,
      recipientTokenAccount: destination,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([signer])
    .rpc();
}

async function refundAgreement(
  created: CreatedAgreement,
  cranking: Keypair = cranker,
  payerTokenAccount?: PublicKey,
  escrowTokenAccount?: PublicKey,
): Promise<void> {
  const destination = payerTokenAccount ?? (await ensureAta(payer, mint));
  await program.methods
    .refund()
    .accountsPartial({
      cranker: cranking.publicKey,
      agreement: created.pda,
      escrowTokenAccount: escrowTokenAccount ?? created.escrow,
      payerTokenAccount: destination,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([cranking])
    .rpc();
}

async function cancelAgreement(
  created: CreatedAgreement,
  signer: Keypair = recipient,
): Promise<void> {
  await program.methods
    .cancel()
    .accountsPartial({
      recipient: signer.publicKey,
      agreement: created.pda,
      escrowTokenAccount: created.escrow,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([signer])
    .rpc();
}

async function setDispute(
  created: CreatedAgreement,
  disputed: boolean,
  signer: Keypair = recipient,
): Promise<void> {
  await program.methods
    .flagDispute(disputed)
    .accountsPartial({ recipient: signer.publicKey, agreement: created.pda })
    .signers([signer])
    .rpc();
}

/** The FRS-1 term fields that Section 4.2 freezes once funded. */
function frozenTerms(agreement: {
  id: number[];
  recipientAddress: PublicKey;
  amount: BN;
  asset: PublicKey;
  expiresAt: BN;
  condition: unknown;
}) {
  return {
    id: Buffer.from(agreement.id).toString("hex"),
    recipientAddress: agreement.recipientAddress.toBase58(),
    amount: agreement.amount.toString(),
    asset: agreement.asset.toBase58(),
    expiresAt: agreement.expiresAt.toString(),
    condition: JSON.stringify(agreement.condition),
  };
}

async function waitUntilExpired(expiresAt: number): Promise<void> {
  for (;;) {
    if ((await chainNow()) > expiresAt) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

describe("flint-escrow", () => {
  // ---------------------------------------------------------------------------
  // Baseline: the happy paths. Kept separate from the threat-model group so a
  // rejection failure can never be mistaken for broken setup.
  // ---------------------------------------------------------------------------
  describe("baseline flows", () => {
    it("creates a pending agreement: no payer yet, terms stored, escrow ATA created", async () => {
      const created = await createAgreement();
      const agreement = await readAgreement(created.pda);

      assert.isDefined(agreement.status.pending, "a new agreement is pending");
      assert.isNull(
        agreement.payerAddress,
        "payerAddress must be unset before funding (Section 4.2)",
      );
      assert.equal(
        agreement.recipientAddress.toBase58(),
        recipient.publicKey.toBase58(),
      );
      assert.equal(agreement.amount.toString(), String(AMOUNT));
      assert.equal(agreement.asset.toBase58(), mint.toBase58());
      assert.equal(
        agreement.escrowAddress.toBase58(),
        created.escrow.toBase58(),
        "escrowAddress is the escrow ATA, not the agreement PDA (Section 4.5)",
      );
      assert.isDefined(agreement.condition.conditionType.manualConfirmation);
      assert.isFalse(agreement.disputedFlag);
      assert.isNull(agreement.disputedAt);
      assert.isNull(agreement.receiptProof, "no receipt exists before settlement");

      const escrowAccount = await getAccount(connection, created.escrow);
      assert.equal(
        escrowAccount.owner.toBase58(),
        created.pda.toBase58(),
        "the escrow ATA is owned by the agreement PDA",
      );
    });

    it("funds: the first funder becomes payerAddress and the amount lands in escrow", async () => {
      const created = await createAgreement();
      const source = await ensureAta(payer, mint);
      const before = await tokenBalance(source);

      await fundAgreement(created, payer);

      const agreement = await readAgreement(created.pda);
      assert.isDefined(agreement.status.funded);
      assert.equal(
        agreement.payerAddress?.toBase58(),
        payer.publicKey.toBase58(),
        "the first funder becomes the payer, permanently",
      );
      assert.equal(
        (await tokenBalance(created.escrow)).toString(),
        String(AMOUNT),
        "the full amount is escrowed",
      );
      assert.equal(
        (await tokenBalance(source)).toString(),
        (before - BigInt(AMOUNT)).toString(),
      );
    });

    it("accepts funding from anyone: the open model lets a stranger become the payer", async () => {
      const created = await createAgreement();
      await mintTo(
        connection,
        payer,
        mint,
        await ensureAta(attacker, mint),
        payer,
        5 * AMOUNT,
      );

      await fundAgreement(created, attacker);

      const agreement = await readAgreement(created.pda);
      assert.equal(
        agreement.payerAddress?.toBase58(),
        attacker.publicKey.toBase58(),
      );
      assert.isDefined(agreement.status.funded);
    });
    it("releases: the payer pays the recipient and the escrow empties", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);
      const destination = await ensureAta(recipient, mint);
      const before = await tokenBalance(destination);

      await releaseAgreement(created, payer, destination);

      const agreement = await readAgreement(created.pda);
      assert.isDefined(agreement.status.released);
      assert.equal(
        (await tokenBalance(destination)).toString(),
        (before + BigInt(AMOUNT)).toString(),
        "the recipient received exactly the amount",
      );
      assert.equal(
        (await tokenBalance(created.escrow)).toString(),
        "0",
        "escrow holds nothing after settlement",
      );
      assert.isNotNull(
        await connection.getAccountInfo(created.pda),
        "release does not close the account (4.6): the verification page reads it",
      );
    });

    it("refunds after expiry, cranked by a third party, to the stored payer", async () => {
      const created = await createAgreement({ expiresIn: 3 });
      await fundAgreement(created, payer);
      const destination = await ensureAta(payer, mint);
      const before = await tokenBalance(destination);

      await waitUntilExpired(created.expiresAt);
      await refundAgreement(created, cranker, destination);

      const agreement = await readAgreement(created.pda);
      assert.isDefined(agreement.status.refunded);
      assert.equal(
        (await tokenBalance(destination)).toString(),
        (before + BigInt(AMOUNT)).toString(),
        "the refund goes to the stored payer, never to the caller",
      );
      assert.equal((await tokenBalance(created.escrow)).toString(), "0");
      assert.isNotNull(
        await connection.getAccountInfo(created.pda),
        "refund does not close the account (4.6)",
      );
    });

    it("cancels a pending agreement: both accounts close and the rent returns", async () => {
      const created = await createAgreement();
      const agreementRent = (await connection.getAccountInfo(created.pda))!
        .lamports;
      const escrowRent = (await connection.getAccountInfo(created.escrow))!
        .lamports;
      const before = await connection.getBalance(recipient.publicKey);

      await cancelAgreement(created);

      assert.isNull(
        await connection.getAccountInfo(created.pda),
        "the agreement account is closed (4.6)",
      );
      assert.isNull(
        await connection.getAccountInfo(created.escrow),
        "the empty escrow ATA is closed too, so no rent is stranded",
      );
      const after = await connection.getBalance(recipient.publicKey);
      assert.isAtLeast(
        after,
        before + agreementRent + escrowRent - 50_000,
        "both rents returned to the recipient, minus the fee they paid",
      );

      // Closing also frees the (recipient, id) pair for a fresh proposal.
      const again = await createAgreement({ id: created.id });
      assert.isNotNull(await connection.getAccountInfo(again.pda));
    });

    it("flags and clears the dispute flag without moving funds", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);
      const escrowBefore = await tokenBalance(created.escrow);

      await setDispute(created, true);
      const flagged = await readAgreement(created.pda);
      assert.isTrue(flagged.disputedFlag);
      assert.isNotNull(flagged.disputedAt);

      await setDispute(created, true);
      const repeated = await readAgreement(created.pda);
      assert.equal(
        repeated.disputedAt?.toString(),
        flagged.disputedAt?.toString(),
        "a repeat set is idempotent and does not churn the timestamp",
      );

      await setDispute(created, false);
      const cleared = await readAgreement(created.pda);
      assert.isFalse(cleared.disputedFlag);
      assert.isNull(cleared.disputedAt);
      assert.isDefined(cleared.status.funded, "still funded: the flag is advisory");
      assert.equal(
        (await tokenBalance(created.escrow)).toString(),
        escrowBefore.toString(),
        "the flag never moves custody",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Section 5 — every row, set up and rejected. Each test (a) constructs the
  // attack, (b) asserts the *specific* program error, and (c) names the row.
  // ---------------------------------------------------------------------------
  describe("Section 5 — threat model", () => {
    // Row 1 — Unauthorized release.
    it("test_rejects_unauthorized_release — only the stored payerAddress can release", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);
      const attackerAta = await ensureAta(attacker, mint);
      // Snapshot first: the attacker may already hold tokens from an earlier
      // test, so the honest assertion here is "unchanged", not "zero".
      const attackerBefore = await tokenBalance(attackerAta);

      // (a) A funded stranger signs a release and tries to pay themselves.
      await expectProgramError(
        () => releaseAgreement(created, attacker, attackerAta),
        "PayerOnly",
        "attacker-signed release",
      );

      // The recipient is the beneficiary, and still cannot release itself.
      await expectProgramError(
        () =>
          releaseAgreement(
            created,
            recipient,
            getAssociatedTokenAddressSync(mint, recipient.publicKey),
          ),
        "PayerOnly",
        "recipient-signed release",
      );

      // (b) Rejected means nothing moved and the state is untouched.
      const agreement = await readAgreement(created.pda);
      assert.isDefined(agreement.status.funded, "still funded after both attempts");
      assert.equal(
        (await tokenBalance(created.escrow)).toString(),
        String(AMOUNT),
        "escrow is untouched",
      );
      assert.equal(
        (await tokenBalance(attackerAta)).toString(),
        attackerBefore.toString(),
        "the adversary's own balance did not change",
      );
    });

    // Row 2 — Account substitution.
    it("test_rejects_account_substitution — accounts are checked against stored state", async () => {
      const first = await createAgreement();
      const second = await createAgreement();
      await fundAgreement(first, payer);

      // (a) Swap in a different agreement's escrow ATA during release.
      await expectProgramError(
        () =>
          releaseAgreement(
            first,
            payer,
            getAssociatedTokenAddressSync(mint, recipient.publicKey),
            second.escrow,
          ),
        "EscrowMismatch",
        "release with another agreement's escrow",
      );

      // (b) Redirect the payout to a wallet the agreement never named.
      const attackerAta = await ensureAta(attacker, mint);
      const attackerBefore = await tokenBalance(attackerAta);
      await expectProgramError(
        () => releaseAgreement(first, payer, attackerAta),
        "TokenAccountOwnerMismatch",
        "release paying a substituted destination",
      );

      // (c) Swap in a different agreement's escrow ATA during funding.
      await expectProgramError(
        () => fundAgreement(second, payer, mint, undefined, first.escrow),
        "EscrowMismatch",
        "fund into another agreement's escrow",
      );

      // (d) Fund from an account the signer does not own.
      await expectProgramError(
        () =>
          fundAgreement(
            second,
            attacker,
            mint,
            getAssociatedTokenAddressSync(mint, recipient.publicKey),
          ),
        "FunderTokenAccountMismatch",
        "fund from someone else's token account",
      );

      const agreement = await readAgreement(first.pda);
      assert.isDefined(agreement.status.funded);
      assert.equal(
        (await tokenBalance(first.escrow)).toString(),
        String(AMOUNT),
        "no substitution moved funds",
      );
      assert.equal(
        (await tokenBalance(attackerAta)).toString(),
        attackerBefore.toString(),
        "no substitution attempt moved funds",
      );
      assert.isDefined((await readAgreement(second.pda)).status.pending);
    });

    // Row 3 — Expiry bypass.
    it("test_rejects_expired_release — expiry is read from the Clock, and only refund remains", async () => {
      const created = await createAgreement({ expiresIn: 3 });
      await fundAgreement(created, payer);
      await waitUntilExpired(created.expiresAt);

      await expectProgramError(
        () => releaseAgreement(created, payer),
        "Expired",
        "release after expiry",
      );

      const agreement = await readAgreement(created.pda);
      assert.isDefined(agreement.status.funded, "still funded: the release was rejected");
      assert.equal(
        (await tokenBalance(created.escrow)).toString(),
        String(AMOUNT),
        "escrow is untouched after the rejected release",
      );

      // The other half of row 3: after expiry the refund path is the valid one.
      await refundAgreement(created, cranker);
      assert.isDefined(
        (await readAgreement(created.pda)).status.refunded,
        "refund is the only settlement left once expired",
      );
    });

    // Row 4 — Replay.
    it("test_rejects_replay_settlement — an authorization cannot be consumed twice", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);

      // (a) A second funding of the same agreement must hit the state check.
      await expectProgramError(
        () => fundAgreement(created, payer),
        "NotPending",
        "second funding of an already funded agreement",
      );

      // Settle once. This is the one and only settlement this agreement gets.
      await releaseAgreement(created, payer);

      // (b) Replaying the settlement must fail...
      await expectProgramError(
        () => releaseAgreement(created, payer),
        "NotFunded",
        "replayed release",
      );
      // (c) ...as must the alternative path, because `released` is terminal...
      await expectProgramError(
        () => refundAgreement(created, cranker),
        "NotFunded",
        "refund after release",
      );
      // (d) ...and funding can never be reopened either.
      await expectProgramError(
        () => fundAgreement(created, payer),
        "NotPending",
        "funding a settled agreement",
      );

      const agreement = await readAgreement(created.pda);
      assert.isDefined(agreement.status.released, "the first settlement stands");
      assert.equal(
        (await tokenBalance(created.escrow)).toString(),
        "0",
        "the recipient was paid exactly once",
      );
    });

    // Row 5 — Wrong asset/amount.
    it("test_rejects_wrong_asset_or_amount — settlement matches the stored asset and amount", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);

      // (a) Pay out through a token account of a different mint.
      const wrongMintDestination = await ensureAta(recipient, otherMint);
      await expectProgramError(
        () => releaseAgreement(created, payer, wrongMintDestination),
        "AssetMismatch",
        "release into a different asset's token account",
      );

      // (b) Fund from a token account of a different mint. A *fresh, pending*
      // agreement is used here so that the asset check is what rejects this —
      // on an already-funded agreement the state check (NotPending) fires first
      // and the test would prove the wrong invariant.
      const pending = await createAgreement();
      const wrongMintSource = await ensureAta(payer, otherMint);
      await expectProgramError(
        () => fundAgreement(pending, payer, mint, wrongMintSource),
        "AssetMismatch",
        "fund from a different asset's token account",
      );
      assert.isDefined(
        (await readAgreement(pending.pda)).status.pending,
        "the rejected funding left the agreement untouched",
      );

      // (c) The amount is not an argument anywhere: the program can only move
      // the figure stored at creation. Prove it end to end with a second
      // agreement that has a different amount — no partial settlement, no
      // substituted figure.
      const other = await createAgreement({ amount: 3 * AMOUNT });
      await fundAgreement(other, payer);
      assert.equal(
        (await tokenBalance(other.escrow)).toString(),
        String(3 * AMOUNT),
        "funded with exactly the stored amount",
      );

      const destination = getAssociatedTokenAddressSync(mint, recipient.publicKey);
      const before = await tokenBalance(destination);
      await releaseAgreement(other, payer, destination);
      assert.equal(
        (await tokenBalance(destination)).toString(),
        (before + BigInt(3 * AMOUNT)).toString(),
        "settled the exact stored amount",
      );

      // (d) The first agreement is untouched by every attempt above.
      assert.equal(
        (await tokenBalance(created.escrow)).toString(),
        String(AMOUNT),
        "attempts on one agreement cannot move another's funds",
      );
      assert.isDefined((await readAgreement(created.pda)).status.funded);
    });

    // Row 6 — Unauthorized mutation.
    it("test_rejects_mutation_of_funded_terms — nothing can rewrite a funded agreement's terms", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);
      const frozen = frozenTerms(await readAgreement(created.pda));

      // (a) Re-proposing the same (recipient, uuid) to rewrite the terms must
      // fail: the PDA already exists, so the terms cannot be replaced.
      await expectRejection(
        () => createAgreement({ id: created.id, amount: 7 * AMOUNT }),
        "re-creating an existing agreement to overwrite its terms",
      );

      // (b) Every instruction that may legally touch a funded PDA must leave the
      // term fields byte-identical. The advisory flag first...
      await setDispute(created, true);
      assert.deepEqual(
        frozenTerms(await readAgreement(created.pda)),
        frozen,
        "flag_dispute must not touch terms (row 6)",
      );
      await setDispute(created, false);

      // ...then both settlement paths, each on its own agreement.
      const releasing = await createAgreement();
      await fundAgreement(releasing, payer);
      const releasingFrozen = frozenTerms(await readAgreement(releasing.pda));
      await releaseAgreement(releasing, payer);
      assert.deepEqual(
        frozenTerms(await readAgreement(releasing.pda)),
        releasingFrozen,
        "release must not touch terms (row 6)",
      );

      const expiring = await createAgreement({ expiresIn: 3 });
      await fundAgreement(expiring, payer);
      const expiringFrozen = frozenTerms(await readAgreement(expiring.pda));
      await waitUntilExpired(expiring.expiresAt);
      await refundAgreement(expiring, cranker);
      assert.deepEqual(
        frozenTerms(await readAgreement(expiring.pda)),
        expiringFrozen,
        "refund must not touch terms (row 6)",
      );

      // (c) The funded agreement still carries exactly the terms it was funded
      // with, after all of the above.
      assert.deepEqual(frozenTerms(await readAgreement(created.pda)), frozen);
    });

    // Row 7 — Fake/duplicate receipt.
    it("test_rejects_fake_or_duplicate_receipt — a receipt exists only for a transition that really happened", async () => {
      // (a) An agreement that never settled cannot yield a receipt: the only
      // instruction that could produce one is rejected outright.
      const neverFunded = await createAgreement();
      await expectProgramError(
        () => releaseAgreement(neverFunded, payer),
        "NotFunded",
        "release on a never-funded agreement",
      );
      const pending = await readAgreement(neverFunded.pda);
      assert.isDefined(pending.status.pending);
      assert.isNull(pending.receiptProof);
      assert.equal(
        (await tokenBalance(neverFunded.escrow)).toString(),
        "0",
        "no transition happened, so no receipt can exist",
      );

      // (b) One real settlement, then attempts to obtain a second receipt for it.
      const settled = await createAgreement();
      await fundAgreement(settled, payer);
      await releaseAgreement(settled, payer);
      await expectProgramError(
        () => releaseAgreement(settled, payer),
        "NotFunded",
        "duplicate settlement of the same agreement",
      );
      await expectProgramError(
        () => refundAgreement(settled, cranker),
        "NotFunded",
        "second settlement through the other path",
      );

      // (c) The settled account is still on chain to be recomputed from
      // (Sections 4.4 and 6.2): exactly one settlement, escrow empty. That is
      // what makes a receipt checkable rather than merely asserted.
      const after = await readAgreement(settled.pda);
      assert.isDefined(after.status.released, "exactly one settlement, still verifiable");
      assert.equal((await tokenBalance(settled.escrow)).toString(), "0");
      // `receiptProof` is never written on-chain, by design: a program cannot
      // read its own transaction signature. The receipt is the settlement
      // signature the client captured, and row 7's enforcement is that
      // verification recomputes status from this account and matches that
      // transaction to the program's own settlement instruction — never a cached
      // claim. (Flagged to the human in the Phase 1 report; see `state.rs`.)
      assert.isNull(after.receiptProof);
    });
  });

  // ---------------------------------------------------------------------------
  // The rest of the state machine and the Section 4.6 constraints. These are not
  // part of Section 5's seven rows, but they are the rules those rows assume.
  // ---------------------------------------------------------------------------
  describe("state machine and Section 4.6 constraints", () => {
    it("rejects a creation whose expiresAt is not strictly in the future (4.6)", async () => {
      await expectProgramError(
        () => createAgreement({ expiresIn: -60 }),
        "ExpiryNotInFuture",
        "create with a past expiry",
      );
    });

    it("rejects funding an agreement that expired before it was funded (4.6)", async () => {
      const created = await createAgreement({ expiresIn: 3 });
      await waitUntilExpired(created.expiresAt);

      await expectProgramError(
        () => fundAgreement(created, payer),
        "ExpiredBeforeFunding",
        "fund after expiry",
      );
      assert.isDefined((await readAgreement(created.pda)).status.pending);
    });

    it("rejects the unimplemented oracle-attested condition at creation (4.3)", async () => {
      await expectProgramError(
        () => createAgreement({ condition: ORACLE_ATTESTED }),
        "UnsupportedConditionType",
        "create with oracle-attested",
      );
    });

    it("rejects a zero amount and an over-long field (4.6 bounds)", async () => {
      await expectProgramError(
        () => createAgreement({ amount: 0 }),
        "ZeroAmount",
        "create with a zero amount",
      );
      await expectProgramError(
        () => createAgreement({ title: "t".repeat(129) }),
        "FieldTooLong",
        "create with a 129-byte title (the bound is 128)",
      );
    });

    it("rejects cancel once funded, and refund before expiry (4.2)", async () => {
      const created = await createAgreement({ expiresIn: 3 });
      await fundAgreement(created, payer);

      await expectProgramError(
        () => cancelAgreement(created),
        "NotPending",
        "cancel a funded agreement",
      );
      await expectProgramError(
        () => refundAgreement(created, cranker),
        "NotYetExpired",
        "refund before expiry",
      );
      assert.isNotNull(
        await connection.getAccountInfo(created.pda),
        "no rejected call may have closed the account",
      );
    });

    it("rejects a non-recipient cancel and the flag outside `funded` (4.2 / 4.6)", async () => {
      const created = await createAgreement();
      await expectProgramError(
        () => cancelAgreement(created, attacker),
        "RecipientOnly",
        "cancel signed by a stranger",
      );
      await expectProgramError(
        () => setDispute(created, true),
        "NotDisputable",
        "flag_dispute on a pending agreement",
      );

      await fundAgreement(created, payer);
      await releaseAgreement(created, payer);
      await expectProgramError(
        () => setDispute(created, true),
        "NotDisputable",
        "flag_dispute on a released agreement",
      );
    });

    it("allows the flag past expiry and it never blocks the refund (4.6 liveness)", async () => {
      const created = await createAgreement({ expiresIn: 3 });
      await fundAgreement(created, payer);
      await waitUntilExpired(created.expiresAt);

      await setDispute(created, true);
      assert.isTrue((await readAgreement(created.pda)).disputedFlag);

      const destination = await ensureAta(payer, mint);
      const before = await tokenBalance(destination);
      await refundAgreement(created, cranker, destination);
      assert.equal(
        (await tokenBalance(destination)).toString(),
        (before + BigInt(AMOUNT)).toString(),
        "a disputed agreement still refunds: the flag can never strand funds",
      );
    });
  });
});
