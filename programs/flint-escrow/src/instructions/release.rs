//! `release` — the stored payer confirms the condition is met
//! (`Funded` → `Released`).
//!
//! This is the only path that pays the recipient, and Section 4.2 grants it to
//! the payer alone. Threat-model rows 1 (unauthorized release), 3 (expiry
//! bypass), 4 (replay) and 5 (wrong asset/amount) all land on this instruction.

use crate::errors::FlintError;
use crate::instructions::{check_canonical_agreement, check_escrow_account, check_owned_by};
use crate::state::{AgreementStatus, ConditionType, FlintAgreement, AGREEMENT_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct Release<'info> {
    /// Must be the agreement's **stored** `payerAddress` (row 1). The recipient
    /// cannot release, and neither can anyone else.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub agreement: Account<'info, FlintAgreement>,

    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// The recipient's token account for the agreement's asset. Validated
    /// against the stored `recipient_address` — never trusted (row 2).
    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_release(ctx: Context<Release>) -> Result<()> {
    let payer_key = ctx.accounts.payer.key();

    // ---- validation against stored agreement state (rows 1, 2, 3, 5) ----
    let (amount, recipient_address, bump) = {
        let agreement = &ctx.accounts.agreement;

        let bump = check_canonical_agreement(agreement)?;

        // Row 1: "the payer" means the stored address, and nothing else.
        require!(
            agreement.status == AgreementStatus::Funded,
            FlintError::NotFunded
        );
        let stored_payer = agreement.payer_address.ok_or(FlintError::NotFunded)?;
        require_keys_eq!(stored_payer, payer_key, FlintError::PayerOnly);

        // Row 3: expiry is read from the Clock sysvar, never from an argument.
        require!(
            Clock::get()?.unix_timestamp < agreement.expires_at,
            FlintError::Expired
        );

        // Section 4.3: the single condition type the program can verify. A
        // free-text description never gates anything.
        require!(
            matches!(
                agreement.condition.condition_type,
                ConditionType::ManualConfirmation
            ),
            FlintError::UnsupportedConditionType
        );

        // Rows 2 and 5: the escrow is pinned to the stored address/mint/authority,
        // and the payout is pinned to the stored recipient and the stored asset.
        check_escrow_account(agreement, &ctx.accounts.escrow_token_account)?;
        check_owned_by(
            &ctx.accounts.recipient_token_account,
            &agreement.recipient_address,
            &agreement.asset,
            FlintError::TokenAccountOwnerMismatch,
        )?;

        // `disputed_flag` is deliberately never consulted here: it is advisory
        // and must not block release (Section 4.2).

        (agreement.amount, agreement.recipient_address, bump)
    };

    // ---- move the full amount out of escrow to the stored recipient ----
    // The escrow ATA's authority is the agreement PDA (Section 4.5), so this is
    // the only place the funds can be signed out, and only with these seeds.
    let id_bytes = ctx.accounts.agreement.id;
    let recipient_bytes = recipient_address.to_bytes();
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
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.agreement.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    // ---- funded -> released, terminal (Section 4.2) ----
    let agreement = &mut ctx.accounts.agreement;
    agreement.status = AgreementStatus::Released;
    // `receipt_proof` is NOT written here (and nowhere else): the receipt is this
    // settlement transaction's signature, which a program cannot read. The client
    // captures it and the verification page checks it against the chain — the
    // property Section 4.4 actually requires. Flagged to the human in the Phase 1
    // report so the schema question can be settled deliberately.

    Ok(())
}
