import type { Metadata } from "next";
import Link from "next/link";
import { Cormorant_Garamond, DM_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { FlintWalletProvider } from "@/components/wallet-provider";
import { SiteNav } from "@/components/site-nav";
import { ConnectButton } from "@/components/agreement-ui";
import { CLUSTER } from "@/lib/solana";

/*
 * Fonts are self-hosted at build time by `next/font`, which is why the stylesheet
 * can reference them as plain CSS variables with system fallbacks — there is no
 * render-blocking network request and no layout shift when the face swaps in.
 *
 * Three families, three jobs, per the type stack: a classical serif for display,
 * a humanist sans for body, and a monospace for every value a person has to read
 * character by character.
 */
const display = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const body = DM_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

/**
 * Root layout.
 *
 * Structure and chrome. The header carries the brand lockup; everything inside
 * `<main>` is a page. Landmarks and language are deliberate: a design pass restyles
 * this, it does not restructure it.
 *
 * The favicon and the large app icon are supplied by file convention from
 * `app/icon.svg` and `app/apple-icon.svg` rather than declared here, because the
 * two are deliberately *different* treatments of the mark — see each file for why.
 *
 * The wallet provider wraps the whole app rather than only the pages that sign:
 * connecting is a property of the session, and a provider that mounted per-page
 * would drop the connection on every navigation — which would look to a person
 * like their wallet had disconnected on its own.
 */
export const metadata: Metadata = {
  title: "Flint — FRS-1 payment agreements",
  description:
    "Flint is an escrowed, verifiable Solana payment agreement (FRS-1). Devnet build.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <body>
        {/*
         * The provider wraps the header as well as the page: connecting is a
         * property of the session, and the bar is where a person expects to see
         * and change it. Mounting it per-page would drop the connection on every
         * navigation, which looks like the wallet disconnected on its own.
         */}
        <FlintWalletProvider>
          <header className="flint-header">
            <div className="flint-header-inner">
              {/*
               * The lockup links home: the mark is the most obvious "back to the
               * start" affordance there is. The emblem is decorative — the
               * wordmark beside it already says the name, so alt text on both
               * would make a screen reader announce "Flint" twice.
               */}
              <Link href="/" className="flint-brand-lockup">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/brand/flint-emblem-transparent.svg"
                  alt=""
                  aria-hidden="true"
                  className="flint-emblem"
                  width={36}
                  height={36}
                />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/brand/flint-wordmark-A-transparent.svg"
                  alt="Flint"
                  className="flint-wordmark"
                  width={96}
                  height={48}
                />
              </Link>

              <SiteNav />

              <div className="flint-header-actions">
                {/* The cluster is a fact about this deployment, not a setting. */}
                <span className="flint-cluster">{CLUSTER}</span>
                <ConnectButton />
              </div>
            </div>
          </header>

          <main className="flint-main">{children}</main>
        </FlintWalletProvider>
      </body>
    </html>
  );
}

