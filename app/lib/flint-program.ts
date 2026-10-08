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
import { DEFAULT_REVIEW_WINDOW_SECS } from "./frs1-types";

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
 * Reads the treasury seat of the global Config PDA.
 *
 * Layout is the Borsh serialization of the Rust `Config` account:
 *   admin    Pubkey  (0..32)
 *   treasury Pubkey  (32..64)
 *   arbiter  Pubkey  (64..96)
 *   arbiter_timeout_secs u64 (96..104)
 *   min_agreement    u64 (104..112)
 *   bump             u8  (112..113)
 */
async function readConfigTreasury(
  connection: Connection,
  programId: PublicKey,
): Promise<PublicKey> {
  const [config] = configPda(programId);
  const info = await connection.getAccountInfo(config, "confirmed");
  if (info === null || info.data.length < 113) {
    throw new Error(
      `Flint config PDA ${config.toBase58()} is missing or malformed — is the program deployed and initialized?`,
    );
  }
  return new PublicKey(info.data.subarray(32, 64));
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
  // Config on-chain (row 5): it may not be created inline, so it is required
  // (and derived here when the caller did not supply it explicitly).
  let treasuryTokenAccount: PublicKey;
  if (accounts.treasuryTokenAccount !== undefined) {
    treasuryTokenAccount = accounts.treasuryTokenAccount;
  } else {
    const treasury = await readConfigTreasury(connection, programId);
    treasuryTokenAccount = getAssociatedTokenAddressSync(
      accounts.asset,
      treasury,
      true,
    );
  }

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
    new Transaction().add(instruction),
    payer,
  );
}

/** Accounts `claimDelivery` needs. */
export interface ClaimDeliveryAccounts {
  agreement: PublicKey;
  recipient: PublicKey;
  asset: PublicKey;
  /** The escrow token account (ATA for the agreement, or provided explicitly). */
  escrowTokenAccount?: PublicKey;
  recipientTokenAccount?: PublicKey;
  tokenProgram: PublicKey;
}

/** Build a `claimDelivery` transaction — recipient claims delivery with evidence. */
export async function buildClaimDeliveryTransaction(
  connection: Connection,
  programId: PublicKey,
  accounts: ClaimDeliveryAccounts,
  evidenceHash: number[],
  evidenceRef: string,
): Promise<Transaction> {
  const program = getProgram(connection, programId);
  const escrowTokenAccount = accounts.escrowTokenAccount ?? escrowAta(accounts.asset, accounts.agreement);
  const recipientTokenAccount = accounts.recipientTokenAccount ?? getAssociatedTokenAddressSync(accounts.asset, accounts.recipient, true);

  await requireExistingAta(connection, accounts.recipient, recipientTokenAccount, accounts.asset);

  const instruction = await program.methods
    .claimDelivery(new Uint8Array(evidenceHash), evidenceRef)
    .accountsPartial({
      agreement: accounts.agreement,
      recipient: accounts.recipient,
      escrowTokenAccount,
      recipientTokenAccount,
      tokenProgram: accounts.tokenProgram,
    })
    .instruction();

  return withBlockhash(connection, new Transaction().add(instruction), accounts.recipient);
}

/** Accounts `releaseAfterReview` needs. */
export interface ReleaseAfterReviewAccounts {
  agreement: PublicKey;
  cranker: PublicKey;
  asset: PublicKey;
  escrowTokenAccount?: PublicKey;
  payerTokenAccount?: PublicKey;
  tokenProgram: PublicKey;
}

/** Build a `releaseAfterReview` transaction — crank after the review window closes. */
export async function buildReleaseAfterReviewTransaction(
  connection: Connection,
  programId: PublicKey,
  accounts: ReleaseAfterReviewAccounts,
): Promise<Transaction> {
  const program = getProgram(connection, programId);
  const escrowTokenAccount = accounts.escrowTokenAccount ?? escrowAta(accounts.asset, accounts.agreement);
  const payerTokenAccount = accounts.payerTokenAccount ?? getAssociatedTokenAddressSync(accounts.asset, accounts.cranker, true);

  await requireExistingAta(connection, accounts.cranker, payerTokenAccount, accounts.asset);

  const instruction = await program.methods
    .releaseAfterReview()
    .accountsPartial({
      agreement: accounts.agreement,
      cranker: accounts.cranker,
      escrowTokenAccount,
      payerTokenAccount,
      tokenProgram: accounts.tokenProgram,
    })
    .instruction();

  return withBlockhash(connection, new Transaction().add(instruction), accounts.cranker);
}

/** Accounts `resolveDispute` needs. */
export interface ResolveDisputeAccounts {
  agreement: PublicKey;
  arbiter: PublicKey;
  outcome: { release: {} } | { refund: {} } | { split: { recipientBps: BN } };
  asset: PublicKey;
  escrowTokenAccount?: PublicKey;
  payerTokenAccount?: PublicKey;
  recipientTokenAccount?: PublicKey;
  tokenProgram: PublicKey;
}

/** Build a `resolveDispute` transaction — arbiter rules on a dispute. */
export async function buildResolveDisputeTransaction(
  connection: Connection,
  programId: PublicKey,
  accounts: ResolveDisputeAccounts,
): Promise<Transaction> {
  const program = getProgram(connection, programId);
  const escrowTokenAccount = accounts.escrowTokenAccount ?? escrowAta(accounts.asset, accounts.agreement);

  const instruction = await program.methods
    .resolveDispute(accounts.outcome as never)
    .accountsPartial({
      agreement: accounts.agreement,
      arbiter: accounts.arbiter,
      escrowTokenAccount,
      tokenProgram: accounts.tokenProgram,
    })
    .instruction();

  return withBlockhash(connection, new Transaction().add(instruction), accounts.arbiter);
}

/** Accounts `splitAfterArbiterTimeout` needs. */
export interface SplitAfterArbiterTimeoutAccounts {
  agreement: PublicKey;
  cranker: PublicKey;
  asset: PublicKey;
  escrowTokenAccount?: PublicKey;
  payerTokenAccount?: PublicKey;
  tokenProgram: PublicKey;
}

/** Build a `splitAfterArbiterTimeout` transaction — 50/50 split after arbiter window lapses. */
export async function buildSplitAfterArbiterTimeoutTransaction(
  connection: Connection,
  programId: PublicKey,
  accounts: SplitAfterArbiterTimeoutAccounts,
): Promise<Transaction> {
  const program = getProgram(connection, programId);
  const escrowTokenAccount = accounts.escrowTokenAccount ?? escrowAta(accounts.asset, accounts.agreement);
  const payerTokenAccount = accounts.payerTokenAccount ?? getAssociatedTokenAddressSync(accounts.asset, accounts.cranker, true);

  await requireExistingAta(connection, accounts.cranker, payerTokenAccount, accounts.asset);

  const instruction = await program.methods
    .splitAfterArbiterTimeout()
    .accountsPartial({
      agreement: accounts.agreement,
      cranker: accounts.cranker,
      escrowTokenAccount,
      payerTokenAccount,
      tokenProgram: accounts.tokenProgram,
    })
    .instruction();

  return withBlockhash(connection, new Transaction().add(instruction), accounts.cranker);
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

