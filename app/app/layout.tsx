import type { Metadata } from "next";
import Link from "next/link";
import { Cormorant_Garamond, DM_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { FlintWalletProvider } from "@/components/wallet-provider";

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
        <header className="flint-header">
          <div className="flint-header-inner">
            {/*
             * The lockup links home: the mark is the most obvious "back to the
             * start" affordance there is, and the overview page is where a person
             * arrives at an unfamiliar shared link.
             */}
            <Link href="/" className="flint-brand-lockup">
              {/*
               * The emblem is decorative here — the wordmark beside it already
               * says the name, so alt text on both would make a screen reader
               * announce "Flint" twice. The transparent variant is correct on this
               * background by construction: the page field *is* the logo's field.
               */}
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

            <p className="flint-tagline">
              FRS-1 payment agreements on Solana · devnet only
            </p>
          </div>
        </header>

        <main className="flint-main">
          <FlintWalletProvider>{children}</FlintWalletProvider>
        </main>
      </body>
    </html>
  );
}

