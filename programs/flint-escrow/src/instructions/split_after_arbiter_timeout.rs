//! `split_after_arbiter_timeout` — permissionless 50/50 split once the arbiter is
//! late (`Disputed` → `Split`).
//!
//! The escape hatch that makes the arbiter optional rather than load-bearing. If
//! the arbiter wallet is lost, unresponsive, or simply never acts, the funds cannot
//! sit in escrow indefinitely: after `disputed_at + arbiter_timeout_secs` anyone
//! may split them evenly, so the worst outcome for a broken arbiter is that both
//! sides are wronged by half rather than that neither is ever paid.
//!
//! It is a **fixed** 50/50, not a caller-chosen share. A permissionless crank that
//! let the caller pick the split would let anyone front-run the arbiter with a
//! 9999/1 split in their own favour.

use crate::errors::FlintError;
use crate::fees::{fee_for_share, share_of};
use crate::instructions::{
    check_canonical_agreement, check_escrow_account, check_owned_by, check_treasury_account,
    pay_recipient,
};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount};

/// The share the recipient receives when the arbiter's window has lapsed.
pub const TIMEOUT_SPLIT_RECIPIENT_BPS: u16 = 5_000;

#[derive(Accounts)]
pub struct SplitAfterArbiterTimeout<'info> {
    /// Anyone may crank this once the arbiter's window has passed. Payer only in
    /// the sense that the funds reach the stored payer too.
    #[account(mut)]
    pub cranker: Signer<'info>,

    pub config: Account<'info, Config>,

    #[account(mut)]
    pub agreement: Account<'info, FlintAgreement>,

    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub payer_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_split_after_arbiter_timeout(ctx: Context<SplitAfterArbiterTimeout>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    let (bump, amount, fee_amount) = {
        let agreement = &ctx.accounts.agreement;
        let bump = check_canonical_agreement(agreement)?;

        require!(
            agreement.status == AgreementStatus::Disputed,
            FlintError::NotDisputed
        );

        // The timeout is the deadline frozen at dispute time, on the agreement
        // itself — never the Config's live window, and never an argument. A
        // later admin rotation of `arbiter_timeout_secs` must not move the
        // deadline of an in-flight dispute.
        let deadline = agreement.arbiter_deadline.ok_or(FlintError::NotDisputed)?;
        require!(now >= deadline, FlintError::ArbiterTimeoutNotReached);

        check_escrow_account(agreement, &ctx.accounts.escrow_token_account)?;
        check_owned_by(
            &ctx.accounts.payer_token_account,
            &agreement.payer_address.ok_or(FlintError::NotFunded)?,
            &agreement.asset,
            FlintError::TokenAccountOwnerMismatch,
        )?;
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

    let bps = TIMEOUT_SPLIT_RECIPIENT_BPS;
    let recipient_amount = share_of(amount, bps)?;
    let payer_amount = amount
        .checked_sub(recipient_amount)
        .ok_or(FlintError::FeeMathOverflow)?;
    let fee = fee_for_share(fee_amount, bps)?;
    let recipient_net = recipient_amount
        .checked_sub(fee)
        .ok_or(FlintError::FeeMathOverflow)?;

    pay_recipient(
        &ctx.accounts.agreement,
        bump,
        &ctx.accounts.escrow_token_account,
        &ctx.accounts.recipient_token_account,
        &ctx.accounts.treasury_token_account,
        &ctx.accounts.token_program,
        recipient_net,
        fee,
    )?;

    if payer_amount > 0 {
        let id_bytes = ctx.accounts.agreement.id;
        let recipient_bytes = ctx.accounts.agreement.recipient_address.to_bytes();
        let bump_arr = [bump];
        let seeds: &[&[u8]] = &[
            AGREEMENT_SEED,
            recipient_bytes.as_ref(),
            id_bytes.as_ref(),
            &bump_arr,
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                token::Transfer {
                    from: ctx.accounts.escrow_token_account.to_account_info(),
                    to: ctx.accounts.payer_token_account.to_account_info(),
                    authority: ctx.accounts.agreement.to_account_info(),
                },
                &[seeds],
            ),
            payer_amount,
        )?;
    }

    ctx.accounts.agreement.status = AgreementStatus::Split;
    Ok(())
}
