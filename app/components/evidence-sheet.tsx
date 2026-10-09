/**
 * Evidence sheet (Task 3, item 2): shadcn Sheet from the right.
 * Sections: Files, Links, Note. Sticky footer shows the summary and
 * Continue; Continue opens a confirm step, then submit runs the Task 2 flow
 * (nonce, signMessage, Blob upload, claimDelivery, confirmation).
 */

"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { CLUSTER } from "@/lib/solana";
import { explorerTxUrl } from "@/lib/links";
import { useFlintWallet, useTransactionAction } from "@/lib/wallet";
import {
  EVIDENCE_LIMITS,
  FilesSection,
  type QueuedFile,
} from "@/components/evidence-files";
import { LinksSection, NoteSection } from "@/components/evidence-fields";
import { SUBMIT_TEXT, type SubmitStage } from "@/components/evidence-submit";
import {
  claimTxForUpload,
  uploadEvidence,
} from "@/components/evidence-submit-flow";
import { MonoValue } from "@/components/payment-ui";

type SheetStep = "edit" | "confirm" | "success";

export function EvidenceSheet({
  open,
  onOpenChange,
  agreement,
  agreementPda,
  onClaimed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agreement: string;
  agreementPda: string;
  onClaimed: () => void;
}) {
  const { address } = useFlintWallet();
  const wallet = useWallet();
  const signMessageFn = (wallet as unknown as {
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  }).signMessage;

  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [links, setLinks] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [step, setStep] = useState<SheetStep>("edit");
  const [stage, setStage] = useState<SubmitStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [reviewCopied, setReviewCopied] = useState(false);

  const claim = useTransactionAction((signature) => {
    setTxSignature(signature);
    setStage("success");
    setStep("success");
    onClaimed();
  });

  const fileCount = files.length;
  const linkCount = links.length;
  const hasNote = note.trim() !== "";
  const ready =
    files.every((e) => e.hash !== null && !e.hashing && e.error === null) &&
    (fileCount > 0 || linkCount > 0 || hasNote);
  const summary = `${fileCount} ${fileCount === 1 ? "file" : "files"}, ${linkCount} ${linkCount === 1 ? "link" : "links"}${hasNote ? ", note" : ""}`;
  const reviewUrl =
    typeof window === "undefined" ? "" : `${window.location.origin}/agreement/${agreementPda}`;
  const busy = stage !== "idle" && stage !== "success" && stage !== "error";
  const working = busy || claim.busy;

  async function submit() {
    if (address === null) return;
    setError(null);
    const hashes = new Map(files.map((entry) => [entry.id, entry.hash ?? ""]));
    try {
      const uploaded = await uploadEvidence({
        agreement,
        files,
        fileHashes: hashes,
        links,
        note,
        signMessageFn,
        onStage: setStage,
      });
      if (uploaded.upload === null) {
        setError(uploaded.error ?? "The upload failed. Try again.");
        setStage("error");
        return;
      }
      setStage("claiming");
      const base64 = await claimTxForUpload({
        agreementPda,
        recipient: address,
        evidenceHash: uploaded.upload.evidenceHash,
        evidenceRef: uploaded.upload.evidenceRef,
      });
      setStage("confirming");
      const signature = await claim.run(() => Promise.resolve(base64));
      if (signature === null) {
        setError("The chain write failed. Your files are kept — try again.");
        setStage("error");
      }
    } catch (cause) {
      setError(cause instanceof Error && cause.message !== "" ? cause.message : "Something went wrong. Your files are still selected — try again.");
      setStage("error");
    }
  }

  function close(next: boolean) {
    if (!next) {
      setStep("edit");
      setStage("idle");
      setError(null);
    }
    onOpenChange(next);
  }

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="right" aria-label="Submit proof of delivery">
        <SheetHeader>
          <SheetTitle>Submit proof of delivery</SheetTitle>
          <SheetDescription>
            Describe the work so the payer can review it. Files, links and the
            note are stored alongside the agreement.
          </SheetDescription>
        </SheetHeader>

        <div className="flint-sheet-body">
          {step === "success" ? (
            <div className="flint-stack" role="status">
              <p><CheckIcon strokeWidth={1.5} size={20} aria-hidden="true" /> Proof recorded.</p>
              {txSignature === null ? null : (
                <p>
                  <a href={explorerTxUrl(txSignature, CLUSTER)} target="_blank" rel="noreferrer">
                    View the transaction
                  </a>
                </p>
              )}
              <div>
                <p className="flint-hint">Review link for the payer</p>
                <MonoValue value={reviewUrl} label="Review link" />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard?.writeText(reviewUrl).then(() => {
                      setReviewCopied(true);
                      window.setTimeout(() => setReviewCopied(false), 1500);
                    });
                  }}
                >
                  {reviewCopied ? "Copied." : "Copy review link"}
                </Button>
              </div>
              <Button type="button" onClick={() => close(false)}>Done</Button>
            </div>
          ) : step === "confirm" ? (
            <div className="flint-stack">
              <p>
                This record is written on chain and cannot be edited afterwards.
                Check the summary below before submitting.
              </p>
              <p className="flint-muted">{summary}</p>
              {working ? (
                <p role="status" aria-live="polite">
                  {stage === "idle" || stage === "success" || stage === "error"
                    ? (claim.message ?? "Working…")
                    : SUBMIT_TEXT[stage]}
                </p>
              ) : null}
              {error === null ? null : (
                <p role="alert" className="flint-error-text">{error}</p>
              )}
              <div className="flint-row">
                <Button type="button" variant="outline" disabled={working} onClick={() => setStep("edit")}>
                  Cancel
                </Button>
                <Button type="button" disabled={working} onClick={() => void submit()}>
                  {working ? "Submitting…" : "Submit proof"}
                </Button>
              </div>
              {error === null ? null : (
                <Button type="button" variant="outline" onClick={() => void submit()}>
                  Try again
                </Button>
              )}
            </div>
          ) : (
            <div className="flint-stack">
              <FilesSection files={files} setFiles={setFiles} disabled={working} />
              <LinksSection links={links} setLinks={setLinks} disabled={working} />
              <NoteSection note={note} setNote={setNote} disabled={working} />
            </div>
          )}
        </div>

        {step === "edit" ? (
          <SheetFooter>
            <p className="flint-hint" aria-live="polite">{summary}</p>
            <Button
              type="button"
              disabled={!ready || working}
              onClick={() => {
                if (files.length > EVIDENCE_LIMITS.maxFiles) return;
                if (links.length > EVIDENCE_LIMITS.maxLinks) return;
                if (note.length > EVIDENCE_LIMITS.maxNoteChars) return;
                setError(null);
                setStep("confirm");
              }}
            >
              Continue
            </Button>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
