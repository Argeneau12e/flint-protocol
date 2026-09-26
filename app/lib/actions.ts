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

/** Headers a Blink client reads to decide whether it can render the link. */
export function actionsHeaders(): Record<string, string> {
  return {
    "X-Action-Version": ACTIONS_VERSION,
    "X-Action-Blockchain": "solana",
  };
}

/** A spec-shaped Actions error: the client shows the message rather than nothing. */
export function actionsError(
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json({ error: message, ...extra }, { status, headers: actionsHeaders() });
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
