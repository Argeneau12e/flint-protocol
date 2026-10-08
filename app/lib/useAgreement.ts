/** useAgreement hook
 *
 * Returns agreement, viewer role (payer/recipient/visitor), UI state.
 * All data comes from the chain via `readAgreement` + `toFrs1Agreement`
 * (the single reader, Section 4.5) — no local-only state.
 */

import { useEffect, useState } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";
import { readAgreement } from "./flint-program";
import type { Frs1Agreement, AgreementStatus } from "./frs1-types";
import { toFrs1Agreement, type DecodableAgreement } from "./frs1-chain";
import { getConnection } from "./solana";
import { DEFAULT_PROGRAM_ID } from "./config";

export type AgreementViewer = "payer" | "recipient" | "arbiter" | "visitor";

export type AgreementState =
  | "pending"
  | "funded"
  | "deliveryClaimed"
  | "disputed"
  | "released"
  | "refunded"
  | "split"
  | "cancelled";

interface UseAgreementResult {
  agreement: Frs1Agreement | null;
  viewer: AgreementViewer | null;
  state: AgreementState | null;
  loading: boolean;
  error: Error | null;
}

/** Determine the viewer role based on the connected wallet and the agreement. */
function getViewer(
  connectedAddress: string | null,
  agreement: Frs1Agreement | null,
): AgreementViewer | null {
  if (!connectedAddress || !agreement) return null;

  const pubkey = new PublicKey(connectedAddress);
  const recipient = new PublicKey(agreement.recipientAddress);
  const payer = agreement.payerAddress ? new PublicKey(agreement.payerAddress) : null;

  if (pubkey.equals(recipient)) return "recipient";
  if (payer && pubkey.equals(payer)) return "payer";
  // Arbiter identity lives in the on-chain Config account; this hook does not
  // read Config yet, so a non-party viewer is honestly "visitor".
  return "visitor";
}

/** Render the UI state string from the on-chain status. */
function renderState(status: AgreementStatus): AgreementState {
  const mapping: Record<AgreementStatus, AgreementState> = {
    pending: "pending",
    funded: "funded",
    deliveryClaimed: "deliveryClaimed",
    disputed: "disputed",
    released: "released",
    refunded: "refunded",
    cancelled: "cancelled",
    split: "split",
  };
  return mapping[status];
}

/** Hook that fetches an agreement from chain and determines the viewer role. */
export function useAgreement(
  address: string, // agreement PDA address (not a wallet, but the agreement account address)
  connectedAddress: string | null = null,
  connection?: Connection,
  programId?: PublicKey,
): UseAgreementResult {
  const [agreement, setAgreement] = useState<Frs1Agreement | null>(null);
  const [viewer, setViewer] = useState<AgreementViewer | null>(null);
  const [state, setState] = useState<AgreementState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchAgreement() {
      try {
        const conn = connection ?? getConnection();
        const pid = programId ?? new PublicKey(DEFAULT_PROGRAM_ID);
        const raw = await readAgreement(conn, pid, new PublicKey(address));
        if (cancelled) return;
        if (raw === null) {
          setAgreement(null);
          setViewer(null);
          setState(null);
          return;
        }

        const decoded = toFrs1Agreement(raw as unknown as DecodableAgreement);

        setAgreement(decoded);
        setState(renderState(decoded.status));
        setViewer(getViewer(connectedAddress, decoded));
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAgreement();

    return () => {
      cancelled = true;
    };
  }, [address, connectedAddress, connection, programId]);

  return { agreement, viewer, state, loading, error };
}