/**
 * Evidence submit flow (Task 3, item 2, part 3b).
 *
 * Runs the Task 2 flow in order: request the nonce, sign the upload message
 * with the connected wallet (signMessage), upload to Blob through the route
 * (which builds the manifest and returns the hash + flint://e/<id> ref).
 * The sheet then builds claimDelivery and signs it, waits for confirmation,
 * and shows a success state with the transaction link and review link.
 */

"use client";

import { PublicKey } from "@solana/web3.js";
import { hexToBytes } from "@/lib/evidence";
import { uploadSignMessage } from "@/lib/evidence-nonce";
import { claimDeliveryTxBase64, flintProgramId } from "@/lib/client-tx";
import { getBrowserConnection, signAndSend } from "@/lib/wallet";
import { friendlyUploadError, signUploadMessage } from "@/components/evidence-submit-errors";
import type { QueuedFile } from "@/components/evidence-files";

export type SubmitStage =
  | "idle"
  | "nonce"
  | "signing"
  | "uploading"
  | "claiming"
  | "confirming"
  | "success"
  | "error";

export const SUBMIT_TEXT: Record<string, string> = {
  nonce: "Asking the server for a one-time upload pass…",
  signing: "Sign the upload message in your wallet to prove you are the recipient.",
  uploading: "Uploading your files…",
  claiming: "Writing the proof to the chain…",
  confirming: "Waiting for Solana devnet to confirm it…",
};
