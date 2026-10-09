/**
 * Proof viewer (Task 3): fetches the manifest behind `evidenceRef` from the
 * Task 2 resolver route. Files with image previews, links with a visible
 * domain, the note, and the manifest hash with a copy button.
 */

"use client";

import { useEffect, useState } from "react";
import { ExternalLinkIcon, FileIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { externalLinkHost, externalLinkRel } from "@/lib/links";
import { externalLinkTarget } from "@/lib/links";
import { evidenceIdFromRef } from "@/lib/evidence-store";
import type { EvidenceManifest } from "@/lib/evidence";
import type { Frs1Agreement } from "@/lib/frs1-types";
import { MonoValue } from "@/components/payment-ui";

function friendlyManifestError(status: number): string {
  if (status === 404) return "The proof could not be found.";
  if (status === 503) return "Proof storage is not available right now.";
  return "The proof could not be loaded. Try again.";
}

export function ProofView({ agreement }: { agreement: Frs1Agreement }) {
  const [manifest, setManifest] = useState<EvidenceManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const id = evidenceIdFromRef(agreement.evidenceRef);
      if (id === null || agreement.evidenceRef === "") {
        if (!cancelled) {
          setManifest(null);
          setLoading(false);
        }
        return;
      }
      try {
        const response = await fetch(`/api/evidence/${encodeURIComponent(id)}`);
        if (!response.ok) {
          if (!cancelled) {
            setError(friendlyManifestError(response.status));
            setLoading(false);
          }
          return;
        }
        const body = (await response.json()) as EvidenceManifest;
        if (!cancelled) {
          setManifest(body);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError("The proof could not be loaded. Try again.");
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [agreement.evidenceRef]);

  if (loading) {
    return (
      <div className="flint-stack" aria-label="Loading proof">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-5 w-1/2" />
      </div>
    );
  }

  if (error !== null) {
    return <p role="alert" className="flint-error-text">{error}</p>;
  }

  if (manifest === null) {
    return <p className="flint-muted">No proof details are available.</p>;
  }

  const evidenceId = evidenceIdFromRef(agreement.evidenceRef) ?? "";
  const files = manifest.items.filter((item) => item.kind === "file");
  const links = manifest.items.filter((item) => item.kind === "link");
  const notes = manifest.items.filter((item) => item.kind === "note");

  return (
    <div className="flint-stack">
      {files.length > 0 ? (
        <div>
          <h4>Files</h4>
          <ul className="flint-file-list">
            {files.map((item) => {
              const url = `/api/evidence/${encodeURIComponent(evidenceId)}?blob=${encodeURIComponent(item.blobId)}`;
              const isImage = item.mime.startsWith("image/");
              return (
                <li key={item.blobId} className="flint-file-row">
                  {isImage ? (
                    <a href={url} download={item.name} aria-label={`Download ${item.name}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt={item.name} width={64} height={64} style={{ borderRadius: 8, objectFit: "cover" }} />
                    </a>
                  ) : (
                    <FileIcon strokeWidth={1.5} size={20} aria-hidden="true" />
                  )}
                  <span className="flint-file-meta">
                    <a href={url} download={item.name}><strong>{item.name}</strong></a>
                    <code title={item.sha256} className="flint-hash">{item.sha256}</code>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {links.length > 0 ? (
        <div>
          <h4>Links</h4>
          <ul className="flint-file-list">
            {links.map((item, index) => {
              const host = item.url === undefined ? null : externalLinkHost(item.url);
              return (
                <li key={`${item.sha256}-${index}`} className="flint-file-row">
                  <ExternalLinkIcon strokeWidth={1.5} size={18} aria-hidden="true" />
                  <span className="flint-file-meta">
                    {item.url === undefined || host === null ? (
                      <span className="flint-muted">{item.name}</span>
                    ) : (
                      <a href={item.url} target={externalLinkTarget()} rel={externalLinkRel()}>{host}</a>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {notes.map((item, index) => (
        <div key={`${item.sha256}-${index}`}>
          <h4>Note from the recipient</h4>
          <p style={{ whiteSpace: "pre-wrap" }}>{item.text ?? ""}</p>
        </div>
      ))}
      <div>
        <p className="flint-hint">Manifest hash (matches the on-chain record)</p>
        <MonoValue value={agreement.evidenceHash} label="Manifest hash" />
      </div>
    </div>
  );
}
