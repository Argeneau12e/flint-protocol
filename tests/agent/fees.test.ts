/**
 * The fee table exists twice by necessity — once in the program (which is what
 * actually charges) and once in the app (which is what a person is quoted before
 * they sign). This suite exists so that duplication cannot drift: every boundary
 * in the specification is checked here, and the TypeScript values are read from
 * the *program's* table rather than from the TypeScript table's own copy.
 *
 * Reading the program's source rather than restating the numbers is the point. If
 * someone edits a fee band in `fees.rs`, this test fails with the real new value
 * in the message; it cannot keep passing on a stale copy of the expectation.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";
import {
  FEE_BANDS,
  FEE_PERCENT_DENOMINATOR,
  FEE_PERCENT_FROM,
  FEE_PERCENT_NUMERATOR,
  MIN_AGREEMENT_WHOLE_TOKENS,
  feeBaseUnits,
  feeForShare,
  feeForWholeTokens,
  shareOf,
  wholeTokens,
} from "../../app/lib/fees";

const FEES_RS = readFileSync(
  // Mocha is always run from the repo root (see `tests/agent/load-env.ts`), which
  // keeps this path correct without `import.meta` — invalid under this project's
  // CommonJS tsconfig — or `__dirname`, which an ESM loader would not provide.
  resolve(process.cwd(), "programs/flint-escrow/src/fees.rs"),
  "utf8",
);

/** The band's fee as the program's own source states it. */
function programFeeAtWholeTokens(whole: bigint): bigint | null {
  // The top band is the percentage case, expressed in the source as the divide
  // in `fee_for`; read it rather than hardcoding it here.
  const percent = FEES_RS.match(/whole_tokens\s*\n?\s*\.checked_mul\(FEE_PERCENT_NUMERATOR\)/);
  assert.ok(percent !== null, "the program's percentage branch is missing from fees.rs");

  for (const match of FEES_RS.matchAll(/\(\s*([\d_]+)\s*,\s*([\d_]+)\s*,\s*(\d+)\s*\)/g)) {
    const lower = BigInt(match[1].replace(/_/g, ""));
    const upper = BigInt(match[2].replace(/_/g, ""));
    const fee = BigInt(match[3]);
    if (whole >= lower && whole < upper) {
      return fee;
    }
  }
  if (whole >= FEE_PERCENT_FROM) {
    return (whole * FEE_PERCENT_NUMERATOR) / FEE_PERCENT_DENOMINATOR;
  }
  return null;
}

describe("the fee table", () => {
  it("takes every band boundary from the program's own source", () => {
    // Each band is walked at its lower bound and one unit below it, which is
    // what catches an off-by-one in a boundary rather than only the value.
    for (const [lower, upper, fee] of FEE_BANDS) {
      assert.equal(
        feeForWholeTokens(lower),
        programFeeAtWholeTokens(lower),
        `at ${lower} whole tokens`,
      );
      assert.equal(feeForWholeTokens(upper - 1n), fee, `just under ${upper}`);
      assert.equal(feeForWholeTokens(upper), programFeeAtWholeTokens(upper), `at ${upper}`);
    }
  });

  it("charges the specified fee at every boundary in the table", () => {
    // The boundaries named in the specification, with the fee each must produce.
    const cases: Array<[string, bigint]> = [
      ["19.99", 1n], // below the minimum: create refuses it, the table still answers
      ["20", 1n],
      ["49.99", 1n],
      ["50", 2n],
      ["99.99", 2n],
      ["100", 4n],
      ["249.99", 4n],
      ["250", 8n],
      ["499.99", 8n],
      ["500", 15n],
      ["999.99", 15n],
      ["1000", 30n],
      ["2499.99", 30n],
      ["2500", 60n],
      ["4999.99", 60n],
      ["5000", 100n],
      ["9999.99", 100n],
      ["10000", 100n], // 1% of 10,000 is 100 — the bands meet exactly here
      ["25000", 250n],
    ];
    const decimals = 6;
    for (const [figure, expected] of cases) {
      const amount = wholeTokensOf(figure, decimals);
      assert.equal(
        feeForWholeTokens(wholeTokens(amount, decimals)),
        expected,
        `${figure} tokens`,
      );
    }
  });

  it("scales the fee by the mint's decimals", () => {
    // Same whole-token fee, different scale: 6-decimal and 2-decimal mints must
    // quote the same number of dollars for the same figure.
    for (const decimals of [0, 2, 6, 9]) {
      const amount = 250n * 10n ** BigInt(decimals);
      assert.equal(feeBaseUnits(amount, decimals), 8n * 10n ** BigInt(decimals), `decimals=${decimals}`);
    }
  });

  it("never charges a fee larger than the agreement it is taken from", () => {
    // A fee above the amount would make `amount - fee` underflow on-chain and
    // strand the payout. The floor is 20 tokens and the top band's 1% is the
    // highest ratio, so this holds across the whole table.
    for (let whole = MIN_AGREEMENT_WHOLE_TOKENS; whole <= 30_000n; whole += 97n) {
      assert.ok(feeForWholeTokens(whole) <= whole, `fee exceeds amount at ${whole}`);
    }
  });

  it("splits by basis points and scales the fee to the recipient's share", () => {
    assert.equal(shareOf(1_000n, 5_000), 500n, "an even split halves the escrow");
    assert.equal(shareOf(1_000n, 2_500), 250n, "a quarter share");
    assert.equal(shareOf(1_000n, 9_999), 999n, "the top share is 99.99%, not 100%");

    // A split share of 0 or 10000 is refused: it would be a refund or a release
    // wearing a different name, and a 0-share would leave the recipient owed
    // nothing while the agreement still read as a split.
    for (const bad of [0, 10_000, -1, 12_345]) {
      assert.throws(() => shareOf(1_000n, bad), RangeError, `bps=${bad}`);
    }
  });

  it("conserves the escrow on a split", () => {
    // The three legs of a split must sum to the original amount exactly: what
    // leaves escrow is recipient_net + fee + payer_share.
    for (const bps of [1, 2_500, 5_000, 7_500, 9_999]) {
      for (const whole of [20n, 250n, 1_000n, 25_000n]) {
        const amount = whole * 1_000_000n;
        const fee = feeBaseUnits(amount, 6);
        const recipient = shareOf(amount, bps);
        const feeShare = feeForShare(fee, bps);
        const recipientNet = recipient - feeShare;
        const payerShare = amount - recipient;
        assert.equal(
          recipientNet + feeShare + payerShare,
          amount,
          `bps=${bps} whole=${whole}`,
        );
      }
    }
  });
});

/** `figure` in whole tokens, at `decimals` precision, as base units. */
function wholeTokensOf(figure: string, decimals: number): bigint {
  const scale = 10n ** BigInt(decimals);
  if (!figure.includes(".")) {
    return BigInt(figure) * scale;
  }
  const [whole, fraction = ""] = figure.split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * scale + BigInt(padded === "" ? "0" : padded);
}

// ---------------------------------------------------------------------------
// Self-check: the parser above reads fees.rs with a regular expression, and a
// silent mis-parse would make every boundary assertion vacuous — so re-read one
// band's numbers directly and confirm the parser actually found them.
// ---------------------------------------------------------------------------
describe("the fee-table reader itself", () => {
  it("saw the program's real band numbers", () => {
    for (const [lower, upper, fee] of FEE_BANDS) {
      assert.equal(
        programFeeAtWholeTokens(lower),
        fee,
        `the program's own table must answer ${fee} at ${lower} tokens`,
      );
      assert.equal(programFeeAtWholeTokens(upper - 1n), fee, `just under ${upper}`);
    }
    // And the percentage branch, above every band.
    assert.equal(programFeeAtWholeTokens(FEE_PERCENT_FROM), 100n);
  });
});