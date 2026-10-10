/**
 * "Verify a file" — the browser-side proof check for a claimed delivery.
 *
 * Hashes a dropped file with Web Crypto and compares against the manifest
 * fetched behind the agreement's `evidence_ref` (Task 2 `findItemByHash`) and
 * against the on-chain hash (`manifestMatchesHash`). Three honest outcomes:
 * a match, a mismatch, or "could not be checked" (no proof, store down).
 */

"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Button } from "@/components/ui/button";
import { CheckIcon, XIcon } from "lucide-react";
import {
  findItemByHash,
  manifestMatchesHash,
  sha256Hex,
  type EvidenceManifest,
} from "@/lib/evidence";
import { evidenceIdFromRef } from "@/lib/evidence-store";

type Verdict = "idle" | "hashing" | "match" | "mismatch" | "uncheckable";

export function VerifyFile({
  evidenceRef,
  onChainHash,
}: {
  /** The agreement's `flint://e/<id>` ref, or "" when unclaimed. */
  evidenceRef: string;
  /** The agreement's on-chain `evidence_hash` hex. */
  onChainHash: string;
}) {
  const [verdict, setVerdict] = useState<Verdict>("idle");
  const [fileName, setFileName] = useState<string | null>(null);

  const onDrop = useCallback(
    async (accepted: File[]) => {
      const file = accepted[0];
      if (file === undefined) return;
      setFileName(file.name);
      setVerdict("hashing");
      const id = evidenceIdFromRef(evidenceRef);
      if (id === null || evidenceRef === "") {
        setVerdict("uncheckable");
        return;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const hash = await sha256Hex(bytes);
        const response = await fetch(`/api/evidence/${encodeURIComponent(id)}`);
        if (!response.ok) {
          setVerdict("uncheckable");
          return;
        }
        const manifest = (await response.json()) as EvidenceManifest;
        const inManifest = findItemByHash(manifest, hash) !== undefined;
        const manifestOk = await manifestMatchesHash(manifest, onChainHash);
        setVerdict(inManifest && manifestOk ? "match" : "mismatch");
      } catch {
        setVerdict("uncheckable");
      }
    },
    [evidenceRef, onChainHash],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
  });

  return (
    <section aria-labelledby="verify-file-heading">
      <h4 id="verify-file-heading">Verify a file</h4>
      <div {...getRootProps()} className="flint-dropzone" data-dragging={isDragActive}>
        <input {...getInputProps()} aria-label="Drop a file to verify it against this proof" />
        <p className="flint-muted">
          {isDragActive
            ? "Drop the file here."
            : "Drop one of the delivered files here to check it against the proof."}
        </p>
      </div>
      {verdict === "idle" || fileName === null ? null : (
        <p role="status" className={verdict === "match" ? "flint-note flint-success" : verdict === "mismatch" ? "flint-error-text" : "flint-muted"}>
          {verdict === "hashing" ? (
            `Checking ${fileName}…`
          ) : verdict === "match" ? (
            <span>
              <CheckIcon strokeWidth={1.5} size={16} aria-hidden="true" /> {fileName} matches
              the proof and the on-chain record.
            </span>
          ) : verdict === "mismatch" ? (
            <span>
              <XIcon strokeWidth={1.5} size={16} aria-hidden="true" /> {fileName} does not
              match this proof.
            </span>
          ) : (
            `Could not check ${fileName} — the proof could not be loaded.`
          )}
        </p>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setVerdict("idle");
          setFileName(null);
        }}
      >
        Clear
      </Button>
    </section>
  );
}
