/**
 * The Flint escrow program client (Phase 2).
 *
 * This is the *only* module that knows how to talk to the program. Both flows —
 * the human one and the agent/x402 one — go through the same instructions on the
 * same program, which is what makes "one program, one state machine, same
 * guarantees" (Sections 1, 6.2) true in code rather than in prose.
 *
 * The IDL is copied from the build output by `npm run sync:idl`; it is generated,
 * never hand-edited, and the Rust source stays the source of truth.
 *
 * Deliberately *not* here: any policy about who may call what. Authority lives in
 * the program (Section 4.5). This module builds and submits transactions; every
 * account it touches is passed in by the caller, so a caller can neither hide an
 * account swap nor smuggle in a destination the agreement never named.
 */

import { BN, AnchorProvider, Program } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import idl from "./idl/flint_escrow.json";
import { DEFAULT_REVIEW_WINDOW_SECS, type DisputeReason } from "./frs1-types";

/** PDA seed for an agreement account: `[b"agreement", recipient, id]`. */
export const AGREEMENT_SEED = Buffer.from("agreement");

/** PDA seed for the protocol's global Config: `[b"config"]` (Section 4.1). */
export const CONFIG_SEED = Buffer.from("config");

/** The only condition type v1 enforces (Section 4.3), as Anchor encodes it. */
export const MANUAL_CONFIRMATION = { manualConfirmation: {} } as const;

/** The FRS-1 agreement account as the client decodes it (camelCase, Section 4.5). */
export interface RawAgreement {
  id: number[] | Buffer;
  payerAddress: PublicKey | null;
  recipientAddress: PublicKey;
  title: string;
  amount: BN;
  asset: PublicKey;
  escrowAddress: PublicKey;
  memo: string;
  expiresAt: BN;
  /** Anchor enum: `{ pending: {} } | { funded: {} } | { deliveryClaimed: {} } | ...`. */
  status: Record<string, Record<string, never>>;
  condition: {
    conditionType: Record<string, Record<string, never>>;
    description: string;
  };
  reviewWindowSecs: number;
  claimedAt: BN | null;
  evidenceHash: number[];
  evidenceRef: string;
  disputedAt: BN | null;
  arbiterDeadline: BN | null;
  disputeReason: Record<string, Record<string, never>> | null;
  feeAmount: BN;
  handle: string | null;
  agentPolicy: { spendCap: BN; allowlist: PublicKey[] } | null;
  /**
   * Always `null` on chain in v1 (Section 4.7): a program cannot read its own
   * transaction signature, so the receipt is captured and checked by the app.
   */
  receiptProof?: string | null;
}

/**
 * Wraps a raw keypair in the wallet interface Anchor's provider expects.
 *
 * `AnchorProvider` signs through a wallet object (`signTransaction`), not through a
 * bare `Keypair`. Flint's two roles are each exactly one devnet keypair on disk, so
 * rather than pull in a wallet library this adapts the keypair directly. The
 * adapter signs nothing extra: the only signature it produces is that keypair's.
 */
function anchorWallet(keypair: Keypair): {
  publicKey: PublicKey;
  signTransaction<T extends Transaction>(transaction: T): Promise<T>;
  signAllTransactions<T extends Transaction>(transactions: T[]): Promise<T[]>;
} {
  return {
    publicKey: keypair.publicKey,
    async signTransaction<T extends Transaction>(transaction: T): Promise<T> {
      transaction.partialSign(keypair);
      return transaction;
    },
    async signAllTransactions<T extends Transaction>(transactions: T[]): Promise<T[]> {
      for (const transaction of transactions) transaction.partialSign(keypair);
      return transactions;
    },
  };
}

/** Program client bound to a connection and, optionally, a fee-payer wallet. */
export function getProgram(
  connection: Connection,
  programId: PublicKey,
  payer?: Keypair,
): Program {
  return new Program(
    idl as never,
    new AnchorProvider(
      connection,
      (payer === undefined ? null : anchorWallet(payer)) as never,
      { commitment: "confirmed" },
    ),
  );
}

/** Canonical agreement PDA for `(recipient, id)`. */
export function agreementPda(
  recipient: PublicKey,
  id: Buffer | number[],
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [AGREEMENT_SEED, recipient.toBuffer(), Buffer.from(id)],
    programId,
  );
}

/** Canonical Config PDA — one per program, created once by `init_config`. */
export function configPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}

/**
 * The key `Config` has in Anchor's account coder.
 *
 * Same rule as `AGREEMENT_CODER_KEY` below: the coder is built from the IDL
 * *after* Anchor's camelCase conversion, so the account is keyed `config`, not
 * `Config`. The on-chain discriminator is still `sha256("account:Config")`.
 */
const CONFIG_CODER_KEY = "config";

/** The on-chain Config account, decoded through the program's own coder. */
export interface RawConfig {
  admin: PublicKey;
  treasury: PublicKey;
  arbiter: PublicKey;
  arbiterTimeoutSecs: BN;
  minAgreement: BN;
  bump: number;
}

/**
 * Reads and decodes the global Config PDA, or `null` when it does not exist.
 *
 * Decoded through the program's own Borsh coder rather than by hand-slicing raw
 * bytes. The manual approach is exactly where a silent bug lives: the account
 * begins with an 8-byte Anchor discriminator, so `treasury` sits at bytes
 * 40..72 — *after* `admin` (8..40) — not at 32..64. Reading 32..64 would return
 * the last 24 bytes of `admin` glued to the first 8 of `treasury`, and every
 * fee would be routed to a phantom wallet. The coder owns the layout, so a
 * field added to `Config` in `state.rs` is picked up here instead of quietly
 * shifting every offset after it.
 *
 * A missing Config is a fact (not an exception) so a caller can distinguish
 * "not initialised yet" from a genuine decode failure.
 */
export async function readConfig(
  connection: Connection,
  programId: PublicKey,
): Promise<RawConfig | null> {
  const [config] = configPda(programId);
  const info = await connection.getAccountInfo(config, "confirmed");
  if (info === null) return null;
  const program = getProgram(connection, programId);
  return program.coder.accounts.decode(
    CONFIG_CODER_KEY,
    Buffer.from(info.data),
  ) as RawConfig;
}

/**
 * Reads the treasury seat of the global Config PDA.
 *
 * Thin wrapper over {@link readConfig}: the release/fund builders only need the
 * treasury wallet, and derive its ATA from it. Kept as its own function so the
 * callers read plainly and the decode path stays in one place.
 */
async function readConfigTreasury(
  connection: Connection,
  programId: PublicKey,
): Promise<PublicKey> {
  const config = await readConfig(connection, programId);
  if (config === null) {
    const [pda] = configPda(programId);
    throw new Error(
      `Flint config PDA ${pda.toBase58()} is missing or malformed — is the program deployed and initialized?`,
    );
  }
  return config.treasury;
}


/**
 * The escrow token account: the agreement PDA's ATA for `asset`.
 *
 * Section 4.5: custody lives in this token account, owned (as an SPL account) by
 * the agreement PDA — not in the PDA's own lamport account.
 */
export function escrowAta(asset: PublicKey, agreement: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(asset, agreement, true);
}

/**
 * The key `FlintAgreement` has in Anchor's account coder.
 *
 * Anchor 1.x keys account layouts by the *camelCase* name — the same name
 * `program.account.flintAgreement` uses — not by the Rust/IDL name. On-chain the
 * account's discriminator is still `sha256("account:FlintAgreement")`, which is
 * what `verify.ts` checks; only this client-side lookup is camelCase.
 */
const AGREEMENT_CODER_KEY = "flintAgreement";

/**
 * Every agreement account owned by the program, with its address.
 *
 * Uses the Anchor account namespace (`program.account.flintAgreement.all()`)
 * so enumeration rides on the program's own coder — a hand-rolled
 * `getProgramAccounts` would re-implement the layout the coder already owns.
 * No memcmp filter: the cluster holds few enough agreements that fetching all
 * and filtering on status client-side is the honest read. A missing or
 * unreadable program throws; the caller decides the message.
 */
export interface ListedAgreement {
  address: PublicKey;
  account: RawAgreement;
}

export async function listAgreementAccounts(
  connection: Connection,
  programId: PublicKey,
): Promise<ListedAgreement[]> {
  const program = getProgram(connection, programId);
  const namespace = program.account as unknown as {
    flintAgreement: {
      all(): Promise<Array<{ publicKey: PublicKey; account: RawAgreement }>>;
    };
  };
  const found = await namespace.flintAgreement.all();
  return found.map((entry) => ({ address: entry.publicKey, account: entry.account }));
}

/**
 * Reads and decodes an agreement account, or `null` when it does not exist — which
 * is the normal state for a cancelled agreement, since `cancel` closes the account
 * (Section 4.6). A missing account is a fact, not an error.
 *
 * Decoded from the raw account bytes through the program's own coder, rather than
 * through the `program.account.*` namespace: the account is fetched first, so
 * "missing" is answered by the chain instead of by catching an exception and
 * guessing from its message.
 */
export async function readAgreement(
  connection: Connection,
  programId: PublicKey,
  agreement: PublicKey,
): Promise<RawAgreement | null> {
  const info = await connection.getAccountInfo(agreement);
  if (info === null) return null;
  const program = getProgram(connection, programId);
  return program.coder.accounts.decode(
    AGREEMENT_CODER_KEY,
    Buffer.from(info.data),
  ) as RawAgreement;
}

/** The condition description both flows attach to `manual-confirmation` (Section 4.3). */
export const DEFAULT_CONDITION_DESCRIPTION = "Deliver the requested resource";

/** Terms for a proposed agreement, all in the Section 4.1 shape. */
export interface ProposeTerms {
  /** 16 raw bytes — the on-chain half of the uuid (Section 4.5). */
  id: Buffer;
  amount: string;
  asset: PublicKey;
  expiresAt: number;
  /**
   * Review window in seconds; must be one of `ALLOWED_REVIEW_WINDOWS`
   * (6h/12h/24h/48h). Defaults to the protocol's 24h when omitted, so a
   * caller that has no opinion inherits the same default the UI shows.
   */
  reviewWindowSecs?: number;
  title: string;
  memo: string;
  handle?: string;
  /** Optional FRS-1 `agentPolicy`: stored, never enforced on chain (Section 4.3). */
  agentPolicy?: { spendCap: string; allowlist: string[] };
}

/**
 * `create` — the recipient proposes an agreement (Section 4.5).
 *
 * `recipient` is the only signer: on a pending agreement there is no payer, so
 * nobody else could legitimately authorise anything. The same function serves the
 * x402 responder (proposal triggered by an HTTP request) and the human flow
 * (proposal triggered by a person) — which is the point.
 */
export async function proposeAgreement(
  connection: Connection,
  programId: PublicKey,
  recipient: Keypair,
  terms: ProposeTerms,
): Promise<{ agreement: PublicKey; escrow: PublicKey; signature: string }> {
  const program = getProgram(connection, programId, recipient);
  const [agreement] = agreementPda(recipient.publicKey, terms.id, programId);
  const escrow = escrowAta(terms.asset, agreement);

  const signature = await program.methods
    .create(
      Array.from(terms.id),
      new BN(terms.amount),
      new BN(terms.expiresAt),
      terms.reviewWindowSecs ?? DEFAULT_REVIEW_WINDOW_SECS,
      MANUAL_CONFIRMATION as never,
      DEFAULT_CONDITION_DESCRIPTION,
      terms.title,
      terms.memo,
      terms.handle ?? null,
      terms.agentPolicy
        ? {
            spendCap: new BN(terms.agentPolicy.spendCap),
            allowlist: terms.agentPolicy.allowlist.map((a) => new PublicKey(a)),
          }
        : null,
    )
    .accountsPartial({
      recipient: recipient.publicKey,
      agreement,
      config: configPda(programId)[0],
      asset: terms.asset,
      escrowAta: escrow,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([recipient])
    .rpc();

  return { agreement, escrow, signature };
}

/** `fund` — the funder becomes `payerAddress`, permanently and atomically. */
export async function fundAgreement(
  connection: Connection,
  programId: PublicKey,
  funder: Keypair,
  agreement: PublicKey,
  funderTokenAccount: PublicKey,
  escrowTokenAccount: PublicKey,
): Promise<string> {
  const program = getProgram(connection, programId, funder);
  return program.methods
    .fund()
    .accountsPartial({
      funder: funder.publicKey,
      agreement,
      funderTokenAccount,
      escrowTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([funder])
    .rpc();
}

/**
 * `release` — the stored payer confirms; the escrow pays the stored recipient.
 *
 * The destination is supplied by the caller, and the program checks it against the
 * *stored* `recipient_address` (row 2), so passing the wrong one fails rather than
 * paying a stranger.
 */
export async function releaseToRecipient(
  connection: Connection,
  programId: PublicKey,
  payer: Keypair,
  agreement: PublicKey,
  escrowTokenAccount: PublicKey,
  recipientTokenAccount: PublicKey,
): Promise<string> {
  const terms = await readAgreement(connection, programId, agreement);
  if (terms === null) {
    throw new Error(
      `Release failed: agreement ${agreement.toBase58()} was not found on chain.`,
    );
  }

  const program = getProgram(connection, programId, payer);
  const treasury = await readConfigTreasury(connection, programId);
  const treasuryTokenAccount = getAssociatedTokenAddressSync(
    terms.asset,
    treasury,
    true,
  );

  return program.methods
    .release()
    .accountsPartial({
      payer: payer.publicKey,
      config: configPda(programId)[0],
      agreement,
      escrowTokenAccount,
      recipientTokenAccount,
      treasuryTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([payer])
    .rpc();
}

// ---------------------------------------------------------------------------
// Phase 3: unsigned transactions for the wallet-adapter path.
//
// The keypair helpers above sign server-side and are what the agent flow and
// the tests use. The human flow cannot work that way: in a browser the only
// signer is the connected wallet, so the transaction must be *built* here and
// *signed* there. These builders therefore take public keys, never keypairs,
// and return an unsigned `Transaction` with a fresh blockhash and the correct
// fee payer already set.
//
// One set of builders serves three call sites — the pay page (fund / release /
// refund), the Blink's Action POST endpoint (fund), and the devnet tests — so
// the code path a human's wallet signs is the exact code path under test.
// ---------------------------------------------------------------------------

/** Sets a fresh blockhash and the fee payer on a transaction being built. */
async function withBlockhash(
  connection: Connection,
  transaction: Transaction,
  feePayer: PublicKey,
): Promise<Transaction> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = feePayer;
  return transaction;
}

/**
 * The Associated Token Program's `CreateIdempotent` instruction, built for a
 * wallet to sign.
 *
 * Deliberately not `spl-token`'s `createAssociatedTokenAccountIdempotent`: that
 * helper takes a `Signer` and *submits the transaction itself*, which is the
 * server-side path (`fundAgreement` and friends). Here the connected wallet must
 * be the signer, so the instruction is assembled explicitly. Discriminator `1` is
 * `CreateIdempotent`, so this is a no-op when the account already exists — a
 * Blink has to work for a wallet that has never held the asset.
 *
 * `owner` must be the wallet that actually **owns** the ATA being created, not
 * merely the fee payer: the Associated Token Program derives the address from
 * its first account and requires that account to be a signer, so passing a
 * different wallet would ask the program to create the payer's ATA at the
 * recipient's address. Where the two differ, the owner also has to sign the
 * enclosing transaction — see `requiredExtraSigners` in the release/refund
 * builders.
 */
function ensureAtaInstruction(
  owner: PublicKey,
  associatedToken: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    owner,
    associatedToken,
    owner,
    mint,
  );
}

/**
 * A destination token account that does not exist yet.
 *
 * Distinct from a generic build failure on purpose: the fix is known and belongs
 * to a specific wallet (the recipient on `release`, the stored payer on
 * `refund`), so the UI can say who has to do what. Section 9 asks for distinct,
 * expected error states, and "the escrow is fine, but the person being paid has
 * never held this asset" is exactly that.
 */
export class MissingDestinationAtaError extends Error {
  constructor(
    readonly owner: PublicKey,
    readonly associatedToken: PublicKey,
    readonly asset: PublicKey,
  ) {
    super(
      `${owner.toBase58()} has no token account for ${asset.toBase58()} yet ` +
        `(${associatedToken.toBase58()} does not exist). It has to be created ` +
        `before the payment can land.`,
    );
    this.name = "MissingDestinationAtaError";
  }
}

/**
 * Asserts a payout destination already exists.
 *
 * The alternative — appending a `CreateIdempotent` for someone else's ATA — is
 * not available on these instructions, because the Associated Token Program
 * requires the ATA's owner to sign. `release` is signed by the payer and
 * `refund` by a permissionless cranker, neither of whom is the owner of the
 * account the money is going to. Asking for that second signature would break
 * the Blink flow and, for `refund`, would make the permissionless crank depend
 * on the payer's cooperation — exactly the liveness property Section 4.2 wants
 * to keep. So the check is explicit and the failure is specific.
 */
async function requireExistingAta(
  connection: Connection,
  owner: PublicKey,
  associatedToken: PublicKey,
  asset: PublicKey,
): Promise<void> {
  const info = await connection.getAccountInfo(associatedToken, "confirmed");
  if (!info) {
    throw new MissingDestinationAtaError(owner, associatedToken, asset);
  }
}

/**
 * `create`, built for a wallet to sign. The recipient is the fee payer and the
 * only required signature (Section 4.5) — identical instruction data and
 * accounts to `proposeAgreement`, so the human flow and the x402 responder
 * propose agreements the same way.
 */
export async function buildCreateTransaction(
  connection: Connection,
  programId: PublicKey,
  recipient: PublicKey,
  terms: ProposeTerms,
): Promise<Transaction> {
  const program = getProgram(connection, programId);
  const [agreement] = agreementPda(recipient, terms.id, programId);
  const escrow = escrowAta(terms.asset, agreement);

  const instruction = await program.methods
    .create(
      Array.from(terms.id),
      new BN(terms.amount),
      new BN(terms.expiresAt),
      terms.reviewWindowSecs ?? DEFAULT_REVIEW_WINDOW_SECS,
      MANUAL_CONFIRMATION as never,
      DEFAULT_CONDITION_DESCRIPTION,
      terms.title,
      terms.memo,
      terms.handle ?? null,
      terms.agentPolicy
        ? {
            spendCap: new BN(terms.agentPolicy.spendCap),
            allowlist: terms.agentPolicy.allowlist.map((a) => new PublicKey(a)),
          }
        : null,
    )
    .accountsPartial({
      recipient,
      agreement,
      config: configPda(programId)[0],
      asset: terms.asset,
      escrowAta: escrow,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return withBlockhash(connection, new Transaction().add(instruction), recipient);
}

/** Accounts `fund` needs, all derivable so a caller can supply overrides. */
export interface FundAccounts {
  agreement: PublicKey;
  /** The agreement's `asset`; the funder's source account is derived for it. */
  asset: PublicKey;
  /** Defaults to the funder's ATA for `asset`. */
  funderTokenAccount?: PublicKey;
  /** Defaults to the agreement's stored escrow ATA. */
  escrowTokenAccount?: PublicKey;
}

/**
 * `fund`, built for a wallet to sign — the transaction behind the Blink.
 *
 * Whoever signs becomes `payerAddress` (Section 4.2, first-funder-wins), and the
 * full stored amount moves at once. The amount is never an argument here: the
 * program reads it off the agreement, so a Blink can only ever fund the figure
 * the recipient proposed.
 *
 * The funder's token account is created idempotently if absent. A Blink must work
 * for a wallet that has never held this asset, and `createAssociatedTokenAccount
 * Idempotent` is a no-op when the account already exists, so the common case costs
 * nothing extra.
 */
export async function buildFundTransaction(
  connection: Connection,
  programId: PublicKey,
  funder: PublicKey,
  accounts: FundAccounts,
): Promise<Transaction> {
  const program = getProgram(connection, programId);
  const funderTokenAccount =
    accounts.funderTokenAccount ?? getAssociatedTokenAddressSync(accounts.asset, funder, true);
  const escrowTokenAccount =
    accounts.escrowTokenAccount ?? escrowAta(accounts.asset, accounts.agreement);

  const instructions = [
    ensureAtaInstruction(funder, funderTokenAccount, accounts.asset),
    await program.methods
      .fund()
      .accountsPartial({
        funder,
        agreement: accounts.agreement,
        funderTokenAccount,
        escrowTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  ];

  return withBlockhash(
    connection,
    new Transaction().add(...instructions),
    funder,
  );
}

/** Accounts `release` needs. The destination is checked against stored state. */
export interface ReleaseAccounts {
  /// The agreement being released.
  agreement: PublicKey;
  /// The asset being released.
  asset: PublicKey;
  /** Defaults to the stored recipient's ATA. Never taken from the client. */
  recipientTokenAccount?: PublicKey;
  /** The recipient of the asset. */
  recipient: PublicKey;
  /** The escrow token account (default: the agreement's ATA for `asset`). */
  escrowTokenAccount?: PublicKey;
  /** The global Config PDA, one per program (Section 4.1). Defaults to `configPda(programId)[0]`. */
  config?: PublicKey;
  /** The treasury's token account for `asset`, validated against `config`.
   *  Defaults to the ATA of `config.treasury` for `asset`. */
  treasuryTokenAccount?: PublicKey;
}

/**
 * Derives the Config treasury's ATA for `asset` and the idempotent create
 * instruction that brings it into existence if absent.
 *
 * Shared by every settlement builder (release, release-after-review,
 * resolve-dispute, split-after-arbiter-timeout) so a settlement can never fail
 * merely because the treasury has not yet received this asset. The Associated
 * Token Program's `CreateIdempotent` requires only the *funding* account to
 * sign — the owner (the treasury) does not — so the transaction's fee payer can
 * pay the rent. It is a no-op when the account already exists.
 */
async function treasuryAtaForSettlement(
  connection: Connection,
  programId: PublicKey,
  feePayer: PublicKey,
  asset: PublicKey,
  override?: PublicKey,
): Promise<{ treasuryTokenAccount: PublicKey; ensureInstruction: TransactionInstruction }> {
  const treasury = await readConfigTreasury(connection, programId);
  const treasuryTokenAccount =
    override ?? getAssociatedTokenAddressSync(asset, treasury, true);
  const ensureInstruction = createAssociatedTokenAccountIdempotentInstruction(
    feePayer,
    treasuryTokenAccount,
    treasury,
    asset,
  );
  return { treasuryTokenAccount, ensureInstruction };
}

/** `release`, built for the stored payer to sign. */
export async function buildReleaseTransaction(
  connection: Connection,
  programId: PublicKey,
  payer: PublicKey,
  accounts: ReleaseAccounts,
): Promise<Transaction> {
  const program = getProgram(connection, programId);
  const config = accounts.config ?? configPda(programId)[0];

  // The treasury ATA is the *treasury's* and is validated against the stored
  // Config on-chain (row 5). It is derived from the Config's treasury wallet,
  // never from an argument, and created idempotently by the payer when absent so
  // a release never fails on a missing treasury account.
  const { treasuryTokenAccount, ensureInstruction: ensureTreasuryAta } =
    await treasuryAtaForSettlement(
      connection,
      programId,
      payer,
      accounts.asset,
      accounts.treasuryTokenAccount,
    );

  const escrowTokenAccount =
    accounts.escrowTokenAccount ?? escrowAta(accounts.asset, accounts.agreement);
  const recipientTokenAccount =
    accounts.recipientTokenAccount ??
    getAssociatedTokenAddressSync(accounts.asset, accounts.recipient, true);

  // The destination ATA is the *recipient's*, and the recipient is not a signer
  // here — so it cannot be created idempotently inline. Requiring a second
  // signature would make release unusable in a Blink, so the account is checked
  // instead and its absence is reported as the specific, actionable error it is:
  // "the recipient has to receive the asset once before they can be paid".
  await requireExistingAta(
    connection,
    accounts.recipient,
    recipientTokenAccount,
    accounts.asset,
  );

  const instruction = await program.methods
    .release()
    .accountsPartial({
      payer,
      config,
      agreement: accounts.agreement,
      escrowTokenAccount,
      recipientTokenAccount,
      treasuryTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return withBlockhash(
    connection,
    new Transaction().add(ensureTreasuryAta, instruction),
    payer,
  );
}

/** Accounts `claimDelivery` needs. */
export interface ClaimDeliveryAccounts {
  agreement: PublicKey;
  recipient: PublicKey;
}

/**
 * Build a `claimDelivery` transaction — the recipient claims delivery with
 * evidence.
 *
 * The instruction struct (claim_delivery.rs) has exactly two accounts —
 * `recipient` (signer) and `agreement` — and moves no money, so no token
 * accounts are passed. `evidenceHash` is the 32-byte SHA-256 of the canonical
 * manifest and `evidenceRef` is the `flint://e/<id>` locator; both are committed
 * on chain and checked non-empty / non-zero by the program.
 */
export async function buildClaimDeliveryTransaction(
  connection: Connection,
  programId: PublicKey,
  accounts: ClaimDeliveryAccounts,
  evidenceHash: number[],
  evidenceRef: string,
): Promise<Transaction> {
  const program = getProgram(connection, programId);

  const instruction = await program.methods
    .claimDelivery(new Uint8Array(evidenceHash), evidenceRef)
    .accountsPartial({
      recipient: accounts.recipient,
      agreement: accounts.agreement,
    })
    .instruction();

  return withBlockhash(connection, new Transaction().add(instruction), accounts.recipient);
}

/** Accounts `releaseAfterReview` needs. */
export interface ReleaseAfterReviewAccounts {
  agreement: PublicKey;
  cranker: PublicKey;
  asset: PublicKey;
  /** The stored recipient, whose ATA receives the payout. */
  recipient: PublicKey;
  config?: PublicKey;
  escrowTokenAccount?: PublicKey;
  recipientTokenAccount?: PublicKey;
  treasuryTokenAccount?: PublicKey;
}

/**
 * Build a `releaseAfterReview` transaction — permissionless crank once the
 * review window closes (`DeliveryClaimed` → `Released`).
 *
 * Account list matches release_after_review.rs / the IDL: cranker (signer),
 * config, agreement, escrow, recipient and treasury token accounts, token
 * program. The cranker only pays the fee; the payout always goes to the stored
 * recipient. The treasury ATA is created idempotently by the cranker when
 * absent; the recipient ATA must already exist (the recipient is not a signer),
 * and its absence is reported as the actionable `MissingDestinationAtaError`.
 */
export async function buildReleaseAfterReviewTransaction(
  connection: Connection,
  programId: PublicKey,
  accounts: ReleaseAfterReviewAccounts,
): Promise<Transaction> {
  const program = getProgram(connection, programId);
  const config = accounts.config ?? configPda(programId)[0];
  const escrowTokenAccount =
    accounts.escrowTokenAccount ?? escrowAta(accounts.asset, accounts.agreement);
  const recipientTokenAccount =
    accounts.recipientTokenAccount ??
    getAssociatedTokenAddressSync(accounts.asset, accounts.recipient, true);

  const { treasuryTokenAccount, ensureInstruction: ensureTreasuryAta } =
    await treasuryAtaForSettlement(
      connection,
      programId,
      accounts.cranker,
      accounts.asset,
      accounts.treasuryTokenAccount,
    );

  await requireExistingAta(
    connection,
    accounts.recipient,
    recipientTokenAccount,
    accounts.asset,
  );

  const instruction = await program.methods
    .releaseAfterReview()
    .accountsPartial({
      cranker: accounts.cranker,
      config,
      agreement: accounts.agreement,
      escrowTokenAccount,
      recipientTokenAccount,
      treasuryTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return withBlockhash(
    connection,
    new Transaction().add(ensureTreasuryAta, instruction),
    accounts.cranker,
  );
}

/** Accounts `resolveDispute` needs. */
export interface ResolveDisputeAccounts {
  agreement: PublicKey;
  arbiter: PublicKey;
  outcome: { release: {} } | { refund: {} } | { split: { recipientBps: BN } };
  asset: PublicKey;
  /** The stored payer, whose ATA receives a refund / split share. */
  payer: PublicKey;
  /** The stored recipient, whose ATA receives a release / split share. */
  recipient: PublicKey;
  config?: PublicKey;
  escrowTokenAccount?: PublicKey;
  payerTokenAccount?: PublicKey;
  recipientTokenAccount?: PublicKey;
  treasuryTokenAccount?: PublicKey;
}

/**
 * Build a `resolveDispute` transaction — the arbiter rules on a dispute.
 *
 * Account list matches resolve_dispute.rs / the IDL: arbiter (signer), config,
 * agreement, escrow, payer / recipient / treasury token accounts, token
 * program. The destination is always one of the three stored addresses — the
 * payer, the recipient, or the Config's treasury — never the arbiter's, so the
 * arbiter signs the transaction but cannot route funds to itself. The payer and
 * recipient ATAs must already exist (neither is a signer here); the treasury
 * ATA is created idempotently by the arbiter.
 */
export async function buildResolveDisputeTransaction(
  connection: Connection,
  programId: PublicKey,
  accounts: ResolveDisputeAccounts,
): Promise<Transaction> {
  const program = getProgram(connection, programId);
  const config = accounts.config ?? configPda(programId)[0];
  const escrowTokenAccount =
    accounts.escrowTokenAccount ?? escrowAta(accounts.asset, accounts.agreement);
  const payerTokenAccount =
    accounts.payerTokenAccount ??
    getAssociatedTokenAddressSync(accounts.asset, accounts.payer, true);
  const recipientTokenAccount =
    accounts.recipientTokenAccount ??
    getAssociatedTokenAddressSync(accounts.asset, accounts.recipient, true);

  const { treasuryTokenAccount, ensureInstruction: ensureTreasuryAta } =
    await treasuryAtaForSettlement(
      connection,
      programId,
      accounts.arbiter,
      accounts.asset,
      accounts.treasuryTokenAccount,
    );

  await requireExistingAta(connection, accounts.payer, payerTokenAccount, accounts.asset);
  await requireExistingAta(
    connection,
    accounts.recipient,
    recipientTokenAccount,
    accounts.asset,
  );

  const instruction = await program.methods
    .resolveDispute(accounts.outcome as never)
    .accountsPartial({
      arbiter: accounts.arbiter,
      config,
      agreement: accounts.agreement,
      escrowTokenAccount,
      payerTokenAccount,
      recipientTokenAccount,
      treasuryTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return withBlockhash(
    connection,
    new Transaction().add(ensureTreasuryAta, instruction),
    accounts.arbiter,
  );
}

/** Accounts `splitAfterArbiterTimeout` needs. */
export interface SplitAfterArbiterTimeoutAccounts {
  agreement: PublicKey;
  cranker: PublicKey;
  asset: PublicKey;
  /** The stored payer, whose ATA receives the payer's half of the split. */
  payer: PublicKey;
  /** The stored recipient, whose ATA receives the recipient's half of the split. */
  recipient: PublicKey;
  config?: PublicKey;
  escrowTokenAccount?: PublicKey;
  payerTokenAccount?: PublicKey;
  recipientTokenAccount?: PublicKey;
  treasuryTokenAccount?: PublicKey;
}

/**
 * Build a `splitAfterArbiterTimeout` transaction — permissionless fixed 50/50
 * split once the arbiter's window has lapsed (`Disputed` → `Split`).
 *
 * Account list matches split_after_arbiter_timeout.rs / the IDL: cranker
 * (signer), config, agreement, escrow, payer / recipient / treasury token
 * accounts, token program. The split is fixed at 5000 bps — the cranker cannot
 * choose it — and funds only ever reach the stored payer, the stored recipient,
 * or the Config's treasury. The payer and recipient ATAs must already exist;
 * the treasury ATA is created idempotently by the cranker.
 */
export async function buildSplitAfterArbiterTimeoutTransaction(
  connection: Connection,
  programId: PublicKey,
  accounts: SplitAfterArbiterTimeoutAccounts,
): Promise<Transaction> {
  const program = getProgram(connection, programId);
  const config = accounts.config ?? configPda(programId)[0];
  const escrowTokenAccount =
    accounts.escrowTokenAccount ?? escrowAta(accounts.asset, accounts.agreement);
  const payerTokenAccount =
    accounts.payerTokenAccount ??
    getAssociatedTokenAddressSync(accounts.asset, accounts.payer, true);
  const recipientTokenAccount =
    accounts.recipientTokenAccount ??
    getAssociatedTokenAddressSync(accounts.asset, accounts.recipient, true);

  const { treasuryTokenAccount, ensureInstruction: ensureTreasuryAta } =
    await treasuryAtaForSettlement(
      connection,
      programId,
      accounts.cranker,
      accounts.asset,
      accounts.treasuryTokenAccount,
    );

  await requireExistingAta(connection, accounts.payer, payerTokenAccount, accounts.asset);
  await requireExistingAta(
    connection,
    accounts.recipient,
    recipientTokenAccount,
    accounts.asset,
  );

  const instruction = await program.methods
    .splitAfterArbiterTimeout()
    .accountsPartial({
      cranker: accounts.cranker,
      config,
      agreement: accounts.agreement,
      escrowTokenAccount,
      payerTokenAccount,
      recipientTokenAccount,
      treasuryTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return withBlockhash(
    connection,
    new Transaction().add(ensureTreasuryAta, instruction),
    accounts.cranker,
  );
}

/** Accounts `dispute` needs. */
export interface DisputeAccounts {
  agreement: PublicKey;
  /** The stored payer, the only signer `dispute` accepts. */
  payer: PublicKey;
  config?: PublicKey;
}

/**
 * Build a `dispute` transaction — the payer rejects a delivery claim inside the
 * review window (`DeliveryClaimed` → `Disputed`). Moves no money.
 *
 * Account list matches dispute.rs / the IDL: payer (signer), agreement, config.
 * `config` is read at dispute time so the arbiter's deadline
 * (`disputed_at + config.arbiter_timeout_secs`) is frozen onto the agreement,
 * and `split_after_arbiter_timeout` later reads that frozen value rather than a
 * live window an admin could move.
 *
 * `reason` is an FRS-1 `DisputeReason`; its variant name is exactly the
 * Anchor enum variant (see `DISPUTE_REASON_CODES`), so the on-chain
 * discriminant is the variant object `{ [reason]: {} }`.
 */
export async function buildDisputeTransaction(
  connection: Connection,
  programId: PublicKey,
  accounts: DisputeAccounts,
  reason: DisputeReason,
): Promise<Transaction> {
  const program = getProgram(connection, programId);
  const config = accounts.config ?? configPda(programId)[0];

  const instruction = await program.methods
    .dispute({ [reason]: {} } as never)
    .accountsPartial({
      payer: accounts.payer,
      agreement: accounts.agreement,
      config,
    })
    .instruction();

  return withBlockhash(
    connection,
    new Transaction().add(instruction),
    accounts.payer,
  );
}

/** Accounts `refund` needs. The destination is always the *stored* payer. */
export interface RefundAccounts {
  agreement: PublicKey;
  asset: PublicKey;
  /** The stored payer, read from the account — never from the caller. */
  payer: PublicKey;
  payerTokenAccount?: PublicKey;
  escrowTokenAccount?: PublicKey;
}

/**
 * `refund`, built for anyone to sign. The cranker's identity is irrelevant to
 * where the money goes: the program pays the stored `payerAddress` (Section 4.2),
 * so a stranger can unstick an expired agreement but cannot profit from it.
 */
export async function buildRefundTransaction(
  connection: Connection,
  programId: PublicKey,
  cranker: PublicKey,
  accounts: RefundAccounts,
): Promise<Transaction> {
  const program = getProgram(connection, programId);
  const escrowTokenAccount =
    accounts.escrowTokenAccount ?? escrowAta(accounts.asset, accounts.agreement);
  const payerTokenAccount =
    accounts.payerTokenAccount ??
    getAssociatedTokenAddressSync(accounts.asset, accounts.payer, true);

  // Same reasoning as `release`: the refund destination belongs to the stored
  // payer, who is not a signer of this transaction, so the ATA cannot be created
  // inline without a second signature. The cranker's own ATA is irrelevant — they
  // are only paying the fee.
  await requireExistingAta(
    connection,
    accounts.payer,
    payerTokenAccount,
    accounts.asset,
  );

  const instruction = await program.methods
    .refund()
    .accountsPartial({
      cranker,
      agreement: accounts.agreement,
      escrowTokenAccount,
      payerTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  return withBlockhash(
    connection,
    new Transaction().add(instruction),
    cranker,
  );
}

/**
 * Serializes a built transaction the way the Actions spec's POST response
 * requires: base64, with signature verification off and `requireAllSignatures`
 * false, because the only signer is the client and the server has none.
 *
 * A client that receives a half-signed transaction is expected to add its own
 * signature and resubmit — that is the entire point of the Actions flow, so the
 * default `serialize()` behaviour of throwing on a missing signature is wrong
 * here.
 */
export function serializeForClient(transaction: Transaction): string {
  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

