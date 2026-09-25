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
pub mod instructions;
pub mod state;

pub use errors::*;
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

    /// Recipient proposes an agreement (no state → `Pending`).
    pub fn create(
        ctx: Context<Create>,
        id: [u8; 16],
        amount: u64,
        expires_at: i64,
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

    /// Recipient sets or clears the advisory dispute flag (`Funded` →
    /// `Funded`). `disputed` is explicit rather than a toggle, so repeats are
    /// idempotent and the flag cannot flip by accident.
    pub fn flag_dispute(ctx: Context<FlagDispute>, disputed: bool) -> Result<()> {
        instructions::flag_dispute::handle_flag_dispute(ctx, disputed)
    }
}
