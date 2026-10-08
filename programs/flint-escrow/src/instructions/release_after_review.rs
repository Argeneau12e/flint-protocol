//! `release_after_review` — permissionless crank once the review window closes
//! (`DeliveryClaimed` → `Released`).
//!
//! This is what makes a *silence* meaningful. If nobody disputed inside the
//! review window, the recipient is owed their money without having to ask: anyone
//! may finish the settlement once the window has passed, so a recipient who was
//! ignored, or whose payer went offline, is not left waiting.
//!
//! Paying the recipient means paying the fee, which this shares with every other
//! recipient-paying path via `pay_recipient`.

use crate::errors::FlintError;
use crate::instructions::{
    check_canonical_agreement, check_escrow_account, check_owned_by, check_treasury_account,
    pay_recipient, review_window_end,
};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

#[derive(Accounts)]
pub struct ReleaseAfterReview<'info> {
    /// Anyone may crank this. Like `refund`'s cranker, this signer only pays the
    /// fee and is never a beneficiary — the destination comes from stored state.
    #[account(mut)]
    pub cranker: Signer<'info>,

    /// The Config, for the treasury the fee is paid to.
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub agreement: Account<'info, FlintAgreement>,

    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// The stored recipient's token account, validated against stored state.
    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// The treasury's token account for this asset.
    #[account(mut)]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_release_after_review(ctx: Context<ReleaseAfterReview>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    let (bump, amount, fee_amount) = {
        let agreement = &ctx.accounts.agreement;
        let bump = check_canonical_agreement(agreement)?;

        require!(
            agreement.status == AgreementStatus::DeliveryClaimed,
            FlintError::NotDeliveryClaimed
        );

        // The window must be *closed*. Running this while the payer still has the
        // right to dispute would let anyone front-run that right.
        require!(
            now >= review_window_end(agreement)?,
            FlintError::ReviewWindowOpen
        );

        check_escrow_account(agreement, &ctx.accounts.escrow_token_account)?;
        check_owned_by(
            &ctx.accounts.recipient_token_account,
            &agreement.recipient_address,
            &agreement.asset,
            FlintError::TokenAccountOwnerMismatch,
        )?;
        check_treasury_account(&ctx.accounts.config, &ctx.accounts.treasury_token_account)?;
        require_keys_eq!(
            ctx.accounts.treasury_token_account.mint,
            agreement.asset,
            FlintError::AssetMismatch
        );

        (bump, agreement.amount, agreement.fee_amount)
    };

    // The fee is deducted from the recipient's payout, so the payer pays exactly
    // the agreed amount either way.
    let recipient_amount = amount
        .checked_sub(fee_amount)
        .ok_or(FlintError::FeeMathOverflow)?;

    pay_recipient(
        &ctx.accounts.agreement,
        bump,
        &ctx.accounts.escrow_token_account,
        &ctx.accounts.recipient_token_account,
        &ctx.accounts.treasury_token_account,
        &ctx.accounts.token_program,
        recipient_amount,
        fee_amount,
    )?;

    ctx.accounts.agreement.status = AgreementStatus::Released;
    Ok(())
}
