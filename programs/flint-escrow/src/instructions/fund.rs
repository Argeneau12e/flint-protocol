//! `fund` — the first funder deposits the full amount (`Pending` → `Funded`).
//!
//! Open model (Section 4.2): anyone may fund, and whoever does so first becomes
//! `payerAddress` — permanently, atomically with the deposit, in this same
//! instruction. There is therefore no payer authority on a pending agreement,
//! and this is the only instruction that may ever write `payer_address`.

use crate::errors::FlintError;
use crate::instructions::{check_canonical_agreement, check_escrow_account, check_owned_by};
use crate::state::{AgreementStatus, FlintAgreement};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct Fund<'info> {
    /// Becomes `payerAddress`; must own `funder_token_account`.
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(mut)]
    pub agreement: Account<'info, FlintAgreement>,

    /// The funder's source token account, denominated in the agreement's asset.
    #[account(mut)]
    pub funder_token_account: Account<'info, TokenAccount>,

    /// The agreement's escrow ATA; validated against stored state, never trusted.
    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_fund(ctx: Context<Fund>) -> Result<()> {
    let funder_key = ctx.accounts.funder.key();

    // ---- validation against stored agreement state (rows 2 and 5) ----
    {
        let agreement = &ctx.accounts.agreement;

        check_canonical_agreement(agreement)?;

        // Section 4.2: only a pending agreement can be funded. This is also what
        // makes row 4 hold for funding: a second attempt fails the state check.
        require!(
            agreement.status == AgreementStatus::Pending,
            FlintError::NotPending
        );

        // Section 4.6: refuse to fund an agreement whose deadline has already
        // passed. It could never be released (row 3 requires now < expiresAt),
        // so accepting the deposit would only trap the funder's money until
        // expiry. The Clock sysvar is the only time source (Section 4.5).
        require!(
            Clock::get()?.unix_timestamp < agreement.expires_at,
            FlintError::ExpiredBeforeFunding
        );

        check_escrow_account(agreement, &ctx.accounts.escrow_token_account)?;
        check_owned_by(
            &ctx.accounts.funder_token_account,
            &funder_key,
            &agreement.asset,
            FlintError::FunderTokenAccountMismatch,
        )?;
    }

    // ---- transfer exactly the stored amount; no partial funding (4.2) ----
    // The amount is read from the agreement, not from an argument, so there is
    // no way to fund a different figure than the one the recipient proposed.
    let amount = ctx.accounts.agreement.amount;
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.funder_token_account.to_account_info(),
                to: ctx.accounts.escrow_token_account.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        amount,
    )?;

    // ---- pending -> funded, and the funder is the payer, permanently ----
    let agreement = &mut ctx.accounts.agreement;
    agreement.payer_address = Some(funder_key);
    agreement.status = AgreementStatus::Funded;

    Ok(())
}
