//! Protocol fee table.
//!
//! One flat fee per amount band, quoted in **whole tokens** (1 token = 1 dollar
//! for an approved stable mint), taken out of the recipient's payout so the
//! payer always pays exactly the agreed amount. The band boundaries include
//! their lower bound: `[lower, upper)`.
//!
//! The top band is one percent of the amount rather than a flat fee, so the
//! protocol does not get cheaper as a percentage of larger payments.
//!
//! `fee_for` is mirrored by the TypeScript client in `app/lib/fees.ts` from this
//! same table, and `fee_boundaries_are_exact` in the test suite checks the two
//! agree at every boundary — a client that quoted a different fee from the
//! program would be a silent lie about what a payment costs.
//!
//! Sizing: this table works in whole tokens. Base-unit amounts are scaled in and
//! out by [`scale_up`] / [`scaled_fee_base_units`] using the mint's decimals,
//! so a fee of "2" on a 6-decimal mint is 2_000_000 base units.

use crate::errors::FlintError;
use anchor_lang::prelude::*;

/// Fee bands as `(lower_inclusive, upper_exclusive, fee_whole_tokens)`.
///
/// Amounts at or above [`FEE_PERCENT_FROM`] use [`FEE_PERCENT_NUMERATOR`] /
/// [`FEE_PERCENT_DENOMINATOR`] of the amount instead of a flat fee.
pub const FEE_BANDS: &[(u64, u64, u64)] = &[
    (20, 50, 1),
    (50, 100, 2),
    (100, 250, 4),
    (250, 500, 8),
    (500, 1_000, 15),
    (1_000, 2_500, 30),
    (2_500, 5_000, 60),
    (5_000, 10_000, 100),
];

/// Amount (whole tokens) at which the fee becomes a percentage.
pub const FEE_PERCENT_FROM: u64 = 10_000;
/// One percent: numerator / denominator.
pub const FEE_PERCENT_NUMERATOR: u64 = 1;
pub const FEE_PERCENT_DENOMINATOR: u64 = 100;

/// The flat fee for an amount given in whole tokens.
///
/// Total by construction: amounts below the lowest band return that band's fee.
/// `create` rejects those amounts against the config's minimum before a fee is
/// ever needed, so the value there is unreachable in practice — but a fee
/// function that could panic on an unexpected input would be a worse bug than a
/// conservative one.
pub fn fee_for(whole_tokens: u64) -> u64 {
    if whole_tokens >= FEE_PERCENT_FROM {
        // checked_mul then checked_div: an amount that overflows the multiply is
        // rejected rather than wrapping into a small fee.
        return whole_tokens
            .checked_mul(FEE_PERCENT_NUMERATOR)
            .and_then(|scaled| scaled.checked_div(FEE_PERCENT_DENOMINATOR))
            .unwrap_or(u64::MAX);
    }
    for (lower, upper, fee) in FEE_BANDS {
        if whole_tokens >= *lower && whole_tokens < *upper {
            return *fee;
        }
    }
    FEE_BANDS[0].2
}

/// 10^decimals, checked. The multiplier every base-unit conversion needs.
pub fn scale_up(decimals: u8) -> Result<u64> {
    Ok(10u64
        .checked_pow(decimals as u32)
        .ok_or(FlintError::FeeMathOverflow)?)
}

/// The whole-token amount for a base-unit figure, flooring the remainder.
///
/// Flooring is what makes the band boundaries exact: 49.99 tokens is in the
/// `[20, 50)` band, and 50.00 starts the next one.
pub fn whole_tokens(amount: u64, decimals: u8) -> Result<u64> {
    let scale = scale_up(decimals)?;
    Ok(amount / scale)
}

/// The fee for a base-unit amount, in base units — the figure that is actually
/// locked on the agreement at creation.
pub fn scaled_fee_base_units(amount: u64, decimals: u8) -> Result<u64> {
    let scale = scale_up(decimals)?;
    let fee_whole = fee_for(whole_tokens(amount, decimals)?);
    Ok(fee_whole
        .checked_mul(scale)
        .ok_or(FlintError::FeeMathOverflow)?)
}

/// The recipient's share of an amount in basis points, checked.
///
/// Used by both split paths. `recipient_bps` is validated to 1..=9999 by the
/// caller (a 0 or 10000 split is not a split, it is a release or a refund).
pub fn share_of(amount: u64, bps: u16) -> Result<u64> {
    require!((1..9_999).contains(&bps), FlintError::SplitShareOutOfRange);
    let scaled = amount
        .checked_mul(bps as u64)
        .ok_or(FlintError::FeeMathOverflow)?;
    Ok(scaled / 10_000)
}

/// The fee attributable to a basis-point share of a payout.
///
/// On a split the fee follows the recipient's share, because the fee exists to
/// cover a completed payout to the recipient: splitting the escrow in half
/// performs half a payout, and charging the full fee for it would take money the
/// recipient never earned. A refund is never charged at all.
pub fn fee_for_share(fee_amount: u64, bps: u16) -> Result<u64> {
    let scaled = fee_amount
        .checked_mul(bps as u64)
        .ok_or(FlintError::FeeMathOverflow)?;
    Ok(scaled / 10_000)
}
