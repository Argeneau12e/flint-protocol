"use client";

import { PublicKey } from "@solana/web3.js";
import { hexToBytes } from "@/lib/evidence";
import { uploadSignMessage } from "@/lib/evidence-nonce";
import { claimDeliveryTxBase64, flintProgramId } from "@/lib/client-tx";
import { getBrowserConnection, signAndSend } from "@/lib/wallet";
import { friendlyUploadError, signUploadMessage } from "@/components/evidence-submit-errors";
import type { QueuedFile } from "@/components/evidence-files";
import type { SubmitStage } from "@/components/evidence-submit";

export interface EvidenceUploadResult {
  evidenceRef: string;
  evidenceHash: string;
}

export interface SubmitOutcome {
  txSignature: string | null;
  manifestHash: string | null;
  error: string | null;
  upload: EvidenceUploadResult | null;
}

function failedOutcome(error: string): SubmitOutcome {
  return { txSignature: null, manifestHash: null, error, upload: null };
}

/**
 * Upload files/links/note and return the manifest hash + ref.
 * Calls `onStage` per stage; throws nothing — failures return `error`.
 */
export async function uploadEvidence(params: {
  agreement: string;
  files: QueuedFile[];
  fileHashes: Map<string, string>;
  links: string[];
  note: string;
  signMessageFn: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
  onStage: (stage: SubmitStage) => void;
}): Promise<{ upload: EvidenceUploadResult | null; error: string | null }> {
  params.onStage("nonce");
  const nonceResponse = await fetch(
    `/api/evidence/upload?agreement=${encodeURIComponent(params.agreement)}`,
  );
  const nonceBody = (await nonceResponse.json().catch(() => ({}))) as {
    nonce?: string;
    error?: string;
  };
  if (!nonceResponse.ok || typeof nonceBody.nonce !== "string") {
    const serverMessage =
      typeof nonceBody.error === "string" && nonceBody.error !== "" ? nonceBody.error : null;
    return {
      upload: null,
      error:
        serverMessage !== null
          ? serverMessage
          : nonceResponse.status === 429
          ? "Too many uploads at once. Wait a minute and try again."
          : "Could not start the upload. Try again.",
    };
  }

  params.onStage("signing");
  let signature: string;
  try {
    signature = await signUploadMessage(
      params.signMessageFn,
      uploadSignMessage(params.agreement, nonceBody.nonce),
    );
  } catch (cause) {
    return {
      upload: null,
      error:
        cause instanceof Error && cause.message !== ""
          ? cause.message
          : "The wallet could not sign the upload message.",
    };
  }

  params.onStage("uploading");
  const form = new FormData();
  form.set("agreement", params.agreement);
  form.set("nonce", nonceBody.nonce);
  form.set("signature", signature);
  for (const entry of params.files) {
    form.append("files", entry.file, entry.file.name);
    const hash = params.fileHashes.get(entry.id);
    if (hash !== undefined) form.set(`hash:${entry.file.name}`, hash);
  }
  for (const link of params.links) {
    form.append("links", new File([link], "link.txt", { type: "text/plain" }));
  }
  if (params.note.trim() !== "") form.set("note", params.note.trim());

  const uploadResponse = await fetch("/api/evidence/upload", {
    method: "POST",
    body: form,
  });
  const uploadBody = (await uploadResponse.json().catch(() => ({}))) as {
    error?: string;
    evidenceRef?: string;
    evidenceHash?: string;
  };
  if (!uploadResponse.ok) {
    return {
      upload: null,
      error: friendlyUploadError(uploadBody.error ?? "", uploadResponse.status),
    };
  }
  if (typeof uploadBody.evidenceRef !== "string" || typeof uploadBody.evidenceHash !== "string") {
    return { upload: null, error: "The server answered without a proof reference. Try again." };
  }
  return {
    upload: { evidenceRef: uploadBody.evidenceRef, evidenceHash: uploadBody.evidenceHash },
    error: null,
  };
}

/**
 * Build the claimDelivery transaction for an uploaded proof.
 * The caller signs it with the real wallet (useTransactionAction).
 */
export async function claimTxForUpload(params: {
  agreementPda: string;
  recipient: string;
  evidenceHash: string;
  evidenceRef: string;
}): Promise<string> {
  const connection = getBrowserConnection();
  return claimDeliveryTxBase64(
    connection,
    flintProgramId(),
    {
      agreement: new PublicKey(params.agreementPda),
      recipient: new PublicKey(params.recipient),
    },
    hexToBytes(params.evidenceHash),
    params.evidenceRef,
  );
}

export function voidSignAndSend(): void {
  void signAndSend;
}

export type { QueuedFile };
export { failedOutcome };
export type { SubmitOutcome as SubmitResult };
