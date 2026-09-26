/**
 * Shareable links for one agreement (Section 7.1).
 *
 * The recipient is part of the URL because the agreement PDA is derived from it
 * (`[b"agreement", recipient, id]` — Section 4.5). A link that carried only the
 * uuid would not be resolvable: the program has no instruction to look an
 * agreement up by id. Carrying both makes every link self-verifying — the
 * recipient re-derives the PDA and can tell whether it is the one they were
 * sent.
 */

/** The Blink itself: an Actions URL, unfurlable by a compatible client. */
export function blinkUrl(origin: string, id: string, recipient: string): string {
  return `${origin}/api/actions/flint/${id}?recipient=${recipient}`;
}

/** The human-readable page: status, release, refund. */
export function agreementUrl(origin: string, id: string, recipient: string): string {
  return `${origin}/agreement/${id}?recipient=${recipient}`;
}

/**
 * Pulls the two path/query parts out of either link shape. Returns `null` when
 * either is missing, so a truncated or hand-edited link is reported as a plain
 * "bad link" rather than producing a lookup for a public key of `undefined`.
 */
export function parseAgreementRef(
  id: string | undefined,
  recipient: string | null,
): { id: string; recipient: string } | null {
  if (!id || !recipient) return null;
  return { id, recipient };
}
