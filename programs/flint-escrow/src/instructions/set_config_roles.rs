use crate::errors::FlintError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetConfigRoles<'info> {
    /// Must be the Config's stored admin (row 1).
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

/// Rotates the treasury and/or the arbiter.
///
/// Admin-only, and deliberately limited to those two roles plus the arbiter
/// timeout. The minimum is *not* rotatable: it is the floor the fee table assumes,
/// so lowering it would let agreements exist that cannot pay for their own
/// settlement, and raising it after agreements exist would retroactively
/// invalidate them.
///
/// `None` leaves a role unchanged, so one field can be rotated without touching
/// the other — the case that actually happens (a compromised arbiter wallet is
/// replaced while the treasury stays put).
pub fn handle_set_config_roles(
    ctx: Context<SetConfigRoles>,
    new_treasury: Option<Pubkey>,
    new_arbiter: Option<Pubkey>,
    new_arbiter_timeout_secs: Option<u64>,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.admin.key(),
        ctx.accounts.config.admin,
        FlintError::ConfigAdminOnly
    );

    if let Some(treasury) = new_treasury {
        require!(treasury != Pubkey::default(), FlintError::ZeroAddress);
        ctx.accounts.config.treasury = treasury;
    }
    if let Some(arbiter) = new_arbiter {
        require!(arbiter != Pubkey::default(), FlintError::ZeroAddress);
        ctx.accounts.config.arbiter = arbiter;
    }
    if let Some(timeout) = new_arbiter_timeout_secs {
        require!(timeout > 0, FlintError::ArbiterTimeoutZero);
        ctx.accounts.config.arbiter_timeout_secs = timeout;
    }

    Ok(())
}
