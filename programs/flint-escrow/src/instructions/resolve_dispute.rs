//! `resolve_dispute` — the arbiter's ruling (`Disputed` → terminal).
//!
//! The only instruction the arbiter may call, and the only one that may pay the
//! arbiter itself is none: the destination accounts are validated against the
//! agreement's stored payer and recipient and the Config's stored treasury, so
//! every lamport that leaves escrow lands on one of exactly three addresses, none
//! of which the arbiter chooses. An arbiter that cannot be paid has no incentive
//! to be anything but honest.
//!
//! `Split` divides the escrow by basis points: the recipient gets their share
//! less the fee attributable to that share, the payer keeps the rest, and the
//! treasury receives the scaled fee. The three legs sum to the original amount by
//! construction, which the test suite asserts rather than assumes.

use crate::errors::FlintError;
use crate::fees::{fee_for_share, share_of};
use crate::instructions::{
    check_canonical_agreement, check_escrow_account, check_owned_by, check_treasury_account,
    pay_recipient,
};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount};

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    /// Must equal the Config's stored arbiter (row 1).
    #[account(mut)]
    pub arbiter: Signer<'info>,

    pub config: Account<'info, Config>,

    #[account(mut)]
    pub agreement: Account<'info, FlintAgreement>,

    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// The stored payer's token account.
    #[account(mut)]
    pub payer_token_account: Account<'info, TokenAccount>,

    /// The stored recipient's token account.
    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// The Config's treasury token account for this asset.
    #[account(mut)]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
pub fn handle_resolve_dispute(ctx: Context<ResolveDispute>, outcome: DisputeOutcome) -> Result<()> {
    let (bump, amount, fee_amount) = {
        let agreement = &ctx.accounts.agreement;
        let bump = check_canonical_agreement(agreement)?;

        // Row 1: "the arbiter" means the Config's stored arbiter and nothing else.
        require_keys_eq!(
            ctx.accounts.arbiter.key(),
            ctx.accounts.config.arbiter,
            FlintError::ArbiterOnly
        );

        require!(
            agreement.status == AgreementStatus::Disputed,
            FlintError::NotDisputed
        );

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

    let status = match outcome {
        DisputeOutcome::Release => {
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
            AgreementStatus::Released
        }
        DisputeOutcome::Refund => {
            // A refund returns the payer's own money and is never charged a fee:
            // there is no completed payout to the recipient to cover.
            transfer_to_payer(&ctx, amount)?;
            AgreementStatus::Refunded
        }
        DisputeOutcome::Split { recipient_bps } => {
            let recipient_amount = share_of(amount, recipient_bps)?;
            let payer_amount = amount
                .checked_sub(recipient_amount)
                .ok_or(FlintError::FeeMathOverflow)?;
            // The fee follows the recipient's share: half a payout is half a fee.
            let fee = fee_for_share(fee_amount, recipient_bps)?;
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
                transfer_to_payer(&ctx, payer_amount)?;
            }

            AgreementStatus::Split
        }
    };

    let agreement = &mut ctx.accounts.agreement;
    agreement.status = status;
    Ok(())
}

/// Moves escrow to the agreement's **stored** payer, signed by the PDA.
///
/// Shared by the refund and split legs here, so the payer side of every split is
/// the same pinned transfer rather than a hand-written second copy.
fn transfer_to_payer(ctx: &Context<ResolveDispute>, amount: u64) -> Result<()> {
    let bump = check_canonical_agreement(&ctx.accounts.agreement)?;
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
        amount,
    )
}
