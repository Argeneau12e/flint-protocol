//! Flint escrow program — the reference Solana adapter for FRS-1.
//!
//! Scope is set by FLINT_BUILD_CONTEXT.md: one agreement PDA per agreement, six
//! instructions, the Section 4.2 state machine enforced exactly, and the
//! Section 4.6 constraints on top. Devnet-only until every Section 5
//! threat-model test is green and a human has reviewed it (Section 6.3).
//!
//! Custody model (Section 4.5): the agreement PDA holds state and is the
//! authority of the escrow's SPL token account (ATA); the tokens sit in that
//! ATA and can only move through `release` or `refund`.
//!
//! Deliberate limits of v1:
//! - legacy SPL Token only (no token-2022): transfer-fee/interest-bearing
//!   extensions would break the exact-amount invariant of row 5;
//! - no instruction writes `receipt_proof` — see the FLAG note in `state.rs`.
//!   A program cannot read its own transaction's signature, so the receipt is
//!   the settlement signature captured by the client and checked against the
//!   chain, which is what Section 4.4 actually requires.

pub mod errors;
pub mod fees;
pub mod instructions;
pub mod state;

pub use errors::*;
pub use fees::*;
pub use instructions::*;
pub use state::*;

use anchor_lang::prelude::*;

// Devnet program id. The matching keypair is at the workspace root,
// `target/deploy/flint_escrow-keypair.json` (gitignored): Anchor resolves
// program keypairs there, not inside the crate directory. If the keypair is
// lost or regenerated, run `anchor keys sync` rather than editing this by hand.
//
// (A doc comment is not used here: rustdoc does not document macro
// invocations, so `///` would warn as an unused doc comment.)
declare_id!("ziZiaCVcDaenoUP7jHdEPk4R2XJ8zeY5UbMPKFuqZxE");

#[program]
pub mod flint_escrow {
    use super::*;

    /// Recipient proposes an agreement (no state -> `Pending`).
    pub fn create(
        ctx: Context<Create>,
        id: [u8; 16],
        amount: u64,
        expires_at: i64,
        review_window_secs: u32,
        condition_type: ConditionType,
        condition_description: String,
        title: String,
        memo: String,
        handle: Option<String>,
        agent_policy: Option<AgentPolicy>,
    ) -> Result<()> {
        instructions::create::handle_create(
            ctx,
            id,
            amount,
            expires_at,
            review_window_secs,
            condition_type,
            condition_description,
            title,
            memo,
            handle,
            agent_policy,
        )
    }

    /// First funder deposits the full amount (`Pending` → `Funded`) and becomes
    /// `payerAddress`, permanently.
    pub fn fund(ctx: Context<Fund>) -> Result<()> {
        instructions::fund::handle_fund(ctx)
    }

    /// The stored payer confirms the condition is met (`Funded` → `Released`).
    pub fn release(ctx: Context<Release>) -> Result<()> {
        instructions::release::handle_release(ctx)
    }

    /// Permissionless crank after expiry (`Funded` → `Refunded`); funds go to
    /// the stored payer, never to the caller.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        instructions::refund::handle_refund(ctx)
    }

    /// Recipient withdraws before funding (`Pending` → `Cancelled`, account
    /// closed, rent back to the recipient).
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        instructions::cancel::handle_cancel(ctx)
    }

    /// Creates the global Config. Once per program, signed by the upgrade
    /// authority, which becomes the admin.
    pub fn init_config(
        ctx: Context<InitConfig>,
        treasury: Pubkey,
        arbiter: Pubkey,
        arbiter_timeout_secs: u64,
        min_agreement: u64,
    ) -> Result<()> {
        instructions::init_config::handle_init_config(
            ctx,
            treasury,
            arbiter,
            arbiter_timeout_secs,
            min_agreement,
        )
    }

    /// Admin-only rotation of the treasury, arbiter and arbiter timeout.
    pub fn set_config_roles(
        ctx: Context<SetConfigRoles>,
        new_treasury: Option<Pubkey>,
        new_arbiter: Option<Pubkey>,
        new_arbiter_timeout_secs: Option<u64>,
    ) -> Result<()> {
        instructions::set_config_roles::handle_set_config_roles(
            ctx,
            new_treasury,
            new_arbiter,
            new_arbiter_timeout_secs,
        )
    }

    /// Recipient claims delivery with a manifest hash and a locator to check it
    /// against (`Funded` -> `DeliveryClaimed`). One claim, and only before
    /// expiry. After this the agreement's expiry has no further effect.
    pub fn claim_delivery(
        ctx: Context<ClaimDelivery>,
        evidence_hash: [u8; 32],
        evidence_ref: String,
    ) -> Result<()> {
        instructions::claim_delivery::handle_claim_delivery(ctx, evidence_hash, evidence_ref)
    }

    /// Payer rejects a claim inside the review window (`DeliveryClaimed` ->
    /// `Disputed`). Moves no money.
    pub fn dispute(ctx: Context<Dispute>, reason: DisputeReason) -> Result<()> {
        instructions::dispute::handle_dispute(ctx, reason)
    }

    /// Permissionless crank once the review window closes
    /// (`DeliveryClaimed` -> `Released`): silence is a decision.
    pub fn release_after_review(ctx: Context<ReleaseAfterReview>) -> Result<()> {
        instructions::release_after_review::handle_release_after_review(ctx)
    }

    /// Arbiter-only ruling on a dispute. Funds can only ever reach the stored
    /// payer, the stored recipient, or the Config's treasury.
    pub fn resolve_dispute(ctx: Context<ResolveDispute>, outcome: DisputeOutcome) -> Result<()> {
        instructions::resolve_dispute::handle_resolve_dispute(ctx, outcome)
    }

    /// Permissionless fixed 50/50 split once the arbiter's window has lapsed
    /// (`Disputed` -> `Split`), so a lost arbiter can never strand the escrow.
    pub fn split_after_arbiter_timeout(ctx: Context<SplitAfterArbiterTimeout>) -> Result<()> {
        instructions::split_after_arbiter_timeout::handle_split_after_arbiter_timeout(ctx)
    }
}
