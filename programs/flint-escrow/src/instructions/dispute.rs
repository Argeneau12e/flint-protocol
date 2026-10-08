//! `dispute` — the payer rejects a delivery claim inside the review window
//! (`DeliveryClaimed` → `Disputed`).
//!
//! Moves no money. It records that the payer is not satisfied and freezes the
//! agreement until the arbiter rules. The review window is the whole point: a
//! dispute outside it is refused, because after the window closes the claim is
//! either paid out or already contested, and re-opening it would let a payer who
//! waited dispute a claim they had already let stand.

use crate::errors::FlintError;
use crate::instructions::{check_canonical_agreement, review_window_end};
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Dispute<'info> {
    /// Must be the agreement's stored payer (row 1).
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub agreement: Account<'info, FlintAgreement>,

    /// Read at dispute time so the arbiter's deadline is frozen into the
    /// agreement below. Must be provided because `split_after_arbiter_timeout`
    /// must not re-read a timeout a later admin change could have moved.
    pub config: Account<'info, Config>,
}

pub fn handle_dispute(ctx: Context<Dispute>, reason: DisputeReason) -> Result<()> {
    check_canonical_agreement(&ctx.accounts.agreement)?;

    let payer_key = ctx.accounts.payer.key();
    let now = Clock::get()?.unix_timestamp;

    let agreement = &mut ctx.accounts.agreement;

    // A dispute targets a *live* claim, so the state shape is checked before
    // any identity: on a pending agreement there is not even a payer stored
    // yet, and the missing claim is the fact the test (and a caller) needs.
    // An already-disputed agreement is not re-disputable: once the arbiter
    // owns it, a fresh `Disputed` transition would overwrite `disputed_at` /
    // `arbiter_deadline` and silently restart the arbiter's window.
    require!(
        agreement.status != AgreementStatus::Disputed,
        FlintError::AlreadyDisputed
    );

    // There must be a claim to dispute. The enum is already closed to 1..=5 by
    // its definition, so the reason needs no runtime range check.
    require!(
        agreement.status == AgreementStatus::DeliveryClaimed,
        FlintError::NotDeliveryClaimed
    );

    require_keys_eq!(
        agreement.payer_address.ok_or(FlintError::NotFunded)?,
        payer_key,
        FlintError::PayerOnly
    );

    // Strictly before the window closes: at exactly the boundary the claim is
    // already releasable, so accepting a dispute there would let a dispute
    // compete with a payout that anyone may crank.
    require!(
        now < review_window_end(agreement)?,
        FlintError::ReviewWindowClosed
    );

    // The arbiter's deadline is frozen here, from this moment's Config window.
    // A later admin rotation of `arbiter_timeout_secs` must not move the
    // deadline of an in-flight dispute: shortening it would cut the arbiter's
    // window, lengthening it would strand the escrow longer.
    let arbiter_deadline = now
        .checked_add(ctx.accounts.config.arbiter_timeout_secs as i64)
        .ok_or(FlintError::FeeMathOverflow)?;

    agreement.status = AgreementStatus::Disputed;
    agreement.disputed_at = Some(now);
    agreement.arbiter_deadline = Some(arbiter_deadline);
    agreement.dispute_reason = Some(reason);

    Ok(())
}
