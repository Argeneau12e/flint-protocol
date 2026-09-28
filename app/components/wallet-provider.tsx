/**
 * The wallet provider for the human flow (Phase 3).
 *
 * Phantom-first, per Section 6.2, and deliberately *not* the wallet-adapter UI
 * kit's modal. Two reasons:
 *
 *   1. Section 9 requires wallet interactions to say what is happening and what
 *      the person is approving, in plain language. A third-party modal renders
 *      its own copy inside a shadow DOM we cannot annotate, so a person would
 *      approve a transaction with no indication of what it does. The connect
 *      button is ours instead, and says so.
 *   2. The adapter is still what talks to Phantom — that part is not worth
 *      rewriting. Only the chrome is ours.
 *
 * `autoConnect` is on: reconnecting a wallet a person already authorised should
 * not be a second prompt asking them to confirm they meant to come back.
 *
 * Errors are surfaced as state rather than only logged. A wallet that fails to
 * load is a dead end otherwise — the page would render buttons that do nothing.
 */

"use client";

import { useMemo, useState, type ReactNode } from "react";
import { WalletProvider } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { COMMITMENT, RPC_URL } from "@/lib/solana";

export function FlintWalletProvider({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const [error, setError] = useState<string | null>(null);

  return (
    <WalletProvider
      wallets={wallets}
      autoConnect
      onError={(cause) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "The wallet could not be initialised in this browser.",
        );
      }}
      /*
       * The connect control is Flint's own rather than the adapter kit's modal, and
       * it lives in the page flow next to the action it enables — not in a header
       * bar, where a person would be asked to connect before they have seen what
       * they are connecting for. Its copy names the specific wallet it will prompt
       * with and is part of the product's language; changing that wording changes
       * what a person is agreeing to, so it is not a styling value.
       */
    >
      {error === null ? null : (
        <p role="alert" className="flint-note flint-error">
          Wallet problem: {error}
        </p>
      )}
      {children}
    </WalletProvider>
  );
}

/**
 * A `Connection` from the same devnet-only configuration as the server.
 *
 * Exported from here rather than constructed at each call site so that a wallet
 * transaction and a page read can never end up pointed at different clusters —
 * the app is devnet-only (Section 6.3), and one endpoint string is what makes
 * that checkable rather than aspirational.
 */
export const WALLET_CLUSTER = { url: RPC_URL, commitment: COMMITMENT } as const;
