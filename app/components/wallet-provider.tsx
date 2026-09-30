/**
 * The wallet provider for the human flow (Phase 3), rebuilt for Phase 5a.
 *
 * Two decisions carry the real-browser fixes:
 *
 *   1. **No explicit adapters.** Modern Phantom registers itself through Wallet
 *      Standard, and wallet-adapter 0.15 auto-detects every such wallet via
 *      `useStandardWalletAdapters`. Passing a `PhantomWalletAdapter` alongside
 *      the detected one produced the duplicate-adapter warning and a broken
 *      connect path in real browsers — so the list is empty, detection does the
 *      work, and several installed wallets all show up (the connect control
 *      turns them into a picker rather than assuming one).
 *   2. **The banner can never be empty.** Every failure — the provider's own
 *      `onError`, a rejected `connect()` in a button, an autoConnect miss — is
 *      reported through `WalletIssueContext`, which logs the full error
 *      (name, message, nested `cause` / `error`) to the console and surfaces
 *      only `describeWalletFailure(...)`, a function that cannot return "".
 *
 * The connect control is still Flint's own rather than the adapter kit's modal
 * (Section 9: the copy around a signature is part of the product). `autoConnect`
 * stays on: a returning wallet should not be re-prompted to prove it is still
 * here.
 */

"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { WalletProvider } from "@solana/wallet-adapter-react";
import {
  WalletIssueContext,
  describeWalletFailure,
  logWalletFailure,
  type WalletIssue,
} from "@/lib/wallet";
import { COMMITMENT, RPC_URL } from "@/lib/solana";

export function FlintWalletProvider({ children }: { children: ReactNode }) {
  // Empty on purpose: see decision 1 above. Detection is the adapter library's
  // job, and this identity must stay stable so `WalletProvider` does not
  // rebuild its adapter list on every render.
  const wallets = useMemo(() => [], []);
  const [issue, setIssue] = useState<WalletIssue | null>(null);

  const report = useCallback((cause: unknown) => {
    logWalletFailure(cause);
    setIssue({ message: describeWalletFailure(cause) });
  }, []);
  const clear = useCallback(() => setIssue(null), []);
  const issueApi = useMemo(() => ({ issue, report, clear }), [issue, report, clear]);

  return (
    <WalletIssueContext.Provider value={issueApi}>
      <WalletProvider wallets={wallets} autoConnect onError={(cause) => report(cause)}>
        {/*
         * A wallet failure is the one message that should interrupt, so it is
         * pinned under the header rather than dropped wherever the page happens
         * to be scrolled. It stays *first* in the DOM, which is also what makes
         * it the banner a test or a screen reader finds before any inline field
         * error.
         */}
        {issue === null ? null : (
          <div className="flint-alert-bar">
            <p role="alert" className="flint-note flint-error">
              Wallet problem: {issue.message || "The wallet failed without a message — see the console."}
            </p>
          </div>
        )}
        {children}
      </WalletProvider>
    </WalletIssueContext.Provider>
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
