/**
 * Payment request page shell (Task 3, item 1; server wrapper for Phase 2).
 *
 * The interactive page moved to `agreement-client.tsx` so this module stays a
 * server component and can export `generateMetadata`: crawlers get a title,
 * description and absolute preview image without ever touching a wallet.
 * The metadata reads the agreement from chain for its stable facts (amount,
 * asset) and falls back to the generic description on any failure.
 */

import type { Metadata } from "next";
import AgreementPageClient from "./agreement-client";
import { siteOrigin } from "../../../lib/site-url";
import { readOgAgreement } from "../../../lib/og-agreement";

const DESCRIPTION = "Secured by Flint escrow on Solana. Pay with any Solana wallet.";

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ recipient?: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const query = await searchParams;
  const origin = siteOrigin();
  const image =
    origin === "" ? null : `${origin}/agreement/${encodeURIComponent(id)}/opengraph-image`;
  const images =
    image === null
      ? undefined
      : [{ url: image, width: 1200, height: 630, alt: "Flint payment request" }];
  const found = await readOgAgreement(id, query.recipient);
  const title = found === null ? "Payment request" : `Payment request: ${found.amountLine}`;
  return {
    title,
    description: DESCRIPTION,
    openGraph: {
      title,
      description: DESCRIPTION,
      images,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: DESCRIPTION,
      images: image === null ? undefined : [image],
    },
  };
}

export default async function AgreementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ recipient?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  return <AgreementPageClient id={id} recipient={query.recipient} />;
}
