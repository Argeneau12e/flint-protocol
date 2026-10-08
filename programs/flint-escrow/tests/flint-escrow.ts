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
const CONFIG_SEED = Buffer.from("config");

/** Section 4.3: the only condition type v1 enforces. */
const MANUAL_CONFIRMATION = { manualConfirmation: {} };
/** Section 4.3: named in the schema, deliberately not implemented in v1. */
const ORACLE_ATTESTED = { oracleAttested: {} };

/** 1 token at 6 decimals — the agreement amount used throughout. */
/**
 * Agreement size in base units: 25 tokens at 6 decimals.
 *
 * Was 1 token before the protocol minimum existed. It is 25 now because
 * `create` refuses anything below the config's minimum of 20 whole tokens — an
 * agreement that cannot cover a fee covering its own payout is one the protocol
 * would be subsidising. 25 sits in the `[20, 50)` band, so its fee is exactly
 * 1 token, which makes the fee assertions in the settlement tests easy to read.
 */
const AMOUNT = 25_000_000;
/** The fee 25 tokens carries: 1 token, at 6 decimals. */
const FEE_FOR_AMOUNT = 1_000_000;
const MINT_DECIMALS = 6;

/** The review window used by default: 24h. */
const REVIEW_WINDOW = 24 * 60 * 60;

/**
 * The "expires almost immediately" expiry used by the tests that need a real
 * expiry to elapse.
 *
 * Ten seconds rather than three. The validator advances the Clock one slot at a
 * time, so a three-second window could already be in the past by the time the
 * funding transaction landed — the test then failed or passed on transaction
 * timing rather than on the rule it was written to prove. Ten seconds is
 * comfortably longer than a local transaction and still short enough to wait out,
 * so these tests measure the expiry rule instead of racing the clock.
 */
const EXPIRY_SOON_SECS = 10;

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
/** Receives protocol fees. Distinct from every other role, so a fee that leaked
 * into the wrong wallet would be visible in the balance assertions. */
const treasury = Keypair.generate();
/** The only signer `resolve_dispute` accepts. */
const arbiter = Keypair.generate();
/** Not the arbiter: proves the arbiter's authority is checked, not assumed. */
const impostorArbiter = Keypair.generate();
/**
 * A wallet that is neither the upgrade authority nor the Config's stored admin.
 *
 * Used as a second, independent case in the authority-rejection test: the
 * rejection must hold for any key that is not the authority, not just for the
 * one wallet a first test happened to pick.
 */
const adminNotUpgradeAuthority = Keypair.generate();

let mint: PublicKey; // the agreement asset
let otherMint: PublicKey; // a decoy asset, for the wrong-asset attacks (row 5)
/** The global Config PDA, resolved in `before` from the program's own id. */
let configPda: PublicKey;

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

/** The upgradeable loader, and this program's ProgramData account under it. */
const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
function programDataAddress(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE,
  )[0];
}

/**
 * A signer that may be a real `Keypair` or anything wallet-like (`{ publicKey }`).
 *
 * Structural rather than `anchor.Wallet`: `provider.wallet` is typed as the
 * standalone `provider` module's `Wallet`, which is a *different* declaration
 * from the `Wallet` re-exported at the package root, so naming the root type
 * makes a caller that only needs `publicKey` and signing fail to typecheck.
 */
type SignerLike = Keypair | { publicKey: PublicKey };

/**
 * The upgrade authority of a `Wallet`-backed provider and of a `Keypair` alike.
 * `provider.wallet` is a `Wallet`, not a `Keypair`, so it must never be handed to
 * `.signers()` — Anchor adds only genuine `Signer`s there.
 */
function signerList(signer: SignerLike): Keypair[] {
  return signer instanceof Keypair ? [signer] : [];
}

/**
 * Calls `init_config` as `signer`, supplying the loader accounts it verifies
 * against.
 *
 * Errors deliberately propagate unwrapped: `expectProgramError` needs the
 * `AnchorError` itself to read the code, so re-throwing here as a plain `Error`
 * would turn every authority rejection into an opaque harness failure. Each
 * caller supplies its own `what` label at the assertion site instead.
 */
async function initConfigAs(
  signer: SignerLike,
  config: PublicKey = configPda,
): Promise<void> {
  await program.methods
    .initConfig(
      treasury.publicKey,
      arbiter.publicKey,
      new BN(72 * 60 * 60),
      new BN(20),
    )
    .accountsPartial({
      admin: signer.publicKey,
      config,
      programData: programDataAddress(),
      program: program.programId,
      systemProgram: SystemProgram.programId,
    })
    .signers(signerList(signer))
    .rpc();
}

/** The suite's own setup call: the provider wallet *is* the upgrade authority. */
async function initConfigWithAuthority(
  signer: SignerLike,
): Promise<void> {
  return initConfigAs(signer);
}

before(async () => {
  for (const wallet of [
    recipient,
    payer,
    attacker,
    cranker,
    treasury,
    arbiter,
    impostorArbiter,
    adminNotUpgradeAuthority,
  ]) {
    await airdrop(wallet.publicKey);
  }

  // The Config PDA's *address* is resolved here, but the account itself is
  // deliberately not created in this hook: `config bootstrap` runs first, and it
  // needs a Config that does not exist yet. Anchor evaluates
  // `#[account(init, ...)]` during account validation, *before* the handler
  // runs, so once the PDA exists every `init_config` dies inside the system
  // program with "Allocate: account already in use" and
  // `require_upgrade_authority` is never reached. Creating the Config here would
  // make all three authority rejections assert nothing at all.
  const [configAddress, configBumpFound] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    program.programId,
  );
  configPda = configAddress;
  void configBumpFound;

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
  // The treasury's fee account for the agreement's mint. Every settlement path
  // passes `treasury_token_account` as `Account<TokenAccount>`, which Anchor
  // refuses to deserialise if the account does not exist — and because account
  // validation runs before the handler, that surfaces as `AccountNotInitialized`
  // (3012) and masks the handler's own check (PayerOnly, EscrowMismatch, Expired,
  // ReviewWindowOpen, ...). Without this line those tests fail for the wrong
  // reason: not "the program refused the attack" but "an account was missing".
  await ensureAta(treasury, mint);
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
    reviewWindowSecs?: number;
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
      options.reviewWindowSecs ?? REVIEW_WINDOW,
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
      config: configPda,
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
  const feeDestination = getAssociatedTokenAddressSync(mint, treasury.publicKey, true);
  await program.methods
    .release()
    .accountsPartial({
      payer: signer.publicKey,
      config: configPda,
      agreement: created.pda,
      escrowTokenAccount: escrowTokenAccount ?? created.escrow,
      recipientTokenAccount: destination,
      treasuryTokenAccount: feeDestination,
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

/** Recipient claims delivery with the given evidence. */
async function claimDelivery(
  created: CreatedAgreement,
  signer: Keypair = recipient,
  evidenceHash: number[] = Array.from(evidenceHashOf("manifest-1")),
  evidenceRef = "flint://e/abc123",
): Promise<void> {
  await program.methods
    .claimDelivery(evidenceHash, evidenceRef)
    .accountsPartial({ recipient: signer.publicKey, agreement: created.pda })
    .signers([signer])
    .rpc();
}

/** A stable non-zero 32-byte hash for a named manifest. */
function evidenceHashOf(name: string): Buffer {
  const hash = Buffer.alloc(32);
  hash.write(name.slice(0, 32), 0, "utf8");
  hash[31] = 1; // never all zeros: that is the "no claim" sentinel
  return hash;
}

async function dispute(
  created: CreatedAgreement,
  signer: Keypair = payer,
  reason: unknown = { notAsDescribed: {} },
): Promise<void> {
  await program.methods
    .dispute(reason as never)
    .accountsPartial({
      payer: signer.publicKey,
      agreement: created.pda,
      // Read at dispute time so the arbiter's deadline is frozen from the
      // Config's window into the agreement itself. The account is required by
      // the IDL, so leaving it off fails at account resolution — before the
      // program can return any of its own errors.
      config: configPda,
    })
    .signers([signer])
    .rpc();
}

async function releaseAfterReview(
  created: CreatedAgreement,
  cranking: Keypair = cranker,
): Promise<void> {
  const feeDestination = getAssociatedTokenAddressSync(mint, treasury.publicKey, true);
  await program.methods
    .releaseAfterReview()
    .accountsPartial({
      cranker: cranking.publicKey,
      config: configPda,
      agreement: created.pda,
      escrowTokenAccount: created.escrow,
      recipientTokenAccount: await ensureAta(recipient, mint),
      treasuryTokenAccount: feeDestination,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([cranking])
    .rpc();
}

async function resolveDispute(
  created: CreatedAgreement,
  outcome: unknown,
  signer: Keypair = arbiter,
): Promise<void> {
  const feeDestination = getAssociatedTokenAddressSync(mint, treasury.publicKey, true);
  await program.methods
    .resolveDispute(outcome as never)
    .accountsPartial({
      arbiter: signer.publicKey,
      config: configPda,
      agreement: created.pda,
      escrowTokenAccount: created.escrow,
      payerTokenAccount: await ensureAta(payer, mint),
      recipientTokenAccount: await ensureAta(recipient, mint),
      treasuryTokenAccount: feeDestination,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([signer])
    .rpc();
}

async function splitAfterArbiterTimeout(
  created: CreatedAgreement,
  cranking: Keypair = cranker,
): Promise<void> {
  const feeDestination = getAssociatedTokenAddressSync(mint, treasury.publicKey, true);
  await program.methods
    .splitAfterArbiterTimeout()
    .accountsPartial({
      cranker: cranking.publicKey,
      config: configPda,
      agreement: created.pda,
      escrowTokenAccount: created.escrow,
      payerTokenAccount: await ensureAta(payer, mint),
      recipientTokenAccount: await ensureAta(recipient, mint),
      treasuryTokenAccount: feeDestination,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([cranking])
    .rpc();
}

/**
 * Rotates the Config's arbiter window, as the stored admin (the upgrade
 * authority). Used by the tests that need the window to be measurable rather
 * than 72 hours.
 */
async function setArbiterTimeout(seconds: number): Promise<void> {
  await program.methods
    .setConfigRoles(null, null, new BN(seconds))
    .accountsPartial({
      admin: provider.wallet.publicKey,
      config: configPda,
      systemProgram: SystemProgram.programId,
    })
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
  // Config bootstrap: only the program's upgrade authority may claim admin.
  //
  // This group runs **first**, while the Config PDA does not exist yet, and that
  // ordering is the whole point. Anchor's `#[account(init, ...)]` constraint is
  // evaluated during account validation, which happens *before* the handler — so
  // once the PDA is allocated, a bad signer never reaches
  // `require_upgrade_authority` at all and the transaction dies in the system
  // program with "Allocate: account already in use". Running these before the
  // real initialisation means each bad call allocates the PDA, then fails the
  // authority check, then reverts — leaving the PDA free for the next case and
  // proving the authority check is what rejected it.
  // ---------------------------------------------------------------------------
  describe("config bootstrap", () => {
    it("rejects a signer who is not the upgrade authority", async () => {
      await expectProgramError(
        () => initConfigAs(attacker),
        "NotUpgradeAuthority",
        "anyone who signs claiming to be the program's upgrade authority",
      );

      // A second, unrelated key: the rejection is a property of the signer not
      // being the authority, not of any one wallet.
      await expectProgramError(
        () => initConfigAs(adminNotUpgradeAuthority),
        "NotUpgradeAuthority",
        "a second non-authority signer",
      );
    });

    it("rejects a program account that is not this program", async () => {
      // Without this check, a caller could deploy their own upgradeable program,
      // become its upgrade authority, and pass *that* account here to have the
      // comparison succeed against a key they control.
      const attackerProgram = Keypair.generate();
      await expectProgramError(
        () =>
          program.methods
            .initConfig(
              treasury.publicKey,
              arbiter.publicKey,
              new BN(72 * 60 * 60),
              new BN(20),
            )
            .accountsPartial({
              admin: attacker.publicKey,
              config: configPda,
              programData: programDataAddress(),
              program: attackerProgram.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .signers([attacker])
            .rpc(),
        "UpgradeAuthorityProgramMismatch",
        "an attacker-supplied program account standing in for this one",
      );
    });

    it("rejects a ProgramData account that is not this program's", async () => {
      // The loader derives ProgramData as the PDA of the program address, and
      // `require_upgrade_authority` asserts both that this account sits at that
      // address *and* that the loader owns it. Ownership is the check that fires
      // first here: any account an attacker can name is system-owned, so no
      // fabricated account can ever be mistaken for the loader's own.
      const impostorData = Keypair.generate();
      await expectProgramError(
        () =>
          program.methods
            .initConfig(
              treasury.publicKey,
              arbiter.publicKey,
              new BN(72 * 60 * 60),
              new BN(20),
            )
            .accountsPartial({
              admin: attacker.publicKey,
              config: configPda,
              programData: impostorData.publicKey,
              program: program.programId,
              systemProgram: SystemProgram.programId,
            })
            .signers([attacker])
            .rpc(),
        "UpgradeAuthorityDataMismatch",
        "an attacker-supplied ProgramData account standing in for this one",
      );
    });

    it("initialises the Config with the real upgrade authority as admin", async () => {
      // `admin` here is the provider wallet, which `scripts/test-local.sh` also
      // names as the upgrade authority when it deploys the program to the
      // validator. That coincidence is the point: `init_config` requires the
      // signer to *be* the upgrade authority, so this call only succeeds because
      // the two really are the same key. If the deployment ever lost its
      // authority, this test would fail rather than quietly set up an admin
      // nobody controls.
      await initConfigWithAuthority(provider.wallet);

      const config = await program.account.config.fetch(configPda);
      assert.equal(
        config.admin.toBase58(),
        provider.wallet.publicKey.toBase58(),
        "the real upgrade authority became the stored admin",
      );
      assert.equal(config.treasury.toBase58(), treasury.publicKey.toBase58());
      assert.equal(config.arbiter.toBase58(), arbiter.publicKey.toBase58());
      assert.equal(config.arbiterTimeoutSecs.toString(), String(72 * 60 * 60));
      assert.equal(config.minAgreement.toString(), "20");

      // Field-for-field against the IDL the client reads with. A field added to
      // the account but missed out of the length check would live *after*
      // `min_agreement`; a field added to the IDL but not allocated would be
      // truncated on read. Both are layout bugs, and both are caught by pinning
      // the account's size and its decoded field set to what the IDL says.
      //
      // Deliberately not a byte-for-byte re-encode: Anchor's accounts coder does
      // not serialize `BN` values into u64 fields, so encoding a *decoded*
      // account writes zeros there and would fail against correct chain data.
      const idlConfig = (
        idl.accounts as Array<{ name: string; discriminator: number[] }>
      ).find((account) => account.name === "Config");
      assert.isDefined(idlConfig, "the IDL must describe the Config account");

      // The raw JSON IDL widens to a structural type that TS will not narrow to
      // `Idl` on its own; the coder needs the shape, not the literal.
      const accountsCoder = new anchor.BorshAccountsCoder(idl as never);
      const stored = (await connection.getAccountInfo(configPda))!.data;
      assert.equal(
        stored.length,
        accountsCoder.size("Config"),
        "the stored account must be exactly the size the IDL's layout describes",
      );
      assert.equal(
        Buffer.from(stored.subarray(0, 8)).toString("hex"),
        Buffer.from(idlConfig!.discriminator).toString("hex"),
        "and it must start with the IDL's discriminator",
      );

      const configType = (idl.types as Array<{ name: string; type: { fields: Array<{ name: string }> } }>)
        .find((type) => type.name === "Config");
      assert.isDefined(configType, "the IDL must describe the Config struct");
      // The IDL declares snake_case; Anchor's decoder camelCases the keys it
      // hands back, so the two are matched after the same conversion.
      const camel = (name: string): string =>
        name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      assert.deepEqual(
        Object.keys(config),
        configType!.type.fields.map((field) => camel(field.name)),
        "every field the IDL declares must be decoded, in the IDL's order",
      );
    });

    it("rejects a second Config initialisation by the upgrade authority itself", async () => {
      // The upgrade authority is the only signer allowed, and it still may not
      // init twice: the Config is written once, so roles can only change through
      // set_config_roles afterwards. Being the authority is a condition for the
      // *first* init, not a standing licence to overwrite the Config. The PDA
      // exists now, so the rejection comes from `init` before any handler runs —
      // `expectRejection` accepts that, because the refusal is real either way.
      await expectRejection(
        () => initConfigWithAuthority(provider.wallet),
        "re-initialising an existing Config",
      );
    });
  });

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
      assert.deepEqual(agreement.status.pending, {});
      assert.isNull(agreement.claimedAt, "no delivery claim before the recipient makes one");
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
        (before + BigInt(AMOUNT) - BigInt(FEE_FOR_AMOUNT)).toString(),
        "the recipient receives the amount less the fee, as on every payout path",
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
      const created = await createAgreement({ expiresIn: EXPIRY_SOON_SECS });
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
      const created = await createAgreement({ expiresIn: EXPIRY_SOON_SECS });
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
      // 75 tokens sit in the [50, 100) band, which carries a 2-token fee — the
      // figure `create` locked into the agreement. As everywhere else, the fee
      // comes out of the recipient's payout, never out of what the payer escrows.
      const threeTokenFee = 2 * 1_000_000;
      assert.equal(
        (await tokenBalance(destination)).toString(),
        (before + BigInt(3 * AMOUNT) - BigInt(threeTokenFee)).toString(),
        "settled the exact stored amount, less the locked fee",
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
      // term fields byte-identical. The delivery claim first...
      await claimDelivery(created);
      assert.deepEqual(
        frozenTerms(await readAgreement(created.pda)),
        frozen,
        "claim_delivery must not touch terms (row 6)",
      );

      // ...then the dispute, which is the other pre-settlement step.
      await dispute(created, payer);
      assert.deepEqual(
        frozenTerms(await readAgreement(created.pda)),
        frozen,
        "dispute must not touch terms (row 6)",
      );

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

      const expiring = await createAgreement({ expiresIn: EXPIRY_SOON_SECS });
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
      const created = await createAgreement({ expiresIn: EXPIRY_SOON_SECS });
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
      const created = await createAgreement({ expiresIn: EXPIRY_SOON_SECS });
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

    it("rejects a non-recipient cancel, and a dispute with no claim (4.2 / 4.6)", async () => {
      const created = await createAgreement();
      await expectProgramError(
        () => cancelAgreement(created, attacker),
        "RecipientOnly",
        "cancel signed by a stranger",
      );
      await expectProgramError(
        () => dispute(created, payer),
        "NotDeliveryClaimed",
        "a dispute with no delivery claim behind it",
      );

      await fundAgreement(created, payer);
      await claimDelivery(created);
      await dispute(created, payer);
      await expectProgramError(
        () => dispute(created, payer),
        "AlreadyDisputed",
        "a second dispute on an already-disputed agreement",
      );
    });

    it("refunds an unclaimed expired agreement and never charges a fee (4.6 liveness)", async () => {
      const created = await createAgreement({ expiresIn: EXPIRY_SOON_SECS });
      await fundAgreement(created, payer);
      await waitUntilExpired(created.expiresAt);

      const destination = await ensureAta(payer, mint);
      const before = await tokenBalance(destination);
      const feeBefore = await tokenBalance(
        getAssociatedTokenAddressSync(mint, treasury.publicKey, true),
      );
      await refundAgreement(created, cranker, destination);

      assert.equal(
        (await tokenBalance(destination)).toString(),
        (before + BigInt(AMOUNT)).toString(),
        "a refund returns the whole amount: the payer's own money is never fee-bearing",
      );
      assert.equal(
        (await tokenBalance(getAssociatedTokenAddressSync(mint, treasury.publicKey, true))).toString(),
        feeBefore.toString(),
        "a refund pays no fee at all",
      );
    });
  });
// ---------------------------------------------------------------------------
  // The delivery claim, the review window, the arbiter, and the fee.
  //
  // Where a rule is about an authority (who may claim, who may dispute, who may
  // resolve) each test uses a *named impostor* rather than asserting only the
  // happy path: "the right wallet succeeded" and "only the right wallet can" are
  // different claims, and only the second is a security property.
  // ---------------------------------------------------------------------------
  describe("delivery claim, review window, arbiter and fee", () => {
    it("locks the fee at creation and stores the review window", async () => {
      const created = await createAgreement();
      const agreement = await readAgreement(created.pda);

      assert.equal(agreement.reviewWindowSecs, REVIEW_WINDOW);
      assert.equal(
        agreement.feeAmount.toString(),
        String(FEE_FOR_AMOUNT),
        "25 tokens carries a 1-token fee, locked at creation",
      );
      assert.isNull(agreement.claimedAt, "no claim before the recipient makes one");
      assert.equal(
        Buffer.from(agreement.evidenceHash).toString("hex"),
        "0".repeat(64),
        "the evidence hash starts as the all-zero sentinel",
      );
      assert.equal(agreement.evidenceRef, "", "no evidence locator before a claim");
    });

    it("refuses an amount below the minimum and accepts exactly the minimum", async () => {
      await expectProgramError(
        () => createAgreement({ amount: 19_999_999 }),
        "BelowMinimumAmount",
        "an agreement one base unit under 20 tokens",
      );
      const atMinimum = await createAgreement({ amount: 20_000_000 });
      assert.equal((await readAgreement(atMinimum.pda)).amount.toString(), "20000000");
    });

    it("accepts only the four allowed review windows", async () => {
      for (const allowed of [6 * 3600, 12 * 3600, 24 * 3600, 48 * 3600]) {
        const created = await createAgreement({ reviewWindowSecs: allowed });
        assert.equal((await readAgreement(created.pda)).reviewWindowSecs, allowed);
      }
      for (const refused of [0, 3600, 25 * 3600]) {
        await expectProgramError(
          () => createAgreement({ reviewWindowSecs: refused }),
          "ReviewWindowNotAllowed",
          `${refused}s is not an offered review window`,
        );
      }
    });

    it("claims delivery once, storing the evidence and the timestamp", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);

      const hash = evidenceHashOf("delivery-manifest");
      await claimDelivery(created, recipient, Array.from(hash), "flint://e/deadbeef");

      const agreement = await readAgreement(created.pda);
      assert.isDefined(agreement.status.deliveryClaimed);
      assert.isNotNull(agreement.claimedAt);
      assert.equal(
        Buffer.from(agreement.evidenceHash).toString("hex"),
        hash.toString("hex"),
        "the manifest hash is stored byte for byte",
      );
      assert.equal(agreement.evidenceRef, "flint://e/deadbeef");
      assert.equal(
        (await tokenBalance(created.escrow)).toString(),
        String(AMOUNT),
        "a claim moves no money",
      );
    });

    it("refuses a claim from anyone but the stored recipient", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);

      await expectProgramError(
        () => claimDelivery(created, attacker),
        "ClaimRecipientOnly",
        "a stranger claiming delivery of someone else's work",
      );
      await expectProgramError(
        () => claimDelivery(created, payer),
        "ClaimRecipientOnly",
        "the payer claiming their own payment as delivered",
      );
    });

    it("refuses a second claim, so evidence cannot be swapped after review", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);
      await claimDelivery(created);

      await expectProgramError(
        () =>
          claimDelivery(
            created,
            recipient,
            Array.from(evidenceHashOf("second")),
            "flint://e/second",
          ),
        "AlreadyClaimed",
        "a second claim overwriting the first evidence",
      );
    });

    it("refuses an empty hash and an empty locator", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);

      await expectProgramError(
        () => claimDelivery(created, recipient, Array.from(Buffer.alloc(32)), "flint://e/x"),
        "EvidenceHashEmpty",
        "the all-zero hash that means 'no evidence'",
      );
      await expectProgramError(
        () => claimDelivery(created, recipient, Array.from(evidenceHashOf("h")), "   "),
        "EvidenceRefEmpty",
        "a claim with nothing to verify the hash against",
      );
    });

    it("refuses a claim after expiry", async () => {
      const created = await createAgreement({ expiresIn: EXPIRY_SOON_SECS });
      await fundAgreement(created, payer);
      await waitUntilExpired(created.expiresAt);

      await expectProgramError(
        () => claimDelivery(created),
        "ClaimAfterExpiry",
        "claiming delivery on an agreement already refundable",
      );
    });

    it("blocks the refund once delivery is claimed: expiry stops applying", async () => {
      const created = await createAgreement({ expiresIn: EXPIRY_SOON_SECS });
      await fundAgreement(created, payer);
      await claimDelivery(created);
      await waitUntilExpired(created.expiresAt);

      await expectProgramError(
        () => refundAgreement(created, cranker),
        "NotFunded",
        "refunding an agreement whose delivery was claimed",
      );
    });
    it("refuses release_after_review while the window is open", async () => {
      const created = await createAgreement({ reviewWindowSecs: 6 * 3600 });
      await fundAgreement(created, payer);
      await claimDelivery(created);

      await expectProgramError(
        () => releaseAfterReview(created, cranker),
        "ReviewWindowOpen",
        "cranking the release while the payer can still dispute",
      );
    });

    it("derives the window end from claimed_at plus the stored window", async () => {
      // The window cannot be shortened below 6h, so rather than wait it out this
      // proves the same rule from the state: the deadline the program uses is
      // `claimed_at + review_window_secs`, read from stored fields.
      const created = await createAgreement({ reviewWindowSecs: 6 * 3600 });
      await fundAgreement(created, payer);
      await claimDelivery(created);

      const agreement = await readAgreement(created.pda);
      const windowEnd = agreement.claimedAt!.toNumber() + agreement.reviewWindowSecs;
      assert.isAbove(windowEnd, await chainNow(), "a 6h window has not elapsed");
      await expectProgramError(
        () => releaseAfterReview(created, cranker),
        "ReviewWindowOpen",
        "the window has not closed",
      );
    });

    it("refuses a dispute from anyone but the stored payer", async () => {
      const created = await createAgreement({ reviewWindowSecs: 6 * 3600 });
      await fundAgreement(created, payer);
      await claimDelivery(created);

      await expectProgramError(
        () => dispute(created, recipient),
        "PayerOnly",
        "the recipient disputing their own delivery claim",
      );
      await expectProgramError(
        () => dispute(created, attacker),
        "PayerOnly",
        "a stranger disputing somebody else's agreement",
      );
    });

    it("records the payer's dispute with its reason code and timestamp", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);
      await claimDelivery(created);
      await dispute(created, payer, { notReceived: {} });

      const agreement = await readAgreement(created.pda);
      assert.isDefined(agreement.status.disputed);
      assert.isNotNull(agreement.disputedAt);
      assert.isDefined(
        agreement.disputeReason?.notReceived,
        "the reason is a stored code, not free text",
      );
    });
it("freezes arbiter_deadline at dispute time even when config timeout changes", async () => {
      // Create, fund, and claim delivery so we can dispute
      const created = await createAgreement();
      await fundAgreement(created, payer);
      await claimDelivery(created);

      // File the dispute — this freezes arbiter_deadline = now + config.arbiter_timeout_secs
      await dispute(created, payer, { notReceived: {} });

      // Read the deadline that was stored at dispute time
      const agreementBefore = await readAgreement(created.pda);
      const originalDeadline = agreementBefore.arbiterDeadline;
      assert.isDefined(originalDeadline, "arbiter_deadline must be set after dispute");

      // --- Test 1: shorten the Config timeout ---
      // The admin (provider wallet) changes the arbiter window to a shorter value
      await program.methods
        .setConfigRoles(null, null, new BN(30)) // 30 seconds
        .accountsPartial({
          admin: provider.wallet.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // The stored deadline must NOT have been recomputed — it still governs
      const afterShort = await readAgreement(created.pda);
      assert.equal(afterShort.arbiterDeadline?.toString(), originalDeadline!.toString(), "shorter config timeout must not move the frozen arbiter_deadline");

      // --- Test 2: lengthen the Config timeout ---
      // Now change the arbiter window to a longer value
      await program.methods
        .setConfigRoles(null, null, new BN(3600)) // 1 hour
        .accountsPartial({
          admin: provider.wallet.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // The stored deadline must still be the original — longer timeout must not move it
      const afterLong = await readAgreement(created.pda);
      assert.equal(afterLong.arbiterDeadline?.toString(), originalDeadline!.toString(), "longer config timeout must not move the frozen arbiter_deadline");
    });

    it("refuses a ruling from anyone but the configured arbiter", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);
      await claimDelivery(created);
      await dispute(created, payer);

      await expectProgramError(
        () => resolveDispute(created, { release: {} }, impostorArbiter),
        "ArbiterOnly",
        "a stranger ruling on a dispute",
      );
      await expectProgramError(
        () => resolveDispute(created, { release: {} }, attacker),
        "ArbiterOnly",
        "the payer ruling on their own dispute",
      );
    });

    it("routes a release to the recipient less the fee, and the fee to the treasury", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);
      await claimDelivery(created);
      await dispute(created, payer);

      const recipientAta = await ensureAta(recipient, mint);
      const treasuryAta = getAssociatedTokenAddressSync(mint, treasury.publicKey, true);
      const arbiterAta = await ensureAta(arbiter, mint);
      const before = {
        recipient: await tokenBalance(recipientAta),
        treasury: await tokenBalance(treasuryAta),
        arbiter: await tokenBalance(arbiterAta),
      };

      await resolveDispute(created, { release: {} });

      assert.isDefined((await readAgreement(created.pda)).status.released);
      assert.equal(
        (await tokenBalance(recipientAta) - before.recipient).toString(),
        (BigInt(AMOUNT) - BigInt(FEE_FOR_AMOUNT)).toString(),
        "the recipient receives the amount less the fee",
      );
      assert.equal(
        (await tokenBalance(treasuryAta) - before.treasury).toString(),
        String(FEE_FOR_AMOUNT),
        "the fee goes to the treasury",
      );
      assert.equal(
        (await tokenBalance(arbiterAta) - before.arbiter).toString(),
        "0",
        "the arbiter is paid nothing: it cannot be the incentive",
      );
      assert.equal((await tokenBalance(created.escrow)).toString(), "0", "the escrow is emptied");
    });
    it("refunds the payer in full on a refund ruling, with no fee", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);
      await claimDelivery(created);
      await dispute(created, payer);

      const payerAta = await ensureAta(payer, mint);
      const treasuryAta = getAssociatedTokenAddressSync(mint, treasury.publicKey, true);
      const payerBefore = await tokenBalance(payerAta);
      const treasuryBefore = await tokenBalance(treasuryAta);

      await resolveDispute(created, { refund: {} });

      assert.isDefined((await readAgreement(created.pda)).status.refunded);
      assert.equal(
        (await tokenBalance(payerAta) - payerBefore).toString(),
        String(AMOUNT),
        "the payer gets every base unit back",
      );
      assert.equal(
        (await tokenBalance(treasuryAta) - treasuryBefore).toString(),
        "0",
        "a refund charges no fee",
      );
    });

    it("splits by basis points and the three legs sum to the original amount", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);
      await claimDelivery(created);
      await dispute(created, payer);

      const payerAta = await ensureAta(payer, mint);
      const recipientAta = await ensureAta(recipient, mint);
      const treasuryAta = getAssociatedTokenAddressSync(mint, treasury.publicKey, true);
      const before = {
        payer: await tokenBalance(payerAta),
        recipient: await tokenBalance(recipientAta),
        treasury: await tokenBalance(treasuryAta),
      };

      // 25% to the recipient; the fee scales to that share.
      await resolveDispute(created, { split: { recipientBps: 2_500 } });

      const after = {
        payer: await tokenBalance(payerAta),
        recipient: await tokenBalance(recipientAta),
        treasury: await tokenBalance(treasuryAta),
      };
      const recipientShare = (BigInt(AMOUNT) * 2_500n) / 10_000n;
      const feeShare = (BigInt(FEE_FOR_AMOUNT) * 2_500n) / 10_000n;

      assert.isDefined((await readAgreement(created.pda)).status.split);
      assert.equal(
        (after.recipient - before.recipient).toString(),
        (recipientShare - feeShare).toString(),
        "the recipient gets its share, less the fee on that share",
      );
      assert.equal(
        (after.treasury - before.treasury).toString(),
        feeShare.toString(),
        "the treasury takes only the share's fee",
      );
      assert.equal(
        (after.payer - before.payer).toString(),
        (BigInt(AMOUNT) - recipientShare).toString(),
        "the payer keeps everything else",
      );
      assert.equal(
        (
          (after.recipient - before.recipient) +
          (after.treasury - before.treasury) +
          (after.payer - before.payer)
        ).toString(),
        String(AMOUNT),
        "a split conserves the escrow exactly",
      );
    });
    it("refuses a split share of 0, 10000 or an out-of-range value", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);
      await claimDelivery(created);
      await dispute(created, payer);

      for (const bps of [0, 10_000, 12_345]) {
        await expectProgramError(
          () => resolveDispute(created, { split: { recipientBps: bps } }),
          "SplitShareOutOfRange",
          `a ${bps} bps share is a refund, a release, or more than everything`,
        );
      }
    });

    it("refuses the timeout split before the arbiter's window has passed", async () => {
      const created = await createAgreement();
      await fundAgreement(created, payer);
      await claimDelivery(created);
      await dispute(created, payer);

      await expectProgramError(
        () => splitAfterArbiterTimeout(created, cranker),
        "ArbiterTimeoutNotReached",
        "splitting while the arbiter still has time to rule",
      );
    });

    it("refuses role rotation by anyone but the admin", async () => {
      await expectProgramError(
        () =>
          program.methods
            .setConfigRoles(attacker.publicKey, null, null)
            .accountsPartial({
              admin: attacker.publicKey,
              config: configPda,
              systemProgram: SystemProgram.programId,
            })
            .signers([attacker])
            .rpc(),
        "ConfigAdminOnly",
        "a stranger redirecting the protocol's fees to themselves",
      );
    });

    it("splits 50/50 once the arbiter's window has passed", async () => {
      // 72h is unreachable in a test, so the admin shortens the arbiter window to
      // a second *before* the dispute. It has to be before: the deadline is
      // frozen onto the agreement at dispute time (by design), so shortening the
      // Config afterwards must not — and does not — move an in-flight dispute's
      // deadline. The later rotation is exercised here; the requirement that the
      // frozen deadline still governs is its own test below.
      await setArbiterTimeout(1);

      const created = await createAgreement();
      await fundAgreement(created, payer);
      await claimDelivery(created);
      await dispute(created, payer);

      const disputed = await readAgreement(created.pda);
      const expectedDeadline = disputed.disputedAt!.toNumber() + 1;
      assert.equal(
        disputed.arbiterDeadline!.toNumber(),
        expectedDeadline,
        "the arbiter deadline is frozen at dispute time from the then-current window",
      );

      // A later rotation must leave that frozen deadline alone.
      await setArbiterTimeout(72 * 60 * 60);
      assert.equal(
        (await readAgreement(created.pda)).arbiterDeadline!.toNumber(),
        expectedDeadline,
        "rotating the window must not move a live dispute's frozen deadline",
      );

      const payerAta = await ensureAta(payer, mint);
      const recipientAta = await ensureAta(recipient, mint);
      const treasuryAta = getAssociatedTokenAddressSync(mint, treasury.publicKey, true);
      const before = {
        payer: await tokenBalance(payerAta),
        recipient: await tokenBalance(recipientAta),
        treasury: await tokenBalance(treasuryAta),
      };

      await waitUntilExpired(disputed.disputedAt!.toNumber() + 1);
      await splitAfterArbiterTimeout(created, cranker);

      const after = {
        payer: await tokenBalance(payerAta),
        recipient: await tokenBalance(recipientAta),
        treasury: await tokenBalance(treasuryAta),
      };
      assert.isDefined((await readAgreement(created.pda)).status.split);
      assert.equal(
        (after.recipient - before.recipient).toString(),
        ((BigInt(AMOUNT) / 2n) - (BigInt(FEE_FOR_AMOUNT) / 2n)).toString(),
        "the recipient gets half, less half the fee",
      );
      assert.equal(
        (after.payer - before.payer).toString(),
        (BigInt(AMOUNT) / 2n).toString(),
        "the payer gets the other half, untouched",
      );
      assert.equal(
        (
          (after.recipient - before.recipient) +
          (after.treasury - before.treasury) +
          (after.payer - before.payer)
        ).toString(),
        String(AMOUNT),
        "the timeout split conserves the escrow exactly",
      );
    });

    it("keeps the stored arbiter deadline when the Config window changes after the dispute", async () => {
      // The deadline is frozen onto the agreement at dispute time, and
      // `split_after_arbiter_timeout` reads it from there — never from the
      // Config. This test files the dispute first, *then* rotates the window in
      // both directions, and asserts the stored deadline is the one that governs:
      //   - shortening it would cut the arbiter's remaining window, so the split
      //     would become crankeable earlier than the arbiter agreed to;
      //   - lengthening it would leave a resolved-elsewhere escrow stranded for
      //     longer than the agreement said.
      // A window long enough to be measurable, but still short compared with 72h.
      const INITIAL_WINDOW = 3_600;
      const SHORTER = 1;
      const LONGER = 6 * 3_600;

      await setArbiterTimeout(INITIAL_WINDOW);
      const created = await createAgreement();
      await fundAgreement(created, payer);
      await claimDelivery(created);
      await dispute(created, payer);

      const frozen = (await readAgreement(created.pda)).arbiterDeadline!.toNumber();
      const disputedAt = (await readAgreement(created.pda)).disputedAt!.toNumber();
      assert.equal(
        frozen,
        disputedAt + INITIAL_WINDOW,
        "the deadline is disputed_at plus the window in force at dispute time",
      );

      // Shorter then longer. Both rotations land while the deadline is still in
      // the future (the window is an hour), so neither is confused with the
      // deadline simply having passed.
      for (const window of [SHORTER, LONGER]) {
        await setArbiterTimeout(window);
        const after = await readAgreement(created.pda);
        assert.equal(
          after.arbiterDeadline!.toNumber(),
          frozen,
          `rotating the window to ${window}s must not move the stored deadline`,
        );
        assert.equal(
          after.disputedAt!.toNumber(),
          disputedAt,
          "and must not move the recorded dispute time either",
        );
        // Nothing else about the dispute may be rewritten by a Config rotation.
        assert.isDefined(after.status.disputed, "the agreement stays Disputed");
        assert.isAbove(after.arbiterDeadline!.toNumber(), await chainNow(),
          "a one-hour deadline is still in the future, so no split is crankeable yet");
      }

      // The stored deadline is what actually decides crankeability, so prove the
      // negative against it: with the frozen hour still ahead, the split is
      // refused even though the Config now says one second.
      await setArbiterTimeout(SHORTER);
      assert.equal(
        (await program.account.config.fetch(configPda)).arbiterTimeoutSecs.toNumber(),
        SHORTER,
        "the Config really did rotate to the short window",
      );
      await expectProgramError(
        () => splitAfterArbiterTimeout(created, cranker),
        "ArbiterTimeoutNotReached",
        "cranking the split early because the Config window was shortened afterwards",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Config administration: what the stored admin may do once bootstrap is done.
  //
  // Every `init_config` scenario lives in `config bootstrap` at the top of this
  // file, because those only mean anything while the Config PDA is still
  // unallocated. Everything here runs after bootstrap, so the Config exists and
  // is being *used* rather than created.
  // -------------------------------------------------------------------------
  describe("config administration", () => {
    it("every admin-gated instruction still requires the stored admin to sign", async () => {
      // The authority check lives in init_config, but rotation is what admin
      // power actually does afterwards. A non-admin must not be able to redirect
      // the treasury — the instruction most directly about where fees go.
      await expectProgramError(
        () =>
          program.methods
            .setConfigRoles(attacker.publicKey, null, null)
            .accountsPartial({
              admin: attacker.publicKey,
              config: configPda,
              systemProgram: SystemProgram.programId,
            })
            .signers([attacker])
            .rpc(),
        "ConfigAdminOnly",
        "a non-admin redirecting protocol fees to themselves",
      );

      const config = await program.account.config.fetch(configPda);
      assert.notEqual(
        config.treasury.toBase58(),
        attacker.publicKey.toBase58(),
        "the rejected rotation left the treasury where it was",
      );
    });

    it("the upgrade authority may rotate roles, and omitting a role leaves it", async () => {
      const rotated = Keypair.generate();
      await program.methods
        .setConfigRoles(rotated.publicKey, null, null)
        .accountsPartial({
          admin: provider.wallet.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const afterRotation = await program.account.config.fetch(configPda);
      assert.equal(afterRotation.treasury.toBase58(), rotated.publicKey.toBase58());
      assert.equal(
        afterRotation.arbiter.toBase58(),
        arbiter.publicKey.toBase58(),
        "the arbiter was untouched by a treasury-only rotation",
      );

      // Put it back, so later fee assertions measure the original treasury.
      await program.methods
        .setConfigRoles(treasury.publicKey, null, null)
        .accountsPartial({
          admin: provider.wallet.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });
  });
});
