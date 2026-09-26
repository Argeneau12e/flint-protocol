/**
 * Shared plumbing for the Solana Actions endpoints (Section 7.1.2 / 7.1.3).
 *
 * Everything here exists to satisfy the Actions spec rather than our own
 * convenience: the version/blockchain headers a Blink client checks before
 * unfurling, the `links` shape, and error responses that are *actions*
 * responses. An Actions client that cannot parse our errors shows nothing at
 * all, so failures are reported in the same envelope as successes.
 */

import { NextResponse } from "next/server";

/**
 * The Actions spec version this implementation speaks. Declared in one place so
 * a client check and our own responses can never drift apart.
 */
export const ACTIONS_VERSION = "1";

/**
 * CAIP-2 chain ids this endpoint answers on, as the spec's `X-Blockchain-Ids`
 * header wants them (comma-separated).
 *
 * Both are here on purpose. `X-Action-Blockchain: solana` is the header the
 * original spec examples send; `X-Blockchain-Ids` with the full CAIP-2 ids is
 * what `@dialectlabs/blinks` (Dialect, co-author of the spec) actually reads —
 * it treats a response *without* it as unsupported and refuses to unfurl, so a
 * server sending only the older header looks broken in that client while
 * passing every wire-format test. Devnet's genesis hash is
 * `EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
 * (mainnet) is deliberately absent — this build is devnet-only (Section 12).
 */
export const BLOCKCHAIN_IDS = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

/**
 * Headers a Blink client needs in order to render this at all.
 *
 * Two groups, and both are load-bearing:
 *
 *   - The spec's own version/blockchain pair, which a client checks before it
 *     decides it can unfurl the link.
 *   - CORS. A Blink is fetched by the *client's* origin — Phantom's in-app browser,
 *     dial.to, someone else's page — never by ours, so a response without these is
 *     refused by the browser and the link renders as a dead URL. `*` is right here:
 *     the endpoints are public, and the POST returns an unsigned transaction that
 *     only the caller can sign, so there is nothing to protect by narrowing it.
 */
export function actionsHeaders(): Record<string, string> {
  return {
    "X-Action-Version": ACTIONS_VERSION,
    "X-Action-Blockchain": "solana",
    "X-Blockchain-Ids": BLOCKCHAIN_IDS,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type,X-Payment,X-Signer,X-Action-Version,X-Action-Blockchain,X-Blockchain-Ids",
    "Access-Control-Expose-Headers":
      "X-Action-Version,X-Action-Blockchain,X-Blockchain-Ids,X-Payment-Response,X-Flint-Proposal-Tx",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * The answer to a CORS preflight.
 *
 * Browsers send `OPTIONS` before a cross-origin GET/POST with non-simple headers
 * (which every Blink request is), so a provider that does not answer it is
 * unreachable from a browser even though `curl` works.
 */
export function actionsPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: actionsHeaders() });
}

/** A spec-shaped Actions error: the client shows the message rather than nothing. */
export function actionsError(
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
): NextResponse {
  // Both keys, deliberately. Our own tests and UI read `error`; the reference
  // Blink client reads `message` (`error.message` in `@dialectlabs/blinks`' POST
  // handler) and would otherwise render a blank failure to the person holding the
  // wallet. Same string, two names, so neither audience gets a silent error.
  return NextResponse.json(
    { error: message, message, ...extra },
    { status, headers: actionsHeaders() },
  );
}

/**
 * The Blink icon.
 *
 * Inline SVG as a data URI: an Actions client fetches the icon over the network
 * and will not render a relative path, and an external URL would be a third
 * party we do not control. TODO-DESIGN: a real brand mark and hosted PNG/ICO
 * once there is one.
 */
export const BLINK_ICON =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#111827"/><path d="M20 22h24M20 32h16M20 42h20" stroke="#f9fafb" stroke-width="5" stroke-linecap="round"/></svg>`,
  ).toString("base64");

/** Renders a base-unit amount with a symbol, for a title/description only. */
export function formatAmount(baseUnits: string, symbol: string): string {
  return `${baseUnits} ${symbol}`;
}
