/**
 * The protocol fee table, mirrored from the program.
 *
 * `programs/flint-escrow/src/fees.rs` is the authority: this file exists so the
 * UI can *show* what a payment costs before anyone signs. A client that quoted a
 * different fee from the program would be a lie about a payment's price, so the
 * two tables are kept in lockstep by a test (`tests/agent/fees.test.ts`) that
 * checks every band boundary against the program's own values — not against this
 * file's expectations.
 *
 * The fee is quoted in whole tokens (1 token = 1 dollar for an approved stable
 * mint) and deducted from the recipient's payout, so the payer always pays exactly
 * the agreed amount. It is locked onto the agreement at creation: what the UI
 * quotes at creation is what the agreement carries, whatever happens to the table
 * afterwards.
 */

/** `[lowerInclusive, upperExclusive, feeWholeTokens]`. */
export const FEE_BANDS: ReadonlyArray<readonly [bigint, bigint, bigint]> = [
  [20n, 50n, 1n],
  [50n, 100n, 2n],
  [100n, 250n, 4n],
  [250n, 500n, 8n],
  [500n, 1_000n, 15n],
  [1_000n, 2_500n, 30n],
  [2_500n, 5_000n, 60n],
  [5_000n, 10_000n, 100n],
] as const;

/** At or above this, the fee is a percentage of the amount. */
export const FEE_PERCENT_FROM = 10_000n;
/** One percent. */
export const FEE_PERCENT_NUMERATOR = 1n;
export const FEE_PERCENT_DENOMINATOR = 100n;

/** Smallest agreement the protocol accepts, in whole tokens. */
export const MIN_AGREEMENT_WHOLE_TOKENS = 20n;

/**
 * The flat fee for an amount given in whole tokens.
 *
 * Total by construction, matching the program's `fee_for`: amounts below the
 * lowest band return that band's fee. Creation rejects those amounts against the
 * config minimum before a fee is ever needed.
 */
export function feeForWholeTokens(wholeTokens: bigint): bigint {
  if (wholeTokens >= FEE_PERCENT_FROM) {
    return (wholeTokens * FEE_PERCENT_NUMERATOR) / FEE_PERCENT_DENOMINATOR;
  }
  for (const [lower, upper, fee] of FEE_BANDS) {
    if (wholeTokens >= lower && wholeTokens < upper) {
      return fee;
    }
  }
  return FEE_BANDS[0][2];
}

/** 10^decimals, the multiplier every base-unit conversion needs. */
export function scaleUp(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`mint decimals out of range: ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

/**
 * The whole-token amount for a base-unit figure, flooring the remainder.
 *
 * Flooring is what makes the band boundaries exact: 49.99 tokens is in the
 * `[20, 50)` band, and 50.00 starts the next one.
 */
export function wholeTokens(amount: bigint, decimals: number): bigint {
  return amount / scaleUp(decimals);
}

/** The fee for a base-unit amount, in base units. */
export function feeBaseUnits(amount: bigint, decimals: number): bigint {
    const amountWhole = wholeTokens(amount, decimals);
    if (amountWhole < MIN_AGREEMENT_WHOLE_TOKENS) {
      throw new RangeError(
        `Agreement amount ${amountWhole} whole tokens is below the minimum of ${MIN_AGREEMENT_WHOLE_TOKENS} whole tokens`,
      );
    }
    return feeForWholeTokens(amountWhole) * scaleUp(decimals);
}

/** The recipient's share of an amount in basis points. */
export function shareOf(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 1 || bps > 9_999) {
    throw new RangeError(`split share must be 1..9999 bps, got ${bps}`);
  }
  return (amount * BigInt(bps)) / 10_000n;
}

/** The fee attributable to a basis-point share of a payout (never a refund). */
export function feeForShare(feeAmount: bigint, bps: number): bigint {
  return (feeAmount * BigInt(bps)) / 10_000n;
}