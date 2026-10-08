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

    #[msg(
        "v1 enforces only the manual-confirmation condition; oracle-attested is not implemented."
    )]
    UnsupportedConditionType,

    #[msg("A field exceeds its FRS-1 length bound (Section 4.6).")]
    FieldTooLong,

    // ---- Account integrity (Section 5 rows 2 and 5) ----
    #[msg(
        "The agreement account is not the canonical PDA for its stored id and recipientAddress."
    )]
    AgreementPdaMismatch,

    #[msg("The provided token account is not the agreement's stored escrowAddress.")]
    EscrowMismatch,

    #[msg("The token account's mint does not match the agreement's asset.")]
    AssetMismatch,

    #[msg("The token account's owner does not match the wallet the agreement requires.")]
    TokenAccountOwnerMismatch,

    #[msg("The funder's token account is not owned by the funding signer.")]
    FunderTokenAccountMismatch,

    // ---- Delivery claim (Section 13 delivery branch) ----
    /// `claim_delivery` is recipient-only, exactly like `cancel`: delivery is
    /// something the recipient asserts about their own work.
    #[msg("Only the agreement's recipient can claim delivery.")]
    ClaimRecipientOnly,

    /// A claim is accepted only while the money is still escrowable under the
    /// original deadline. After expiry the agreement is a refund, and claiming
    /// delivery would re-open a settlement path that should be closed.
    #[msg("Delivery cannot be claimed after the agreement has expired.")]
    ClaimAfterExpiry,

    /// One claim per agreement. A second claim would overwrite the first
    /// evidence, which would let the recipient swap proof after the payer has
    /// already reviewed it.
    #[msg("This agreement already has a delivery claim; delivery may only be claimed once.")]
    AlreadyClaimed,

    /// An all-zero hash is the "no claim" sentinel, so accepting it would let a
    /// claim commit to nothing and still open the review window.
    #[msg("The evidence hash must not be all zeros.")]
    EvidenceHashEmpty,

    /// A hash with no locator is unverifiable: there would be nothing to fetch
    /// and recompute it from.
    #[msg("The evidence reference must not be empty.")]
    EvidenceRefEmpty,

    // ---- Review window (Section 13 review branch) ----
    #[msg("This agreement is not in delivery-claimed state, so there is no review window.")]
    NotDeliveryClaimed,

    #[msg("This agreement is not disputed.")]
    NotDisputed,

    /// A dispute is a one-time transition: it is what freezes the arbiter's
    /// deadline into the agreement. Letting a second dispute through would
    /// overwrite `disputed_at` / `arbiter_deadline` and silently restart the
    /// arbiter's window, so a re-dispute must be refused by name.
    #[msg("This agreement is already disputed; a dispute cannot be reopened.")]
    AlreadyDisputed,

    /// `release_after_review` is the permissionless fallback *after* the window
    /// has closed. Running it early would let anyone front-run the payer who is
    /// still entitled to dispute.
    #[msg("The review window is still open; the payer may still dispute or release.")]
    ReviewWindowOpen,

    /// A dispute is only possible while the review window is open. After it, the
    /// claim is either released (by the window expiry crank or the payer) or has
    /// been disputed.
    #[msg("The review window has closed, so this claim can no longer be disputed.")]
    ReviewWindowClosed,

    /// Arithmetic that cannot be done without overflowing or losing value is
    /// refused rather than wrapped.
    #[msg("A fee or split calculation overflowed, so it was refused rather than approximated.")]
    FeeMathOverflow,

    /// A split share of 0 or 10000 bps would be a refund or a release in
    /// disguise, and a share of 0 would leave the recipient owed nothing while
    /// still being recorded as a split.
    #[msg("A split share must be between 1 and 9999 basis points.")]
    SplitShareOutOfRange,

    #[msg("This agreement is already settled or finished.")]
    AlreadySettled,

    // ---- Config and arbiter (Section 13 config) ----
    /// The agreement is below the protocol minimum, so it could not cover the
    /// payout it performs.
    #[msg("This amount is below the protocol minimum for an agreement.")]
    BelowMinimumAmount,

    #[msg("The review window must be one of the allowed values: 6h, 12h, 24h or 48h.")]
    ReviewWindowNotAllowed,

    #[msg("Only the Config admin can rotate the treasury or arbiter.")]
    ConfigAdminOnly,

    // ---- Config bootstrap: the admin must be the upgrade authority ----
    /// The `program` account passed to `init_config` was not this program, so the
    /// authority read from it would have belonged to a different program entirely.
    #[msg("The program account must be this program.")]
    UpgradeAuthorityProgramMismatch,

    /// The `program_data` account was not this program's upgradeable-loader
    /// account, so the authority it names need not be this program's at all.
    #[msg("The program data account must be this program's ProgramData account.")]
    UpgradeAuthorityDataMismatch,

    /// Config control could be captured by anyone who signs, which is the thing
    /// binding it to the upgrade authority prevents.
    #[msg("Only the program's upgrade authority can initialize the Config.")]
    NotUpgradeAuthority,

    /// The program is immutable, so no authority address exists to compare
    /// against. Accepting an arbitrary admin here would mint a permanent,
    /// silent trust with nothing to revoke it.
    #[msg("This program has no upgrade authority, so the Config cannot be initialized.")]
    UpgradeAuthorityRevoked,

    /// The program is not loaded through the upgradeable loader, so it has no
    /// ProgramData account and no upgrade authority to check.
    #[msg("This program is not upgradeable, so the Config cannot be initialized.")]
    ProgramNotUpgradeable,

    #[msg("Only the Config arbiter can resolve a dispute.")]
    ArbiterOnly,

    /// The arbiter has not yet had its window: the timeout has not passed, so a
    /// dispute cannot be split without its arbiter's decision.
    #[msg("The arbiter timeout has not passed, so this dispute cannot be split yet.")]
    ArbiterTimeoutNotReached,

    /// A zero arbiter timeout would mean "no time to resolve, split immediately",
    /// which would make the arbiter a formality.
    #[msg("The arbiter timeout must be greater than zero.")]
    ArbiterTimeoutZero,

    /// A role that must be a real wallet was set to the all-zero address, which
    /// no wallet can ever sign for — configuring it would permanently brick the
    /// role it names.
    #[msg("This address may not be the all-zero address.")]
    ZeroAddress,
}
