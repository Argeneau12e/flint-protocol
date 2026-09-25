//! Program error namespace.
//!
//! One variant per state-machine rule (Sections 4.2 / 4.6) and per Section 5
//! threat-model invariant the program enforces, with the mapping named on each
//! variant so a reviewer can check code against spec without guessing.
//!
//! Only variants that are actually returned are listed: an error no code path
//! can produce is a claim about protection that does not exist.

use anchor_lang::prelude::*;

#[error_code]
pub enum FlintError {
    // ---- Authority (Section 4.2, threat-model row 1) ----

    /// `cancel` and `flag_dispute` are recipient-only: there is no payer on a
    /// pending agreement, and no one else may act for the recipient.
    #[msg("Only the agreement's recipient can perform this action.")]
    RecipientOnly,

    /// `release` is payer-only, and "the payer" means the *stored* address.
    #[msg("Only the agreement's stored payerAddress can release it.")]
    PayerOnly,

    // ---- State machine (Section 4.2 / 4.6, threat-model row 4) ----

    #[msg("This agreement is not pending.")]
    NotPending,

    #[msg("This agreement is not funded.")]
    NotFunded,

    /// `flag_dispute` applies to a funded agreement only (Section 4.6).
    #[msg("The dispute flag applies only to a funded agreement; pending and settled agreements are not disputable.")]
    NotDisputable,

    // ---- Expiry (Section 4.2 row 3, Section 4.6) ----

    #[msg("expiresAt must be strictly in the future when the agreement is created.")]
    ExpiryNotInFuture,

    #[msg("This agreement expired before it was funded, so it could never be released.")]
    ExpiredBeforeFunding,

    #[msg("This agreement has expired — only refund remains valid.")]
    Expired,

    #[msg("This agreement has not expired yet; it cannot be refunded.")]
    NotYetExpired,

    // ---- Input validation (Section 4.3, Section 4.6 field bounds) ----

    #[msg("The amount must be greater than zero.")]
    ZeroAmount,

    #[msg("v1 enforces only the manual-confirmation condition; oracle-attested is not implemented.")]
    UnsupportedConditionType,

    #[msg("A field exceeds its FRS-1 length bound (Section 4.6).")]
    FieldTooLong,

    // ---- Account integrity (Section 5 rows 2 and 5) ----

    #[msg("The agreement account is not the canonical PDA for its stored id and recipientAddress.")]
    AgreementPdaMismatch,

    #[msg("The provided token account is not the agreement's stored escrowAddress.")]
    EscrowMismatch,

    #[msg("The token account's mint does not match the agreement's asset.")]
    AssetMismatch,

    #[msg("The token account's owner does not match the wallet the agreement requires.")]
    TokenAccountOwnerMismatch,

    #[msg("The funder's token account is not owned by the funding signer.")]
    FunderTokenAccountMismatch,
}
