/**
 * Upload authorization — prove the request comes from the agreement's recipient.
 *
 * Three things must all hold before a file is accepted (task item 5):
 *   1. the agreement exists and is `Funded` (checked by the route against the
 *      chain — this module does not read the chain);
 *   2. the request carries a nonce this server signed, still within its
 *      5-minute life, bound to this agreement (see `evidence-nonce.ts`);
 *   3. an ed25519 signature, made by the recipient's wallet, over the exact
 *      message `flint-evidence-upload:<agreement>:<nonce>`.
 *
 * The signature check is ed25519 via tweetnacl — the same curve Solana wallets
 * sign with — so a recipient signs the message with the wallet they already
 * hold, and the server verifies it against the recipient's public key. No
 * server-held key, and no shared secret: possession of the recipient's private
 * key *is* the authorization.
 *
 * Signatures arrive base64 (Solana wallets return base64 signatures); the
 * public key is the recipient's base58 address. Both are decoded to raw bytes
 * before verification, and a decode failure is a plain `false`, never a throw.
 */

import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { consumeNonce, uploadSignMessage } from "./evidence-nonce";

/** A verified-or-not verdict, with the reason when it is not. */
export interface UploadAuthResult {
  ok: boolean;
  reason?: string;
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Verify an ed25519 signature of `message` by `signerBase58`.
 *
 * `signatureBase64` is a base64 (or base64url) 64-byte detached signature.
 * Returns false on any malformed input rather than throwing, so a hostile
 * request is just an unauthorized request.
 */
export function verifyEd25519(
  message: string,
  signatureBase64: string,
  signerBase58: string,
): boolean {
  let publicKey: PublicKey;
  try {
    publicKey = new PublicKey(signerBase58);
  } catch {
    return false;
  }
  const normalized = signatureBase64.replace(/-/g, "+").replace(/_/g, "/");
  const signature = base64ToBytes(normalized);
  if (signature === null || signature.length !== nacl.sign.signatureLength) {
    return false;
  }
  const messageBytes = new TextEncoder().encode(message);
  return nacl.sign.detached.verify(messageBytes, signature, publicKey.toBytes());
}

/**
 * Full upload authorization for `agreement` from `recipientBase58`:
 * verify the nonce (stateless HMAC — expiry and agreement binding), then
 * verify the recipient's signature over the signed message. The nonce is
 * checked first so a stale or foreign request never reaches the signature
 * check.
 */
export async function authorizeEvidenceUpload(params: {
  agreement: string;
  recipient: string;
  nonce: string;
  signature: string;
  nowSeconds?: number;
}): Promise<UploadAuthResult> {
  const nonceCheck = await consumeNonce(
    params.agreement,
    params.nonce,
    params.nowSeconds,
  );
  if (nonceCheck !== "ok") {
    return { ok: false, reason: `nonce_${nonceCheck}` };
  }

  const message = uploadSignMessage(params.agreement, params.nonce);
  if (!verifyEd25519(message, params.signature, params.recipient)) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true };
}
