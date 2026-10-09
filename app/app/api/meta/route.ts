/**
 * Deployment metadata for client pages — GET /api/meta (Task 3).
 *
 * The payment page is a client component over `useAgreement` (chain state +
 * 5s poll), so it cannot call the server-only `readConfig()` directly. This
 * route exposes the display-only facts it needs: the asset mint, its symbol,
 * the cluster, and the site origin for share links. Public addresses only —
 * no key material, no secrets — and cache-free, so a redeploy is picked up
 * on the next navigation.
 */

import { readConfig, ConfigError } from "../../../lib/config";
import { CLUSTER } from "../../../lib/solana";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let config;
  try {
    config = readConfig();
  } catch (error) {
    const detail =
      error instanceof ConfigError
        ? error.problems.join("; ")
        : "deployment is not configured";
    return new Response(JSON.stringify({ error: detail }, null, 2), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  return new Response(
    JSON.stringify(
      {
        assetMint: config.assetMint.toBase58(),
        assetSymbol: config.assetSymbol,
        cluster: CLUSTER,
        siteUrl,
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    },
  );
}
