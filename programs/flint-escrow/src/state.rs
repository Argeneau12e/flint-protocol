//! FRS-1 agreement state — the canonical on-chain shape of a Flint payment
//! agreement (FLINT_BUILD_CONTEXT.md Sections 4.1 / 4.2 / 4.5).
//!
//! PHASE 0 SCOPE: declarative types, account layout and protocol constants
//! only. There is no transition logic in this file — every state machine rule
//! in Section 4.2 belongs to Phase 1, alongside the Section 5 threat-model
//! tests that prove each rule.

use anchor_lang::prelude::*;

/// PDA seed prefix for the agreement account (Section 4.5):
/// `[AGREEMENT_SEED, recipient.key().as_ref(), id]`.
///
/// Recipient-bound because the recipient is the only signer whose authority
/// matters at creation: the recipient proposes the agreement, and the payer is
/// whoever funds it first — so no payer exists (and none is known) yet.
pub const AGREEMENT_SEED: &[u8] = b"agreement";

// ---------------------------------------------------------------------------
// Bounds for variable-length fields. `InitSpace` needs them to size the
// account; they are also the limits the app layer must respect when proposing
// an agreement. Changing any of these is an account-layout change.
// ---------------------------------------------------------------------------
pub const MAX_TITLE_LEN: usize = 128;
pub const MAX_MEMO_LEN: usize = 512;
pub const MAX_HANDLE_LEN: usize = 64;
pub const MAX_CONDITION_DESCRIPTION_LEN: usize = 256;
pub const MAX_ALLOWLIST_LEN: usize = 16;
/// A base58-encoded 64-byte signature is 88 chars; 96 leaves headroom.
pub const MAX_RECEIPT_PROOF_LEN: usize = 96;

/// Lifecycle of an FRS-1 agreement (Section 4.2).
///
/// - `Pending` → `Funded`    : first funder deposits the full `amount`; that
///                             address becomes `payerAddress`, permanently.
/// - `Pending` → `Cancelled` : recipient only (no payer exists yet).
/// - `Funded`  → `Released`  : payer-signed confirmation only.
/// - `Funded`  → `Refunded`  : after `expiresAt`, permissionless crank; funds
///                             always go to the stored payer, never the caller.
/// - `Released` / `Refunded` : terminal — nothing transitions out.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum AgreementStatus {
    Pending,
    Funded,
    Released,
    Refunded,
    Cancelled,
}

/// The `condition.type` values (Section 4.3).
///
/// v1 mechanically enforces exactly one of them. `OracleAttested` is a named
/// schema value for future use and **is deliberately not implemented in v1** —
/// no instruction may ever treat it as satisfied, and a free-text
/// `description` must never gate an on-chain transition.
///
/// FRS-1's string form is kebab-case (`"manual-confirmation"` /
/// `"oracle-attested"`); the app layer owns that mapping (Sections 4.1, 4.3).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ConditionType {
    /// The only type the program checks: release happens when the payer signs
    /// the release instruction, and nowhere else.
    ManualConfirmation,
    /// Schema value only — unimplemented by design (Sections 3 and 8).
    OracleAttested,
}

/// FRS-1 `condition` — `{ type, description }` (Sections 4.1 / 4.3).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq, InitSpace)]
pub struct Condition {
    /// Serialized as FRS-1's `type` field. The Rust identifier differs only
    /// because `type` is a Rust keyword; the TypeScript side uses `type`.
    pub condition_type: ConditionType,
    /// Human-readable only — display text, never a verification mechanism.
    #[max_len(MAX_CONDITION_DESCRIPTION_LEN)]
    pub description: String,
}

/// FRS-1 `agentPolicy` — optional, for autonomous payers (Section 6.2).
///
/// Evaluated off-chain by the deterministic policy engine (no LLM anywhere in
/// the pay/no-pay decision path); the program stores it but does not enforce it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq, InitSpace)]
pub struct AgentPolicy {
    /// FRS-1 `spendCap`, in `asset` base units.
    pub spend_cap: u64,
    /// FRS-1 `allowlist` — permitted recipient addresses.
    #[max_len(MAX_ALLOWLIST_LEN)]
    pub allowlist: Vec<Pubkey>,
}

/// The FRS-1 agreement account (Section 4.1, field-for-field).
///
/// Immutability that follows from Section 4.2: once `status` is no longer
/// `Pending`, the term fields (`amount`, `recipient_address`, `asset`,
/// `condition`) are never written again — Phase 1 satisfies this by exposing no
/// instruction that can write them (threat-model row 6).
#[account]
#[derive(InitSpace)]
pub struct FlintAgreement {
    /// FRS-1 `id` — uuid-v4 as 16 raw bytes; also a PDA seed (Section 4.5).
    pub id: [u8; 16],

    /// FRS-1 `payerAddress` — the funding wallet.
    ///
    /// `None` while pending. It is set once, atomically with the deposit, to
    /// whoever funds first (open model, first funder wins), and never changes
    /// afterwards. There is therefore no payer authority on a pending
    /// agreement (Section 4.2).
    pub payer_address: Option<Pubkey>,

    /// FRS-1 `recipientAddress` — set at creation, immutable once funded.
    pub recipient_address: Pubkey,

    /// FRS-1 `title`.
    #[max_len(MAX_TITLE_LEN)]
    pub title: String,

    /// FRS-1 `amount` — `u64` base units, always; never a float, anywhere
    /// (Section 4.5). No partial settlement: paid in full or not at all.
    pub amount: u64,

    /// FRS-1 `asset` — the SPL token mint `Pubkey`, authoritative. A symbol
    /// such as "USDC" is a display-only app-layer lookup (Section 4.5).
    pub asset: Pubkey,

    /// FRS-1 `escrowAddress` — the **escrow's SPL token account (ATA)**, not
    /// the agreement PDA. The PDA is state/authority; this ATA holds the
    /// tokens, with the PDA (or an escrow-authority PDA derived from it) as its
    /// authority (Section 4.5).
    pub escrow_address: Pubkey,

    /// FRS-1 `memo`.
    #[max_len(MAX_MEMO_LEN)]
    pub memo: String,

    /// FRS-1 `expiresAt` — compared against the on-chain Clock sysvar only,
    /// never an instruction-supplied timestamp (Section 4.5).
    pub expires_at: i64,

    /// FRS-1 `status` (Section 4.2).
    pub status: AgreementStatus,

    /// FRS-1 `condition` (Section 4.3).
    pub condition: Condition,

    /// FRS-1 `disputedFlag` — advisory only: never moves custody, never blocks
    /// refund after expiry (Section 4.2). Recipient sets and clears it.
    pub disputed_flag: bool,

    /// FRS-1 `disputedAt` — set and cleared alongside `disputed_flag`.
    pub disputed_at: Option<i64>,

    /// FRS-1 `handle` — optional, display-only in v1 (Flint.ID is roadmap;
    /// nothing resolves this yet).
    #[max_len(MAX_HANDLE_LEN)]
    pub handle: Option<String>,

    /// FRS-1 `agentPolicy` — optional (agent flow).
    pub agent_policy: Option<AgentPolicy>,

    /// FRS-1 `receiptProof` — the **settlement** (release/refund) transaction
    /// signature, written when settlement happens (Section 4.4). The funding
    /// signature is deliberately not stored; that is an accepted gap because it
    /// is discoverable from the account's on-chain history.
    ///
    /// What it proves: that a specific transition occurred, for a specific
    /// amount and asset, authorized by the required signer. What it does not
    /// prove: that the real-world condition was actually met (Section 4.4).
    #[max_len(MAX_RECEIPT_PROOF_LEN)]
    pub receipt_proof: Option<String>,
}
