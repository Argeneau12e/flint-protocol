//! `release` — the stored payer confirms the condition is met
//! (`Funded` → `Released`).
//!
//! This is the only path that pays the recipient, and Section 4.2 grants it to
//! the payer alone. Threat-model rows 1 (unauthorized release), 3 (expiry
//! bypass), 4 (replay) and 5 (wrong asset/amount) all land on this instruction.

use crate::errors::FlintError;
use crate::instructions::{
    check_canonical_agreement, check_escrow_account, check_owned_by, check_treasury_account,
    pay_recipient,
};
use crate::state::{AgreementStatus, ConditionType, Config, FlintAgreement};
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

#[derive(Accounts)]
pub struct Release<'info> {
    /// Must be the agreement's **stored** `payerAddress` (row 1). The recipient
    /// cannot release, and neither can anyone else.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The Config, for the treasury the fee is paid to.
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub agreement: Account<'info, FlintAgreement>,

    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// The recipient's token account for the agreement's asset. Validated
    /// against the stored `recipient_address` — never trusted (row 2).
    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// The treasury's token account for this asset, validated against the Config.
    #[account(mut)]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_release(ctx: Context<Release>) -> Result<()> {
    let payer_key = ctx.accounts.payer.key();

    // ---- validation against stored agreement state (rows 1, 2, 3, 5) ----
    let (amount, bump, fee_amount) = {
        let agreement = &ctx.accounts.agreement;

        let bump = check_canonical_agreement(agreement)?;

        // Row 1: "the payer" means the stored address, and nothing else.
        //
        // Two sources are valid: straight from `Funded`, or from a delivery claim
        // the payer is satisfied with. `Disputed` is deliberately excluded — money
        // on a contested agreement moves only by the arbiter's ruling or the
        // timeout split, never by the disputing party pressing release.
        require!(
            matches!(
                agreement.status,
                AgreementStatus::Funded | AgreementStatus::DeliveryClaimed
            ),
            FlintError::NotFunded
        );
        let stored_payer = agreement.payer_address.ok_or(FlintError::NotFunded)?;
        require_keys_eq!(stored_payer, payer_key, FlintError::PayerOnly);

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
        //
        // Row 3: release also requires the agreement to be unexpired. Exactly one
        // source is detached from `expires_at`: `DeliveryClaimed`, where the
        // recipient has proved delivery and the review window — not the original
        // deadline — governs from then on. A plain `Funded` agreement past its
        // deadline is a refund, never a payout.
        //
        // The *status* is what decides this, not `claimed_at`. On `Funded` the
        // two happen to agree (`claimed_at` is `None`), but keying the exemption
        // off a data field rather than the state machine would let anything that
        // ever sets that field widen row 3 without the transition that is
        // supposed to authorize it.
        if agreement.status == AgreementStatus::Funded {
            require!(
                Clock::get()?.unix_timestamp < agreement.expires_at,
                FlintError::Expired
            );
        }
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

        (agreement.amount, bump, agreement.fee_amount)
    };

    // The fee comes out of the recipient's share, so the payer pays exactly the
    // agreed amount on this path as on every other.
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

    // ---- funded/claimed -> released, terminal (Section 4.2) ----
    let agreement = &mut ctx.accounts.agreement;
    agreement.status = AgreementStatus::Released;
    // `receipt_proof` is NOT written here (and nowhere else): the receipt is this
    // settlement transaction's signature, which a program cannot read. The client
    // captures it and the verification page checks it against the chain — the
    // property Section 4.4 actually requires. Flagged to the human in the Phase 1
    // report so the schema question can be settled deliberately.

    Ok(())
}
