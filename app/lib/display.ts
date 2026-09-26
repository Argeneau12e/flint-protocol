/**
 * Display-only money formatting (Section 4.5).
 *
 * The rule this module exists to protect: `amount` is `u64` base units, always,
 * and a JS `number` loses precision above 2^53. So every conversion here is
 * `BigInt` arithmetic on decimal strings, and the UI's decimal value is only ever
 * produced *from* the string — never parsed into a float and re-serialised back.
 *
 * Split into two halves by design:
 *   - `parseDisplayAmount` runs in the **browser** (validating what a person
 *     typed, with an explanation for every rejection);
 *   - `formatBaseUnits` runs on **both** sides (the Blink description, the page,
 *     and the tests all render the same figure the same way).
 *
 * `decimals` is a display-only lookup from the mint. Nothing on chain stores it
 * and no program check reads it — the authoritative value is always the base
 * unit integer, which is why `formatBaseUnits` falls back to raw base units when
 * the mint cannot be read rather than guessing a scale.
 */

/** The largest value `u64` can hold, as a BigInt. */
const U64_MAX = 18446744073709551615n;

/** Renders base units as a human figure, exactly and without float rounding. */
export function formatBaseUnits(baseUnits: string, decimals: number): string {
  if (!/^\d+$/.test(baseUnits)) return baseUnits;
  const value = BigInt(baseUnits);
  if (decimals <= 0) return value.toString();

  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** Both figures at once, for a place where the exactness is the point. */
export function amountLabel(baseUnits: string, decimals: number, symbol: string): string {
  return `${formatBaseUnits(baseUnits, decimals)} ${symbol}`;
}

export type ParsedAmount =
  | { ok: true; baseUnits: string }
  | { ok: false; error: string };

/**
 * Converts what a person typed into exact base units.
 *
 * Every rejection explains *why*, per Section 9 — "invalid" tells a person
 * nothing about which of five things to change. A trailing dot is accepted
 * because `1.` is a normal thing to type mid-entry; an exponent is not, because
 * `1e6` and `1000000` are the same number to a human and different integers on
 * chain, which is exactly the class of ambiguity base units exist to remove.
 */
export function parseDisplayAmount(input: string, decimals: number): ParsedAmount {
  const raw = input.trim();
  if (raw === "") {
    return { ok: false, error: "Enter an amount." };
  }
  if (/[eE]/.test(raw)) {
    return {
      ok: false,
      error:
        "Use plain digits, not exponent notation — 1e6 and 1000000 are the same to a person and different integers on chain.",
    };
  }
  if (/[+\-]/.test(raw)) {
    return {
      ok: false,
      error: "An amount has to be positive. To charge less, the recipient changes the terms before funding.",
    };
  }
  if (!/^\d*\.?\d*$/.test(raw) || !/\d/.test(raw)) {
    return {
      ok: false,
      error: "Use digits and at most one decimal point, for example 12.50.",
    };
  }

  const [wholeRaw, fractionRaw = ""] = raw.split(".");
  const whole = wholeRaw === "" ? "0" : wholeRaw;
  if (fractionRaw.length > decimals) {
    return {
      ok: false,
      error:
        decimals === 0
          ? "This asset has no decimal places, so the amount must be a whole number."
          : `This asset has ${decimals} decimal places, so at most ${decimals} are allowed — ${fractionRaw.length} were given.`,
    };
  }

  // The fraction is a *fraction of the last base unit*, so it has to be padded on
  // the LEFT to the asset's scale: with 6 decimals, "5" is 500000 base units, not
  // 5. Reading it as a plain integer is the classic off-by-a-lot bug here — it
  // turns 2.5 into 2000005 and would silently escrow the wrong amount.
  const fraction = fractionRaw.padEnd(decimals, "0");
  const baseUnits =
    decimals === 0
      ? BigInt(whole)
      : BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction === "" ? "0" : fraction);
  if (baseUnits <= 0n) {
    return { ok: false, error: "The amount has to be greater than zero." };
  }
  if (baseUnits > U64_MAX) {
    return { ok: false, error: "That amount is larger than the protocol can represent." };
  }
  return { ok: true, baseUnits: baseUnits.toString() };
}
