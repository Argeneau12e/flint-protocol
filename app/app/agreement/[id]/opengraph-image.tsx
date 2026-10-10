/**
 * Link-preview image for a payment request (FLINT_DESIGN.md Section 9).
 *
 * Node runtime, `next/og` ImageResponse, 1200x630. The agreement is read from
 * chain; a read failure or a missing agreement renders the generic Flint card
 * instead of erroring, so a share of a stale link still unfurls. Stable facts
 * only (amount, asset, shortened recipient) — never live status, never proof.
 */

import { ImageResponse } from "next/og";
import { siteHost } from "../../../lib/site-url";
import { readOgAgreement } from "../../../lib/og-agreement";
import {
  CardFrame,
  OG_HEIGHT,
  OG_WIDTH,
  OG_STYLE,
  loadOgFonts,
} from "@/components/og-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const size = { width: OG_WIDTH, height: OG_HEIGHT };
export const contentType = "image/png";

export default async function AgreementImage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ recipient?: string }>;
}): Promise<ImageResponse> {
  const { id } = await params;
  const query = searchParams === undefined ? {} : await searchParams;
  const found = await readOgAgreement(id, query.recipient);
  const fonts = await loadOgFonts();
  const domain = siteHost();

  const body =
    found === null ? (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          fontFamily: "DM Sans",
          fontSize: 48,
          color: OG_STYLE.INK,
        }}
      >
        <div style={{ fontSize: 26, letterSpacing: "0.18em", color: OG_STYLE.MUTED }}>
          PAYMENT REQUEST
        </div>
        <div style={{ marginTop: 24 }}>Shareable escrow on Solana</div>
      </div>
    ) : (
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            fontFamily: "DM Sans",
            fontSize: 26,
            letterSpacing: "0.18em",
            color: OG_STYLE.MUTED,
          }}
        >
          PAYMENT REQUEST
        </div>
        <div
          style={{
            marginTop: 24,
            fontFamily: "IBM Plex Mono",
            fontWeight: 500,
            fontSize: 96,
            lineHeight: 1,
            color: OG_STYLE.INK,
          }}
        >
          {found.amountLine}
        </div>
        <div style={{ marginTop: 20, fontFamily: "DM Sans", fontSize: 40, color: OG_STYLE.MUTED }}>
          {found.recipientLine}
        </div>
      </div>
    );

  return new ImageResponse(<CardFrame domain={domain}>{body}</CardFrame>, {
    ...size,
    fonts: [
      { name: "DM Sans", data: fonts.dmSans, weight: 600, style: "normal" },
      { name: "IBM Plex Mono", data: fonts.plexMono, weight: 500, style: "normal" },
    ],
  });
}
