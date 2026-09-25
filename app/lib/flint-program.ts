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
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import idl from "./idl/flint_escrow.json";

/** PDA seed for an agreement account: `[b"agreement", recipient, id]`. */
export const AGREEMENT_SEED = Buffer.from("agreement");

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
  /** Anchor enum: `{ pending: {} } | { funded: {} } | { released: {} } | ...`. */
  status: Record<string, Record<string, never>>;
  condition: {
    conditionType: Record<string, Record<string, never>>;
    description: string;
  };
  disputedFlag: boolean;
  disputedAt: BN | null;
  handle?: string;
  agentPolicy?: { spendCap: BN; allowlist: PublicKey[] } | null;
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

/** Terms for a proposed agreement, all in the Section 4.1 shape. */
export interface ProposeTerms {
  /** 16 raw bytes — the on-chain half of the uuid (Section 4.5). */
  id: Buffer;
  amount: string;
  asset: PublicKey;
  expiresAt: number;
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
      MANUAL_CONFIRMATION as never,
      "Deliver the requested resource",
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
  const program = getProgram(connection, programId, payer);
  return program.methods
    .release()
    .accountsPartial({
      payer: payer.publicKey,
      agreement,
      escrowTokenAccount,
      recipientTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([payer])
    .rpc();
}

