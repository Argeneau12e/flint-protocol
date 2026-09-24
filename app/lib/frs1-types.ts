/**
 * FRS-1 canonical TypeScript types.
 *
 * Source of truth: FLINT_BUILD_CONTEXT.md Section 4.1 (schema), 4.2 (status
 * state machine), 4.3 (condition), 4.5 (encoding rules). The Rust mirror lives
 * in `programs/flint-escrow/src/state.rs`; the two must stay in lockstep.
 *
 * Rust <-> TS mapping rules (Section 4.5):
 *   - field names : snake_case on-chain  ->  camelCase at the boundary
 *   - `u64`       : decimal string of base units, NEVER a JS number
 *                   (JS loses precision above 2^53)
 *   - `Pubkey`    : base58 string
 *   - `Option<T>` : `T | null`
 *   - Rust identifier difference: the on-chain struct calls the condition's
 *     type field `condition_type` only because `type` is a Rust keyword;
 *     FRS-1 calls that field `type`, and so does this file.
 *
 * PHASE 0 SCOPE: types, protocol constants and schema metadata only. No custody
 * or state-machine logic lives here.
 */

/** FRS-1 `id` — uuid-v4, formatted. On-chain it is the 16 raw bytes. */
export type Uuid4 = string;

/** A base58 wallet address. */
export type WalletAddress = string;

/** A base58 SPL token mint address. */
export type MintAddress = string;

/** A base58 SPL token account (ATA) address. */
export type TokenAccountAddress = string;

/** A base58 transaction signature. */
export type TransactionSignature = string;

/** `u64` base units as a decimal string — never a JS number (Section 4.5). */
export type BaseUnits = string;

/** Unix seconds, read from the on-chain Clock sysvar. */
export type UnixTimestamp = number;

/**
 * FRS-1 `status` (Section 4.2).
 *
 * `released` and `refunded` are terminal; nothing transitions out of them.
 */
export type AgreementStatus =
  | "pending"
  | "funded"
  | "released"
  | "refunded"
  | "cancelled";

/** All five states, in lifecycle order. Handy for exhaustive UI rendering. */
export const FRS1_STATUSES: readonly AgreementStatus[] = [
  "pending",
  "funded",
  "released",
  "refunded",
  "cancelled",
];

/**
 * States with no outgoing transition (Section 4.2).
 *
 * Note: these lists are deliberately annotated `readonly AgreementStatus[]`
 * rather than left as literal tuples, so that `includes(status)` type-checks for
 * a full `AgreementStatus` value. The annotation still validates every member at
 * compile time.
 */
export const FRS1_TERMINAL_STATUSES: readonly AgreementStatus[] = [
  "released",
  "refunded",
];

/**
 * FRS-1 `condition.type` values (Section 4.3).
 *
 * `oracle-attested` is a named schema value and is deliberately NOT implemented
 * in v1 — no on-chain transition may ever depend on it.
 */
export type ConditionType = "manual-confirmation" | "oracle-attested";

/** The condition types v1 actually enforces on-chain: exactly one. */
export const FRS1_ENFORCED_CONDITION_TYPES: readonly ConditionType[] = [
  "manual-confirmation",
];

/** FRS-1 `condition`. `description` is display text, nothing more. */
export interface Frs1Condition {
  type: ConditionType;
  description: string;
}

/**
 * FRS-1 `agentPolicy` — optional, for autonomous payers.
 *
 * Evaluated off-chain by the deterministic policy engine (Section 6.2); the
 * program stores it but does not enforce it. No LLM in the pay/no-pay path.
 */
export interface Frs1AgentPolicy {
  /** Spend cap in `asset` base units, as a decimal string. */
  spendCap: BaseUnits;
  /** Permitted recipient addresses. */
  allowlist: WalletAddress[];
}

/** The FRS-1 payment agreement object (Section 4.1, field-for-field). */
export interface Frs1Agreement {
  /** uuid-v4. */
  id: Uuid4;

  /**
   * The funding wallet. `null` until funded: the agreement is proposed by the
   * recipient, and whichever address funds it first becomes the payer
   * permanently (Section 4.2).
   */
  payerAddress: WalletAddress | null;

  /** Set at creation; immutable once funded. */
  recipientAddress: WalletAddress;

  /** Display only. */
  title: string;

  /** Fixed at creation, immutable once funded. Base units, as a string. */
  amount: BaseUnits;

  /** SPL token mint (Section 4.5). Symbols like "USDC" are display-only. */
  asset: MintAddress;

  /** The escrow's token account (ATA) — not the agreement PDA (Section 4.5). */
  escrowAddress: TokenAccountAddress;

  /** Display only. */
  memo: string;

  /** Compared against the Clock sysvar only (Section 4.5). */
  expiresAt: UnixTimestamp;

  status: AgreementStatus;

  condition: Frs1Condition;

  /** Advisory only — never moves custody, never blocks refund (Section 4.2). */
  disputedFlag: boolean;

  /** `null` when not disputed; set/cleared alongside `disputedFlag`. */
  disputedAt: UnixTimestamp | null;

  /** Optional, display-only in v1. */
  handle?: string;

  /** Optional; enforced off-chain by the deterministic policy engine. */
  agentPolicy?: Frs1AgentPolicy;

  /**
   * Settlement (release/refund) transaction signature (Section 4.4).
   *
   * Proves a specific transition happened, for a specific amount and asset,
   * authorized by the required signer. It does NOT prove the real-world
   * condition was met — never imply otherwise in UI copy.
   */
  receiptProof?: TransactionSignature;
}

/**
 * Documentation metadata for the schema, so the app can render the FRS-1 object
 * honestly without re-describing it. Display-only: never build logic on it.
 */
export const FRS1_FIELDS: ReadonlyArray<{
  name: keyof Frs1Agreement;
  type: string;
  note: string;
}> = [
  { name: "id", type: "Uuid4", note: "uuid-v4; a PDA seed together with the recipient" },
  { name: "payerAddress", type: "WalletAddress | null", note: "set at funding; first funder wins" },
  { name: "recipientAddress", type: "WalletAddress", note: "proposes the agreement; immutable once funded" },
  { name: "title", type: "string", note: "display only" },
  { name: "amount", type: "BaseUnits", note: "u64 base units as a string; immutable once funded" },
  { name: "asset", type: "MintAddress", note: "SPL mint; symbols are display-only" },
  { name: "escrowAddress", type: "TokenAccountAddress", note: "the escrow ATA, not the agreement PDA" },
  { name: "memo", type: "string", note: "display only" },
  { name: "expiresAt", type: "UnixTimestamp", note: "Clock sysvar only, never instruction-supplied" },
  { name: "status", type: "AgreementStatus", note: "pending | funded | released | refunded | cancelled" },
  { name: "condition", type: "Frs1Condition", note: "v1 enforces manual-confirmation only" },
  { name: "disputedFlag", type: "boolean", note: "advisory: never moves custody" },
  { name: "disputedAt", type: "UnixTimestamp | null", note: "set/cleared with the flag" },
  { name: "handle", type: "string (optional)", note: "display-only in v1" },
  { name: "agentPolicy", type: "Frs1AgentPolicy (optional)", note: "enforced off-chain, deterministically" },
  { name: "receiptProof", type: "TransactionSignature (optional)", note: "settlement signature only" },
] as const;
