//! `refund` — permissionless crank after expiry (`Funded` → `Refunded`).
//!
//! Section 4.2: anyone may call it, but the money always goes to the stored
//! `payerAddress` — never to the caller. This is the second and final path that
//! changes custody, and the only valid transition once `expiresAt` has passed
//! (row 3).

use crate::errors::FlintError;
use crate::instructions::{check_canonical_agreement, check_escrow_account, check_owned_by};
use crate::state::{AgreementStatus, FlintAgreement, AGREEMENT_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct Refund<'info> {
    /// Anyone can crank the refund. This signer only pays the transaction fee —
    /// it is never the beneficiary, which is why the account is not called
    /// "payer": naming it that would invite exactly the confusion row 1 exists
    /// to prevent.
    pub cranker: Signer<'info>,

    #[account(mut)]
    pub agreement: Account<'info, FlintAgreement>,

    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// The stored payer's token account; validated against `payer_address`.
    #[account(mut)]
    pub payer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_refund(ctx: Context<Refund>) -> Result<()> {
    // ---- validation against stored agreement state (rows 2, 3, 5) ----
    let (amount, bump) = {
        let agreement = &ctx.accounts.agreement;

        let bump = check_canonical_agreement(agreement)?;

        require!(
            agreement.status == AgreementStatus::Funded,
            FlintError::NotFunded
        );
        let stored_payer = agreement.payer_address.ok_or(FlintError::NotFunded)?;

        // Section 4.2: refund is available only after expiry — the Clock sysvar
        // is the only time source (Section 4.5).
        require!(
            Clock::get()?.unix_timestamp >= agreement.expires_at,
            FlintError::NotYetExpired
        );

        check_escrow_account(agreement, &ctx.accounts.escrow_token_account)?;
        // The destination is the *stored* payer, so whoever cranks this cannot
        // redirect the refund to themselves (rows 1 and 2).
        check_owned_by(
            &ctx.accounts.payer_token_account,
            &stored_payer,
            &agreement.asset,
            FlintError::TokenAccountOwnerMismatch,
        )?;

        // `disputed_flag` is deliberately never consulted: a flag that could
        // block refund after expiry would strand the funds past their deadline,
        // which Section 4.2 rules out.

        (agreement.amount, bump)
    };

    // ---- move the full amount back to the stored payer ----
    // The signer seeds are the *agreement PDA's* seeds: [seed, recipient, id] —
    // recipient-bound, per Section 4.5. (The destination being the payer is a
    // separate fact: it comes from stored `payer_address`, not from the seeds.)
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
            Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.payer_token_account.to_account_info(),
                authority: ctx.accounts.agreement.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    // ---- funded -> refunded, terminal (Section 4.2) ----
    let agreement = &mut ctx.accounts.agreement;
    agreement.status = AgreementStatus::Refunded;
    // As in `release`, `receipt_proof` is not writable on-chain: the receipt is
    // this transaction's signature (see `state.rs`).

    Ok(())
}
