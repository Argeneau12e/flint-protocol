//! `flag_dispute` — the recipient sets or clears the advisory dispute flag
//! (`Funded` → `Funded`).
//!
//! Section 4.2: recipient only, either direction. Section 4.6: requires
//! `status == Funded` — rejected while pending (nothing to dispute) and on any
//! terminal status — and **no expiry check**, because the flag is advisory: it
//! never moves custody and must never be read as blocking the permissionless
//! refund path once `expiresAt` has passed.
//!
//! The instruction takes an explicit `disputed` value rather than toggling, so
//! repeated calls are idempotent and the flag cannot flip by accident.

use crate::errors::FlintError;
use crate::instructions::check_canonical_agreement;
use crate::state::{AgreementStatus, FlintAgreement};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct FlagDispute<'info> {
    /// The proposer: the flag is theirs to raise and clear (Section 4.2).
    pub recipient: Signer<'info>,

    #[account(mut)]
    pub agreement: Account<'info, FlintAgreement>,
}

pub fn handle_flag_dispute(ctx: Context<FlagDispute>, disputed: bool) -> Result<()> {
    let recipient_key = ctx.accounts.recipient.key();

    let now = {
        let agreement = &ctx.accounts.agreement;

        check_canonical_agreement(agreement)?;

        require_keys_eq!(
            agreement.recipient_address,
            recipient_key,
            FlintError::RecipientOnly
        );

        // Section 4.6: funded only.
        require!(
            agreement.status == AgreementStatus::Funded,
            FlintError::NotDisputable
        );

        // Deliberately NO expiry check: settable and clearable past expiry, so
        // the flag can never be mistaken for a block on refund (Section 4.6).

        Clock::get()?.unix_timestamp
    };

    // Only the two advisory fields change — never a term field (row 6).
    let agreement = &mut ctx.accounts.agreement;
    if agreement.disputed_flag != disputed {
        agreement.disputed_flag = disputed;
        // Timestamped when the flag actually changes; a repeat call is a no-op,
        // so the original dispute time is preserved.
        agreement.disputed_at = if disputed { Some(now) } else { None };
    }

    Ok(())
}
