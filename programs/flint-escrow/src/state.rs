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

/// `evidence_ref` is a compact opaque locator — `flint://e/<id>` — not a URL to
/// fetch. 96 bytes is generous for a scheme plus an unguessable id while keeping
/// the account size bounded.
pub const MAX_EVIDENCE_REF_LEN: usize = 96;

/// PDA seed prefix for the global Config account.
pub const CONFIG_SEED: &[u8] = b"config";

/// Default arbiter timeout: 72 hours.
pub const DEFAULT_ARBITER_TIMEOUT_SECS: u64 = 72 * 60 * 60;

/// The review windows a creator may choose, in seconds, and the default.
///
/// A closed set rather than "any value": these are the windows the UI offers,
/// and an arbitrary number would make the fee/UX comparison between agreements
/// meaningless. Creation validates against this list.
pub const ALLOWED_REVIEW_WINDOWS: &[u32] = &[
    6 * 60 * 60,  // 6h
    12 * 60 * 60, // 12h
    24 * 60 * 60, // 24h
    48 * 60 * 60, // 48h
];
pub const DEFAULT_REVIEW_WINDOW_SECS: u32 = 24 * 60 * 60;

/// Smallest agreement the protocol accepts, in whole tokens.
///
/// Also the floor of the fee table: an agreement below it could not carry a fee
/// that covers the payout it performs.
pub const MIN_AGREEMENT_WHOLE_TOKENS: u64 = 20;

/// Lifecycle of an FRS-1 agreement.
///
/// The delivery branch is the reason this enum grew: the recipient no longer
/// merely "confirms" delivery, they *claim* it with evidence, and that claim
/// opens a review window in which the payer may dispute before money moves.
///
/// - `Pending` → `Funded`      : first funder deposits the full `amount`; that
///                               address becomes `payer_address`, permanently.
/// - `Pending` → `Cancelled`   : recipient only (no payer exists yet).
/// - `Funded` → `DeliveryClaimed` : recipient claims delivery with evidence,
///                               before `expires_at`. One claim only.
/// - `Funded` → `Released`     : payer-signed release, from `Funded` or
///                               `DeliveryClaimed`, at any time.
/// - `Funded` → `Refunded`     : after `expires_at`, permissionless crank, and
///                               only while no claim exists.
/// - `DeliveryClaimed` → `Released` : `release_after_review`, permissionless once
///                               `claimed_at + review_window_secs` has passed.
/// - `DeliveryClaimed` → `Disputed` : payer only, inside the review window.
/// - `Disputed` → `Released` / `Refunded` / `Split` : the arbiter's call, or the
///                               50/50 timeout split once the arbiter is late.
/// - `Released` / `Refunded` / `Split` / `Cancelled` : terminal.
///
/// The claim **detaches the agreement from `expires_at`**: once delivery is
/// claimed, expiry has no further effect, and `refund` refuses. That is why the
/// refund path checks the status rather than the clock alone.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum AgreementStatus {
    Pending,
    Funded,
    DeliveryClaimed,
    Released,
    Refunded,
    Cancelled,
    Disputed,
    Split,
}

/// Why the payer disputed a delivery claim (`dispute.reason_code` 1..=5).
///
/// A code, not free text: it has to be small enough to live on-chain, and a
/// closed set means the recipient and the arbiter see the same categories.
///
/// Borsh serializes this as the variant index (0..=4); the FRS-1 reason codes
/// 1..=5 are that index plus one, mapped by name in the client
/// (`DISPUTE_REASON_CODES` in `app/lib/frs1-types.ts`). Explicit discriminants
/// are deliberately *not* used here: Anchor's TypeScript coder writes enum
/// variants by index, so a `#[borsh(use_discriminant)]` enum would make the
/// program expect different bytes from what the client sends.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum DisputeReason {
    NotAsDescribed,
    Incomplete,
    NotReceived,
    Quality,
    Other,
}

/// How the arbiter resolved a dispute.
///
/// `Split` carries the recipient's basis-point share; the payer receives the
/// remainder. A split share of 0 or 10000 would be a refund or a release wearing
/// a different name, so both are rejected.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum DisputeOutcome {
    Release,
    Refund,
    Split { recipient_bps: u16 },
}

/// Global protocol configuration, one PDA per program.
///
/// Holds the two roles that have to be the *same on every agreement* — the
/// treasury that receives fees, and the arbiter that resolves disputes — plus
/// the two parameters the protocol enforces on every agreement (minimum amount,
/// arbiter timeout). A per-agreement copy of any of these would let an
/// agreement choose its own arbiter, which is the one authority that must never
/// be negotiable.
///
/// Set once by `init_config`, signed by the upgrade authority. The admin may then
/// rotate `treasury` and `arbiter`; it may not change the minimum, because the
/// minimum is what the fee table's floor assumes.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// May rotate `treasury` and `arbiter`. Initially the upgrade authority.
    pub admin: Pubkey,
    /// Receives every fee, in the agreement's own asset.
    pub treasury: Pubkey,
    /// The only signer `resolve_dispute` accepts.
    pub arbiter: Pubkey,
    /// How long the arbiter has to resolve before `split_after_arbiter_timeout`
    /// becomes available. Read from the Clock sysvar like every other deadline.
    pub arbiter_timeout_secs: u64,
    /// Minimum agreement size in **whole tokens**; scaled by mint decimals when
    /// compared against a base-unit amount.
    pub min_agreement: u64,
    /// Bump for the config PDA, so instructions can sign with it.
    pub bump: u8,
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

    /// Review window the creator chose, in seconds. Always one of
    /// [`ALLOWED_REVIEW_WINDOWS`], validated at creation. It starts at
    /// `claimed_at`, not at `expires_at`: the window exists to review a delivery
    /// claim, and there is no claim to review until one exists.
    pub review_window_secs: u32,

    /// When the recipient claimed delivery. `None` until `claim_delivery`.
    ///
    /// The whole delivery branch is derived from this field: the review window
    /// closes at `claimed_at + review_window_secs`, and a dispute is only
    /// accepted strictly before that.
    pub claimed_at: Option<i64>,

    /// SHA-256 of the canonical evidence manifest, committed by the recipient at
    /// claim time.
    ///
    /// The *manifest*, not the files: hashing bytes a third party cannot fetch
    /// proves nothing after the fact, whereas a manifest hash can be recomputed
    /// later from the stored manifest and compared, which is exactly what
    /// `/verify` does. All zeros is reserved for "no claim yet" and is rejected
    /// as a claim's hash, so a claim can never look like an empty claim.
    pub evidence_hash: [u8; 32],

    /// Compact locator for the stored manifest, e.g. `flint://e/<id>`.
    ///
    /// Bounded by [`MAX_EVIDENCE_REF_LEN`] and required non-empty at claim time:
    /// a hash with no way to reach the bytes it covers would be unverifiable.
    #[max_len(MAX_EVIDENCE_REF_LEN)]
    pub evidence_ref: String,

    /// When the payer disputed a claim. `None` unless the status is `Disputed`.
    pub disputed_at: Option<i64>,

    /// The arbiter's deadline for this dispute, stored at dispute time as
    /// `disputed_at + config.arbiter_timeout_secs`.
    ///
    /// Stored rather than recomputed because a live config change must not move
    /// the deadline of an in-flight dispute: shortening it would cut the
    /// arbiter's window, lengthening it would strand the escrow longer.
    /// `split_after_arbiter_timeout` reads this field, never the Config.
    /// `None` unless the status is `Disputed`.
    pub arbiter_deadline: Option<i64>,

    /// Which reason code the payer gave (1..=5). Meaningful only with `disputed_at`.
    pub dispute_reason: Option<DisputeReason>,

    /// The protocol fee for this agreement, in base units, **locked at creation**.
    ///
    /// Locked rather than recomputed at settlement so that the payer's total cost
    /// is knowable from the agreement the moment it exists, and so a later change
    /// to the fee table cannot retroactively alter what an in-flight agreement
    /// owes. Deducted from the recipient's payout on every path that pays the
    /// recipient (scaled to the recipient's share on a split); never charged on a
    /// refund, which returns the payer's own money.
    pub fee_amount: u64,

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
    /// FLAG (raised in Phase 1 — not silently reinterpreted): no instruction
    /// writes this field, and none ever can. A Solana program cannot read its
    /// own transaction's signature, so the signature cannot be produced
    /// on-chain. As implemented, the receipt is the settlement signature the
    /// *client* observes and records, and its validity is established by
    /// recomputing status from this account and checking that transaction
    /// against this program's settlement instruction (Sections 4.4 and 6.2,
    /// threat-model row 7) — which is the property 4.4 actually asks for. The
    /// field is retained so the on-chain account stays a subset of the FRS-1
    /// schema, pending a decision on whether to drop it or replace it with
    /// something the program *can* write (e.g. the settlement slot).
    ///
    /// What a receipt proves: that a specific transition occurred, for a
    /// specific amount and asset, authorized by the required signer. What it
    /// does not prove: that the real-world condition was met (Section 4.4).
    #[max_len(MAX_RECEIPT_PROOF_LEN)]
    pub receipt_proof: Option<String>,
}
