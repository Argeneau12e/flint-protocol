/**
 * Solana transaction-signature shape checking (Phase 5a).
 *
 * A transaction signature is 64 bytes encoded as base58: in practice 87–88
 * characters of the base58 alphabet (which excludes `0`, `O`, `I` and `l`).
 * Checking by *decoding* rather than by a loose length regex is the point —
 * "looks about right" is what lets a malformed value through to a page that
 * then fails somewhere far from the input that caused it.
 *
 * Used in two places: the `/verify` lookup form (before it navigates) and the
 * `/verify/[tx]` page (before it touches the chain), so neither can dead-end
 * on a malformed deep link.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** The plain-language version of the check, shown as field help. */
export const SIGNATURE_SHAPE_HINT =
  "A transaction signature is 64 bytes encoded as base58 — usually 87–88 characters, " +
  "letters and digits only (no 0, O, I or l), like the signatures shown on Solana Explorer.";

/**
 * True when `input` is exactly a base58 encoding of 64 bytes.
 *
 * Runs in both the browser and the server component, so it stays dependency-free
 * on purpose: a 20-line decoder cannot drift from the npm package it would
 * otherwise have to match.
 */
export function isTransactionSignature(input: string): boolean {
  if (input.length < 32 || input.length > 120) return false;

  // Little-endian byte accumulator: each base58 digit multiplies the running
  // value by 58 and adds itself, in exact integer arithmetic.
  const acc: number[] = [];
  for (const char of input) {
    const digit = ALPHABET.indexOf(char);
    if (digit === -1) return false;
    let carry = digit;
    for (let i = 0; i < acc.length; i++) {
      const x = acc[i] * 58 + carry;
      acc[i] = x & 0xff;
      carry = x >>> 8;
    }
    while (carry > 0) {
      acc.push(carry & 0xff);
      carry = carry >>> 8;
    }
  }

  // Leading '1's in base58 are leading zero bytes; the rest is the reversed
  // accumulator. Only the total length matters here — the caller does not need
  // the decoded bytes, only the verdict.
  let leadingOnes = 0;
  while (leadingOnes < input.length && input[leadingOnes] === "1") leadingOnes++;
  return leadingOnes + acc.length === 64;
}
