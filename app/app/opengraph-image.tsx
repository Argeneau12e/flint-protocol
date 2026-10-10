/**
 * Branded link-preview image for the site root (Phase 2).
 *
 * Node runtime, `next/og` ImageResponse, 1200x630: the headline
 * "Programmable payments on Solana" with the subline "Create shareable
 * payment requests. Receipts on-chain." in the shared CardFrame.
 */

import { ImageResponse } from "next/og";
import { siteHost } from "../lib/site-url";
import {
  CardFrame,
  OG_HEIGHT,
  OG_WIDTH,
  OG_STYLE,
  loadOgFonts,
} from "@/components/og-card";

export const runtime = "nodejs";
export const dynamic = "force-static";
export const size = { width: OG_WIDTH, height: OG_HEIGHT };
export const contentType = "image/png";

export default async function LandingImage(): Promise<ImageResponse> {
  const fonts = await loadOgFonts();
  return new ImageResponse(
    <CardFrame domain={siteHost()}>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            fontFamily: "DM Sans",
            fontWeight: 600,
            fontSize: 76,
            lineHeight: 1.05,
            color: OG_STYLE.INK,
          }}
        >
          Programmable payments on Solana
        </div>
        <div style={{ marginTop: 20, fontFamily: "DM Sans", fontSize: 34, color: OG_STYLE.MUTED }}>
          Create shareable payment requests. Receipts on-chain.
        </div>
      </div>
    </CardFrame>,
    {
      ...size,
      fonts: [
        { name: "DM Sans", data: fonts.dmSans, weight: 600, style: "normal" },
        { name: "IBM Plex Mono", data: fonts.plexMono, weight: 500, style: "normal" },
      ],
    },
  );
}
