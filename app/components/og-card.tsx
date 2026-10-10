/**
 * The shared link-preview card renderer (FLINT_DESIGN.md Section 9).
 *
 * 1200x630, background #0B0B0C with a 1px #26262B inset border. Top left the
 * Flint mark — the two cards plus the two bars, re-drawn from
 * public/brand/flint-mark.svg geometry (satori has no <path> curve support
 * worth trusting, so the squircle cards become plain rects) — beside the
 * FLINT wordmark in DM Sans 600 with wide tracking. Orange appears only on
 * the mark's bar and the thin bottom rule; everything else is ink and grey.
 *
 * The agreement card prints stable facts only: a PAYMENT REQUEST micro label,
 * the amount in IBM Plex Mono 96px with the asset name, then "to" and the
 * shortened recipient; the bottom holds the "Secured by Flint escrow on
 * Solana" pill and the domain. The landing card holds the headline and the
 * subline. Neither ever shows live status or proof content.
 *
 * Fonts are .woff files committed under app/assets/fonts, read with
 * fs.readFile relative to process.cwd() — a small static set, not a directory
 * walk, so bundler tracing stays tight. No woff2 (satori weights parsing
 * less reliably for it).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const BACKGROUND = "#0B0B0C";
const BORDER = "#26262B";
const INK = "#F4EFE6";
const MUTED = "#A8A29E";
const ORANGE = "#FF6B2B";
const ORANGE_DIM = "rgba(255,107,43,0.6)";

/** DM Sans 600 + IBM Plex Mono 500, loaded once per render. */
export interface OgFonts {
  dmSans: ArrayBuffer;
  plexMono: ArrayBuffer;
}

/**
 * The two card faces, read from committed .woff files. Each `readFile` takes
 * the whole relative path in one statically-scoped `join(process.cwd(), …)`
 * expression so bundler tracing picks the files up without a directory walk.
 */
export async function loadOgFonts(): Promise<OgFonts> {
  const [dmSans, plexMono] = await Promise.all([
    readFile(join(process.cwd(), "assets", "fonts", "dm-sans-600.woff")),
    readFile(join(process.cwd(), "assets", "fonts", "ibm-plex-mono-500.woff")),
  ]);
  return {
    dmSans: dmSans.buffer.slice(dmSans.byteOffset, dmSans.byteOffset + dmSans.byteLength) as ArrayBuffer,
    plexMono: plexMono.buffer.slice(plexMono.byteOffset, plexMono.byteOffset + plexMono.byteLength) as ArrayBuffer,
  };
}

/**
 * The mark: two cards with the orange accent bar and the peach bar beneath,
 * scaled from the 512-space geometry of public/brand/flint-mark.svg.
 */
export function FlintMark({ size }: { size: number }): ReactElement {
  const s = size / 512;
  const r = (x: number, y: number, w: number, h: number, radius: number) => ({
    left: x * s,
    top: y * s,
    width: w * s,
    height: h * s,
    borderRadius: radius * s,
  });
  return (
    <div style={{ display: "flex", position: "relative", width: size, height: size }}>
      <div style={{ display: "flex", position: "absolute", backgroundColor: "#0F0F0F", ...r(0, 0, 512, 512, 92) }} />
      <div style={{ display: "flex", position: "absolute", backgroundColor: "#4B4B5B", ...r(40, 87, 307, 318, 44) }} />
      <div style={{ display: "flex", position: "absolute", backgroundColor: "#6F6F7C", ...r(148, 107, 318, 318, 44) }} />
      <div style={{ display: "flex", position: "absolute", backgroundColor: ORANGE, ...r(128, 233, 257, 25, 8) }} />
      <div style={{ display: "flex", position: "absolute", backgroundColor: "#FFC5AC", ...r(189, 300, 196, 15, 7.5) }} />
    </div>
  );
}

interface CardChrome {
  domain: string | null;
  children: ReactNode;
}

/** The frame every card shares: border, mark + wordmark, bottom rule, pill + domain. */
export function CardFrame({ domain, children }: CardChrome): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: OG_WIDTH,
        height: OG_HEIGHT,
        backgroundColor: BACKGROUND,
        border: `1px solid ${BORDER}`,
        padding: "56px 64px 0px 64px",
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        <FlintMark size={56} />
        <div
          style={{
            marginLeft: 20,
            fontFamily: "DM Sans",
            fontWeight: 600,
            fontSize: 34,
            letterSpacing: "0.18em",
            color: INK,
          }}
        >
          FLINT
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
        {children}
      </div>
      <div style={{ display: "flex", alignItems: "center", paddingBottom: 48 }}>
        <div
          style={{
            fontFamily: "DM Sans",
            fontSize: 24,
            color: INK,
            border: `1px solid ${BORDER}`,
            borderRadius: 999,
            padding: "10px 22px",
          }}
        >
          Secured by Flint escrow on Solana
        </div>
        {domain === null ? null : (
          <div style={{ marginLeft: 24, fontFamily: "DM Sans", fontSize: 24, color: MUTED }}>
            {domain}
          </div>
        )}
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 3,
          backgroundColor: ORANGE_DIM,
        }}
      />
    </div>
  );
}

export const OG_STYLE = { BACKGROUND, BORDER, INK, MUTED, ORANGE } as const;
