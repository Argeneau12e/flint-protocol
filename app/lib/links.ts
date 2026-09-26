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

/**
 * The origin the *client* sees — never the origin the server is bound to.
 *
 * `new URL(request.url).origin` is what Next.js believes, and it builds that
 * from the address the process is listening on. Behind a reverse proxy or a
 * tunnel every URL derived from it points at `localhost` — verified through
 * cloudflared: the Blink card advertised `links.actions[0].href =
 * https://localhost:3000/...`, which no external client could POST to. That is
 * a silent, total break of the card for anyone who is not on this machine.
 *
 * Proxies send `x-forwarded-proto` and `x-forwarded-host`, and both were
 * observed correct end-to-end. `x-forwarded-port` is deliberately ignored:
 * cloudflared sends the *origin* port (3000), not the public one, so appending
 * it would corrupt an otherwise correct host. On a direct connection neither
 * header exists and the request URL is right as-is.
 */
export function requestOrigin(request: Request): string {
  const first = (value: string | null): string | null =>
    value === null ? null : (value.split(",")[0]?.trim() ?? "");
  const host =
    first(request.headers.get("x-forwarded-host")) ?? first(request.headers.get("host"));
  const fallback = new URL(request.url).origin;
  if (host === null || !/^[A-Za-z0-9.[\]:_-]+$/.test(host)) return fallback;
  const scheme = first(request.headers.get("x-forwarded-proto")) ?? fallback.split(":")[0];
  if (scheme === null || !/^[a-z][a-z0-9+.-]*$/.test(scheme)) return fallback;
  return `${scheme}://${host}`;
}


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
