//! `cancel` — the recipient withdraws before funding (`Pending` → `Cancelled`).
//!
//! Section 4.2: recipient only (no payer exists yet), pending only, and no funds
//! are involved. Section 4.6: the account is closed and the rent returns to the
//! recipient — safe precisely because a pending agreement never held funds and
//! never produced a receipt.

use crate::errors::FlintError;
use crate::instructions::check_canonical_agreement;
use crate::state::{AgreementStatus, FlintAgreement, AGREEMENT_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token};

#[derive(Accounts)]
pub struct Cancel<'info> {
    /// The proposer, and the only signer allowed here.
    #[account(mut)]
    pub recipient: Signer<'info>,

    /// Closed by Anchor at the end of the instruction: the rent goes back to the
    /// recipient (Section 4.6). Closing also frees the (recipient, id) pair, so
    /// a cancelled agreement can be re-proposed under the same uuid.
    #[account(mut, close = recipient)]
    pub agreement: Account<'info, FlintAgreement>,

    /// The (empty) escrow token account, closed too so its rent is not stranded
    /// and the ATA does not block a future re-proposal of the same uuid.
    ///
    /// Declared as an `AccountInfo` on purpose: the SPL `close_account` CPI
    /// deactivates the account, and Anchor re-serializing a closed
    /// `Account<'_, TokenAccount>` at exit would fail. Every property this
    /// account must have is therefore checked in the handler instead.
    ///
    /// CHECK: validated in `handle_cancel` — must be the agreement's stored
    /// `escrow_address`, owned by the SPL Token program, controlled by this
    /// agreement PDA, denominated in the stored asset, and empty — before it is
    /// closed.
    #[account(mut)]
    pub escrow_token_account: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_cancel(ctx: Context<Cancel>) -> Result<()> {
    let recipient_key = ctx.accounts.recipient.key();

    // ---- authority and state (Section 4.2) + escrow integrity (row 2) ----
    let bump = {
        let agreement = &ctx.accounts.agreement;

        let bump = check_canonical_agreement(agreement)?;

        // Recipient only: there is no payer to consult on a pending agreement.
        require_keys_eq!(
            agreement.recipient_address,
            recipient_key,
            FlintError::RecipientOnly
        );

        // Pending only. `cancel` is not an alias for `refund`, and it is not a
        // payer escape hatch: a funded agreement has no exit path before expiry
        // (an accepted v1 limitation, Section 4.2).
        require!(
            agreement.status == AgreementStatus::Pending,
            FlintError::NotPending
        );

        let escrow_info = ctx.accounts.escrow_token_account.to_account_info();
        require_keys_eq!(
            escrow_info.key(),
            agreement.escrow_address,
            FlintError::EscrowMismatch
        );
        require_keys_eq!(
            *escrow_info.owner,
            anchor_spl::token::ID,
            FlintError::EscrowMismatch
        );
        // The remaining guarantees are enforced by the SPL program itself in the
        // close CPI below, which is the authority that must enforce them:
        // - the account's owner (authority) field must be this agreement PDA —
        //   the only key signed for here — or close_account fails;
        // - close_account fails unless the token balance is zero. Cancel is
        //   pending-only, so nothing was ever deposited, and value can therefore
        //   never be discarded by this instruction;
        // - an SPL account's mint is immutable after initialisation, so the
        //   account that `create` built against `asset` still holds that mint.

        bump
    };

    // ---- return the escrow's rent to the recipient, then Anchor closes the
    //      agreement PDA to the recipient at exit ----
    let id_bytes = ctx.accounts.agreement.id;
    let recipient_bytes = ctx.accounts.agreement.recipient_address.to_bytes();
    let bump_arr = [bump];
    let seeds: &[&[u8]] = &[
        AGREEMENT_SEED,
        recipient_bytes.as_ref(),
        id_bytes.as_ref(),
        &bump_arr,
    ];

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.escrow_token_account.to_account_info(),
            destination: ctx.accounts.recipient.to_account_info(),
            authority: ctx.accounts.agreement.to_account_info(),
        },
        &[seeds],
    ))?;

    Ok(())
}
