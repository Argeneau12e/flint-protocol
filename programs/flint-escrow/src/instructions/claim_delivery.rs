//! `claim_delivery` — the recipient asserts delivery and commits to evidence
//! (`Funded` → `DeliveryClaimed`).
//!
//! This is the instruction that makes the rest of the flow exist. It moves no
//! money: it records that the recipient believes the work is done, attaches a
//! hash and a locator a third party can check later, and opens the review window
//! in which the payer may dispute before anything is paid out.
//!
//! Two rules are load-bearing and both are checked against **stored** state, not
//! against arguments: the claimer is the agreement's stored recipient (row 1), and
//! the agreement is stored-`Funded` with no prior claim. Everything else here is
//! about what a claim may contain.

use crate::errors::FlintError;
use crate::instructions::{check_canonical_agreement, check_field_len};
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ClaimDelivery<'info> {
    /// Must be the agreement's stored recipient (row 1).
    #[account(mut)]
    pub recipient: Signer<'info>,

    #[account(mut)]
    pub agreement: Account<'info, FlintAgreement>,
}

pub fn handle_claim_delivery(
    ctx: Context<ClaimDelivery>,
    evidence_hash: [u8; 32],
    evidence_ref: String,
) -> Result<()> {
    check_canonical_agreement(&ctx.accounts.agreement)?;

    let recipient_key = ctx.accounts.recipient.key();
    let now = Clock::get()?.unix_timestamp;

    let agreement = &mut ctx.accounts.agreement;

    // Row 1: only the stored recipient may assert anything about its own work.
    require_keys_eq!(
        agreement.recipient_address,
        recipient_key,
        FlintError::ClaimRecipientOnly
    );

    // Money must be in escrow and unclaimed. `claimed_at` is the authority here
    // rather than the status alone, because it is what makes a second claim
    // impossible even if the status were ever re-read from a stale copy.
    require!(agreement.claimed_at.is_none(), FlintError::AlreadyClaimed);
    require!(
        agreement.status == AgreementStatus::Funded,
        FlintError::NotFunded
    );

    // A claim after the deadline would reopen settlement on an agreement the
    // payer is already entitled to refund. The Clock sysvar is the only time
    // source, so the caller cannot move the deadline.
    require!(now < agreement.expires_at, FlintError::ClaimAfterExpiry);

    // An all-zero hash is the "no claim" sentinel. Accepting it would open a
    // review window over a commitment to no evidence at all.
    require!(evidence_hash != [0u8; 32], FlintError::EvidenceHashEmpty);

    // A hash nobody can reach is unverifiable: the whole point is that the
    // manifest it covers is fetchable later.
    require!(
        !evidence_ref.trim().is_empty(),
        FlintError::EvidenceRefEmpty
    );
    check_field_len(evidence_ref.len(), MAX_EVIDENCE_REF_LEN)?;

    agreement.status = AgreementStatus::DeliveryClaimed;
    agreement.claimed_at = Some(now);
    agreement.evidence_hash = evidence_hash;
    agreement.evidence_ref = evidence_ref;

    Ok(())
}
