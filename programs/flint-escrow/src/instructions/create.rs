//! `create` — the recipient proposes an FRS-1 agreement (no state → `Pending`).
//!
//! Authority (Section 4.5): the recipient signs and defines the terms. No payer
//! exists yet, and none can be named, because whoever funds it first becomes the
//! payer. Deliberately the same shape for both flagship flows: the freelancer
//! shares a Blink, the priced endpoint issues a 402 payload, and neither needs
//! to know the payer in advance.

use crate::errors::FlintError;
use crate::instructions::check_field_len;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
#[instruction(id: [u8; 16])]
pub struct Create<'info> {
    /// The proposer: pays for both new accounts and signs the terms.
    #[account(mut)]
    pub recipient: Signer<'info>,

    #[account(
        init,
        payer = recipient,
        space = 8 + FlintAgreement::INIT_SPACE,
        seeds = [AGREEMENT_SEED, recipient.key().as_ref(), id.as_ref()],
        bump,
    )]
    pub agreement: Account<'info, FlintAgreement>,

    /// The SPL mint the agreement is denominated in (FRS-1 `asset`).
    pub asset: Account<'info, Mint>,

    /// The escrow token account. Section 4.5: a separate ATA from the PDA, owned
    /// (as an SPL account) by the agreement PDA — which is why only this program
    /// can move what goes into it.
    #[account(
        init,
        payer = recipient,
        associated_token::mint = asset,
        associated_token::authority = agreement,
    )]
    pub escrow_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create(
    ctx: Context<Create>,
    id: [u8; 16],
    amount: u64,
    expires_at: i64,
    condition_type: ConditionType,
    condition_description: String,
    title: String,
    memo: String,
    handle: Option<String>,
    agent_policy: Option<AgentPolicy>,
) -> Result<()> {
    // Section 4.6: an agreement is created with a strictly future expiry.
    let now = Clock::get()?.unix_timestamp;
    require!(expires_at > now, FlintError::ExpiryNotInFuture);

    // A zero-amount agreement would "settle" while moving nothing yet still look
    // like a paid agreement. Refuse it outright.
    require!(amount > 0, FlintError::ZeroAmount);

    // Section 4.3: v1 enforces exactly one condition type. Rejecting the
    // unimplemented one here — not only at release — follows Section 4.6's own
    // reasoning: never allow an agreement to exist that can never be released.
    require!(
        matches!(condition_type, ConditionType::ManualConfirmation),
        FlintError::UnsupportedConditionType
    );

    // Section 4.6 field bounds.
    check_field_len(title.len(), MAX_TITLE_LEN)?;
    check_field_len(memo.len(), MAX_MEMO_LEN)?;
    check_field_len(
        condition_description.len(),
        MAX_CONDITION_DESCRIPTION_LEN,
    )?;
    if let Some(handle) = &handle {
        check_field_len(handle.len(), MAX_HANDLE_LEN)?;
    }
    if let Some(policy) = &agent_policy {
        check_field_len(policy.allowlist.len(), MAX_ALLOWLIST_LEN)?;
    }

    let agreement = &mut ctx.accounts.agreement;
    agreement.id = id;
    // No payer yet: only `fund` may ever set this, and only once (Section 4.2).
    agreement.payer_address = None;
    agreement.recipient_address = ctx.accounts.recipient.key();
    agreement.title = title;
    agreement.amount = amount;
    agreement.asset = ctx.accounts.asset.key();
    agreement.escrow_address = ctx.accounts.escrow_ata.key();
    agreement.memo = memo;
    agreement.expires_at = expires_at;
    agreement.status = AgreementStatus::Pending;
    agreement.condition = Condition {
        condition_type,
        description: condition_description,
    };
    agreement.disputed_flag = false;
    agreement.disputed_at = None;
    agreement.handle = handle;
    agreement.agent_policy = agent_policy;
    // `receipt_proof` stays None for the whole life of the agreement: a program
    // cannot read its own transaction signature, so the settlement signature is
    // captured off-chain and checked against the chain (Sections 4.4 and 6.2).
    agreement.receipt_proof = None;

    Ok(())
}
