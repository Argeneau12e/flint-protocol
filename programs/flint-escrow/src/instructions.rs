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
pub mod create;
pub mod flag_dispute;
pub mod fund;
pub mod refund;
pub mod release;

// Anchor's `#[program]` macro resolves each instruction's generated
// `__client_accounts_*` types at the crate root, so the Accounts structs are
// flattened up through this module and re-exported by `lib.rs`.
pub use cancel::*;
pub use create::*;
pub use flag_dispute::*;
pub use fund::*;
pub use refund::*;
pub use release::*;

use crate::errors::FlintError;
use crate::state::{FlintAgreement, AGREEMENT_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

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
    require_keys_eq!(token_account.mint, *expected_mint, FlintError::AssetMismatch);
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
