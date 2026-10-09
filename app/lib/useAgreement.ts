/** useAgreement hook
 *
 * Reads one agreement from chain, polls it every 5 seconds, and returns the
 * agreement, the viewer's role, and a derived state. There is no local-only
 * state: every render is derived from the freshly-read account plus the current
 * time, so the UI can never show a status the chain does not agree with.
 *
 * The arbiter is read from the on-chain Config (the one address that may
 * resolve a dispute), so the viewer role can name the arbiter without a
 * hardcoded address. Config is fetched alongside the agreement on each poll.
 */

import { useCallback, useEffect, useState } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";
import { readAgreement, readConfig } from "./flint-program";
import type { Frs1Agreement } from "./frs1-types";
import { toFrs1Agreement, type DecodableAgreement } from "./frs1-chain";
import { getConnection } from "./solana";
import { DEFAULT_PROGRAM_ID } from "./config";
import {
  deriveAgreementView,
  type AgreementViewer,
  type DerivedAgreementState,
} from "./agreement-state";

export type { AgreementViewer, DerivedAgreementState };

/** How often the agreement is re-read from chain, in milliseconds. */
export const POLL_INTERVAL_MS = 5_000;

interface UseAgreementResult {
  agreement: Frs1Agreement | null;
  viewer: AgreementViewer | null;
  state: DerivedAgreementState | null;
  /** End of the review window (Unix seconds), or null when not claimed. */
  reviewEndsAt: number | null;
  loading: boolean;
  error: Error | null;
  /** Re-read immediately (e.g. after the viewer signs a transaction). */
  refresh: () => void;
}

/** Hook that fetches an agreement from chain and derives the viewer + state. */
export function useAgreement(
  address: string, // agreement PDA address (not a wallet)
  connectedAddress: string | null = null,
  connection?: Connection,
  programId?: PublicKey,
): UseAgreementResult {
  const [agreement, setAgreement] = useState<Frs1Agreement | null>(null);
  const [viewer, setViewer] = useState<AgreementViewer | null>(null);
  const [state, setState] = useState<DerivedAgreementState | null>(null);
  const [reviewEndsAt, setReviewEndsAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function fetchOnce() {
      try {
        const conn = connection ?? getConnection();
        const pid = programId ?? new PublicKey(DEFAULT_PROGRAM_ID);
        const now = Math.floor(Date.now() / 1000);

        // Agreement and Config are independent reads; fetch together. A missing
        // Config only means the arbiter role cannot be named — it must not fail
        // the whole read, so it is caught and treated as "no arbiter".
        const [raw, config] = await Promise.all([
          readAgreement(conn, pid, new PublicKey(address)),
          readConfig(conn, pid).catch(() => null),
        ]);
        if (cancelled) return;

        if (raw === null) {
          setAgreement(null);
          setViewer(null);
          setState(null);
          setReviewEndsAt(null);
          return;
        }

        const decoded = toFrs1Agreement(raw as unknown as DecodableAgreement);
        const arbiter = config ? config.arbiter.toBase58() : null;
        const view = deriveAgreementView(decoded, connectedAddress, now, arbiter);

        setAgreement(view.agreement);
        setViewer(view.viewer);
        setState(view.state);
        setReviewEndsAt(view.reviewEndsAt);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchOnce();
    const timer = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [address, connectedAddress, connection, programId, nonce]);

  return { agreement, viewer, state, reviewEndsAt, loading, error, refresh };
}
