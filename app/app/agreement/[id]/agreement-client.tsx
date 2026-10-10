/**
 * Payment request page — client UI (Task 3, item 1; split for Phase 2).
 *
 * Everything interactive lives here, over `useAgreement`: chain state plus
 * the connected wallet, re-read every 5 seconds. The server wrapper
 * (`page.tsx`) keeps only address resolution for metadata; when it cannot
 * resolve, this component renders the same not-found state for the same input.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgreement } from "@/lib/useAgreement";
import { getBrowserConnection, useFlintWallet } from "@/lib/wallet";
import { agreementPda } from "@/lib/flint-program";
import { flintProgramId } from "@/lib/client-tx";
import { AgreementBody } from "@/components/agreement-body";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function uuidToBytesLocal(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

interface Meta {
  assetMint: string;
  assetSymbol: string;
  cluster: string;
  siteUrl: string;
}

export function resolveAgreementAddress(id: string, recipientParam?: string): string | null {
  if (UUID_RE.test(id) && typeof recipientParam === "string" && recipientParam !== "") {
    try {
      const [pda] = agreementPda(
        new PublicKey(recipientParam),
        uuidToBytesLocal(id),
        flintProgramId(),
      );
      return pda.toBase58();
    } catch {
      return null;
    }
  }
  try {
    return new PublicKey(id).toBase58();
  } catch {
    return null;
  }
}

export default function AgreementPageClient({
  id,
  recipient,
}: {
  id: string;
  recipient?: string;
}) {
  const { address } = useFlintWallet();

  const agreementAddress = useMemo(() => resolveAgreementAddress(id, recipient), [id, recipient]);

  const { agreement, viewer, state, reviewEndsAt, loading, error, refresh } = useAgreement(
    agreementAddress ?? "",
    address,
  );

  const [meta, setMeta] = useState<Meta | null>(null);
  const [decimals, setDecimals] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/meta")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body !== null && typeof body.assetMint === "string") {
          setMeta(body as Meta);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (agreement === null) return;
    let cancelled = false;
    void getMint(getBrowserConnection(), new PublicKey(agreement.asset))
      .then((mint) => {
        if (!cancelled) setDecimals(mint.decimals);
      })
      .catch(() => {
        if (!cancelled) setDecimals(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agreement]);

  if (agreementAddress === null) {
    return (
      <div className="flint-stack">
        <header>
          <p className="flint-eyebrow">Payment request</p>
          <h1 className="flint-page-title">This link does not look right</h1>
        </header>
        <div className="flint-card flint-measure">
          <p className="flint-note flint-error">
            The address in the link is not a valid agreement address or share link.
          </p>
          <p style={{ marginTop: "var(--flint-space-4)" }}>
            <Link href="/">Back to the Flint overview</Link>
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flint-stack" aria-label="Loading agreement">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-16 w-2/3" />
        <div className="flint-pay-grid">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (error !== null || agreement === null || state === null) {
    const message = error === null ? "" : error.message;
    const notFound = error === null || /not found|no agreement|invalid/i.test(message);
    return (
      <div className="flint-stack">
        <header>
          <p className="flint-eyebrow">Payment request</p>
          <h1 className="flint-page-title">
            {notFound ? "Agreement not found" : "Could not load this agreement"}
          </h1>
        </header>
        <div className="flint-card flint-measure">
          <p className="flint-note flint-error">
            {notFound
              ? "No agreement exists at this address on devnet. Check the link and try again."
              : "The agreement could not be read from devnet. Check your connection and try again."}
          </p>
          <p style={{ marginTop: "var(--flint-space-4)" }}>
            <Link href="/">Back to the Flint overview</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <AgreementBody
      agreement={agreement}
      agreementPda={agreementAddress}
      viewer={viewer}
      state={state}
      reviewEndsAt={reviewEndsAt}
      decimals={decimals}
      symbol={meta?.assetSymbol ?? "TST"}
      cluster={meta?.cluster ?? "devnet"}
      siteUrl={meta?.siteUrl ?? ""}
      onChanged={refresh}
    />
  );
}
