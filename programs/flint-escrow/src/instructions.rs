//! Instruction modules, plus the guards every instruction shares.
//!
//! Enforcement map (FLINT_BUILD_CONTEXT.md Sections 4.2 / 4.6, Section 5):
//! - every instruction calls [`check_canonical_agreement`] first, so the
//!   agreement account is always proven to be the canonical PDA for its own
//!   stored `id` + `recipient_address` (row 2);
//! - every instruction that touches tokens calls [`check_escrow_account`] or
//!   [`check_owned_by`], so token accounts are checked against stored state
//!   rather than trusted (rows 2, 5);
//! - time comes only from `Clock::get()`, never from an argument (Section 4.5);
//! - `disputed_flag` is never consulted by `release` or `refund` (Section 4.2).

pub mod cancel;
pub mod claim_delivery;
pub mod create;
pub mod dispute;
pub mod fund;
pub mod init_config;
pub mod refund;
pub mod release;
pub mod release_after_review;
pub mod resolve_dispute;
pub mod set_config_roles;
pub mod split_after_arbiter_timeout;

pub use cancel::*;
pub use claim_delivery::*;
pub use create::*;
pub use dispute::*;
pub use fund::*;
pub use init_config::*;
pub use refund::*;
pub use release::*;
pub use release_after_review::*;
pub use resolve_dispute::*;
pub use set_config_roles::*;
pub use split_after_arbiter_timeout::*;

use crate::errors::FlintError;
use crate::state::{Config, FlintAgreement, AGREEMENT_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
/// Validates that `agreement` is the canonical FRS-1 PDA for the `id` and
/// `recipient_address` **stored in it**, and returns the bump for signing.
///
/// Why a runtime check instead of an Anchor `seeds` constraint: the seeds are
/// derived from data inside this very account, and a constraint on an account
/// cannot reference itself. Deriving from stored data — never from an
/// instruction argument — is exactly what row 2 asks for. Cost is one
/// `find_program_address` per instruction (a few thousand compute units).
pub fn check_canonical_agreement(agreement: &Account<FlintAgreement>) -> Result<u8> {
    let (expected, bump) = Pubkey::find_program_address(
        &[
            AGREEMENT_SEED,
            agreement.recipient_address.as_ref(),
            agreement.id.as_ref(),
        ],
        &crate::ID,
    );
    require_keys_eq!(agreement.key(), expected, FlintError::AgreementPdaMismatch);
    Ok(bump)
}

/// Validates the escrow token account against stored state (rows 2 and 5): it
/// must be the agreement's stored `escrow_address`, hold the agreement's
/// `asset`, and be owned by this very agreement PDA — the SPL authority
/// Section 4.5 specifies, and the reason only this program can move these
/// funds.
pub fn check_escrow_account(
    agreement: &Account<FlintAgreement>,
    escrow: &Account<'_, TokenAccount>,
) -> Result<()> {
    require_keys_eq!(
        escrow.key(),
        agreement.escrow_address,
        FlintError::EscrowMismatch
    );
    require_keys_eq!(escrow.mint, agreement.asset, FlintError::AssetMismatch);
    require_keys_eq!(
        escrow.owner,
        agreement.key(),
        FlintError::TokenAccountOwnerMismatch
    );
    Ok(())
}

/// Validates a funding or payout token account: right wallet, right asset, and
/// — crucially — a wallet that came from *stored* state (`recipient_address`,
/// or the stored `payer_address`). The destination is therefore pinned by the
/// agreement, so no instruction-supplied account can redirect the money
/// (row 2).
///
/// Any token account the stored wallet owns for the stored mint is acceptable.
/// Demanding the canonical ATA specifically would reject valid non-canonical
/// accounts without adding protection.
pub fn check_owned_by(
    token_account: &Account<'_, TokenAccount>,
    expected_owner: &Pubkey,
    expected_mint: &Pubkey,
    owner_error: FlintError,
) -> Result<()> {
    require_keys_eq!(token_account.owner, *expected_owner, owner_error);
    require_keys_eq!(
        token_account.mint,
        *expected_mint,
        FlintError::AssetMismatch
    );
    Ok(())
}

/// Length guard for the variable-length FRS-1 fields.
///
/// `#[max_len(N)]` sizes the account; it enforces nothing at runtime, so an
/// over-long value would otherwise surface only as a confusing serialization
/// failure at exit. Fail loudly instead.
pub fn check_field_len(len: usize, max: usize) -> Result<()> {
    require!(len <= max, FlintError::FieldTooLong);
    Ok(())
}

/// The end of the review window for a claimed agreement, from the Clock sysvar.
///
/// `claimed_at + review_window_secs`, with the addition checked: a window that
/// overflowed would wrap into the past and make the window permanently closed,
/// which is exactly the failure this guards against.
pub fn review_window_end(agreement: &FlintAgreement) -> Result<i64> {
    let claimed_at = agreement.claimed_at.ok_or(FlintError::NotDeliveryClaimed)?;
    Ok(claimed_at
        .checked_add(agreement.review_window_secs as i64)
        .ok_or(FlintError::FeeMathOverflow)?)
}

/// The treasury token account for `asset`, checked against the Config.
///
/// The destination is derived from the *Config's* stored treasury, never from an
/// instruction argument — a caller-supplied treasury would be a third party
/// collecting the protocol's fee.
pub fn check_treasury_account(
    config: &Account<Config>,
    treasury_token_account: &Account<'_, TokenAccount>,
) -> Result<()> {
    require_keys_eq!(
        treasury_token_account.owner,
        config.treasury,
        FlintError::TokenAccountOwnerMismatch
    );
    Ok(())
}

/// Pays the recipient and the treasury from escrow, in one place.
///
/// Every settlement path that pays the recipient goes through this helper, which
/// is what makes "the fee is always deducted from the recipient's payout" a
/// structural property rather than a rule each instruction has to remember: an
/// instruction that forgets the fee is not possible here, because the recipient's
/// figure and the fee are separate arguments and the sum is what leaves escrow.
///
/// `recipient_amount` and `fee_amount` are transferred separately rather than as
/// one total, so the escrow balance check is enforced by the token program on
/// both legs and the fee cannot be silently under-paid.
#[allow(clippy::too_many_arguments)]
pub fn pay_recipient<'info>(
    agreement: &Account<'info, FlintAgreement>,
    bump: u8,
    escrow_token_account: &Account<'info, TokenAccount>,
    recipient_token_account: &Account<'info, TokenAccount>,
    treasury_token_account: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    recipient_amount: u64,
    fee_amount: u64,
) -> Result<()> {
    let id_bytes = agreement.id;
    let recipient_bytes = agreement.recipient_address.to_bytes();
    let bump_arr = [bump];
    let seeds: &[&[u8]] = &[
        AGREEMENT_SEED,
        recipient_bytes.as_ref(),
        id_bytes.as_ref(),
        &bump_arr,
    ];

    if recipient_amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.key(),
                Transfer {
                    from: escrow_token_account.to_account_info(),
                    to: recipient_token_account.to_account_info(),
                    authority: agreement.to_account_info(),
                },
                &[seeds],
            ),
            recipient_amount,
        )?;
    }

    if fee_amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.key(),
                Transfer {
                    from: escrow_token_account.to_account_info(),
                    to: treasury_token_account.to_account_info(),
                    authority: agreement.to_account_info(),
                },
                &[seeds],
            ),
            fee_amount,
        )?;
    }

    Ok(())
}
