import type { Metadata } from "next";
import "./globals.css";
import { FlintWalletProvider } from "@/components/wallet-provider";

/**
 * Root layout.
 *
 * Structure only — this build has no visual identity yet (FLINT_BUILD_CONTEXT.md
 * Section 9). Document skeleton, landmarks and language are deliberate here
 * because a design pass should restyle this, never restructure it.
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
    <html lang="en">
      <body>
        {/* TODO-DESIGN: brand mark / logo slot — owned by the design track. */}
        <header className="flint-header">
          <p className="flint-brand">Flint</p>
          {/* TODO-DESIGN: brand voice for the tagline. */}
          <p className="flint-tagline">
            FRS-1 payment agreements on Solana · devnet only
          </p>
        </header>

        <main className="flint-main">
          <FlintWalletProvider>{children}</FlintWalletProvider>
        </main>

        {/* TODO-DESIGN: footer slot. Nothing functional is hidden here yet. */}
      </body>
    </html>
  );
}
