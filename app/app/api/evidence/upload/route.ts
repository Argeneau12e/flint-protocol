/**
 * Evidence upload — POST /api/evidence/upload (task item 5).
 *
 * This is a real Next.js route handler (the old `upload.ts` sibling was never
 * served by Next — only `route.ts` files are). It accepts one multipart form
 * describing a whole evidence set — up to 5 files (25MB each), 5 links and a
 * 500-character note — and, once authorized, stores each file in Vercel Blob and
 * the manifest alongside them, returning the manifest, its `evidence_hash` and
 * the `flint://e/<id>` ref the recipient then commits on chain with
 * `claim_delivery`.
 *
 * Authorization is three-fold, and all three are enforced here before a byte is
 * stored:
 *   1. the agreement exists and is `Funded` — verified against the chain, not
 *      from the request;
 *   2. a nonce this server signed, unexpired (5 min) and bound to this
 *      agreement (stateless HMAC, so instances need no shared state);
 *   3. an ed25519 signature by the agreement's *recipient* over
 *      `flint-evidence-upload:<agreement>:<nonce>`.
 *
 * The recipient is the only signer because `claim_delivery` is recipient-only:
 * evidence is what the recipient asserts about their own work, so only they may
 * upload it. No server-held key is involved anywhere.
 *
 * Every file is hashed in the browser before upload (Web Crypto) and the hash
 * is carried in the form; the server recomputes it and refuses a mismatch, so a
 * tampered upload cannot be committed under a hash the client never signed.
 */

import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../../../lib/solana";
import { DEFAULT_PROGRAM_ID } from "../../../../lib/config";
import {
  buildManifest,
  evidenceHash,
  hexToBytes,
  isAllowedUpload,
  sha256Hex,
  type EvidenceItem,
  type EvidenceManifest,
} from "../../../../lib/evidence";
import {
  EvidenceStoreError,
  evidenceRefFor,
  newEvidenceId,
  putEvidenceFile,
  putEvidenceManifest,
} from "../../../../lib/evidence-store";
import { authorizeEvidenceUpload } from "../../../../lib/upload-auth";
import { issueNonce, MissingNonceSecretError } from "../../../../lib/evidence-nonce";
import { checkX402RateLimit, resetX402RateLimit } from "../../../../lib/throttle";
import { readAgreement } from "../../../../lib/flint-program";
import { toFrs1Agreement, type DecodableAgreement } from "../../../../lib/frs1-chain";
import { sendClaimReviewEmail } from "../../../../lib/notify";
import { getPayerEmail } from "../../../../lib/payer-email";

export const dynamic = "force-dynamic";

// Re-exported so tests can reset the shared throttle between cases.
export { resetX402RateLimit };

/** Upload limits (task item 5). */
export const UPLOAD_LIMITS = {
  maxFiles: 5,
  maxFileBytes: 25 * 1024 * 1024, // 25MB
  maxLinks: 5,
  maxNoteChars: 500,
} as const;

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * GET /api/evidence/upload?agreement=<addr> — mint an upload nonce.
 *
 * The client asks for a nonce, has the recipient sign
 * `flint-evidence-upload:<agreement>:<nonce>`, and posts both back with the
 * files. The nonce is an HMAC under FLINT_NONCE_SECRET over the agreement, a
 * random value and its expiry, so any instance can verify it without shared
 * state, only inside its 5-minute life, and only for the agreement it names.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const agreement = url.searchParams.get("agreement");
  if (agreement === null) return jsonError("missing_agreement", 400);
  try {
    new PublicKey(agreement);
  } catch {
    return jsonError("bad_agreement", 400);
  }

  try {
    const { nonce, expiresAt } = await issueNonce(agreement);
    return new Response(
      JSON.stringify({ nonce, expiresAt, message: `flint-evidence-upload:${agreement}:${nonce}` }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof MissingNonceSecretError) {
      return jsonError(
        "Evidence uploads need FLINT_NONCE_SECRET set on the server. Set it and redeploy.",
        503,
      );
    }
    throw error;
  }
}

/** The on-chain agreement, or an error response. */
async function loadFundedAgreement(
  agreementAddr: string,
): Promise<
  | { ok: true; recipient: string; uuid: string; title: string; reviewWindowSecs: number }
  | { ok: false; response: Response }
> {
  let agreementPubkey: PublicKey;
  try {
    agreementPubkey = new PublicKey(agreementAddr);
  } catch {
    return { ok: false, response: jsonError("bad_agreement", 400) };
  }

  const connection = getConnection();
  const raw = await readAgreement(connection, new PublicKey(DEFAULT_PROGRAM_ID), agreementPubkey);
  if (raw === null) return { ok: false, response: jsonError("agreement_not_found", 404) };

  const agreement = toFrs1Agreement(raw as unknown as DecodableAgreement);
  if (agreement.status !== "funded") {
    return {
      ok: false,
      response: jsonError(`agreement_not_funded:${agreement.status}`, 403),
    };
  }
  return {
    ok: true,
    recipient: agreement.recipientAddress,
    uuid: agreement.id,
    title: agreement.title,
    reviewWindowSecs: agreement.reviewWindowSecs,
  };
}

/** One validated file, ready to store. */
interface PreparedFile {
  name: string;
  mime: string;
  size: number;
  bytes: Uint8Array;
  /** The recomputed hash, confirmed equal to the client-declared one. */
  sha256: string;
}

/**
 * Validate and hash one uploaded file. The allowlist checks extension *and*
 * MIME together, and the size cap is enforced before anything is stored. The
 * client-declared hash (computed in the browser) is recomputed here and a
 * mismatch is refused, so a tampered upload cannot ride under a signed hash.
 */
async function prepareFile(
  file: File,
  declaredHash: string | null,
): Promise<{ ok: true; file: PreparedFile } | { ok: false; error: string }> {
  if (file.size > UPLOAD_LIMITS.maxFileBytes) {
    return { ok: false, error: "file_too_large" };
  }
  const mime = file.type;
  if (!isAllowedUpload(file.name, mime)) {
    return { ok: false, error: "unsupported_type" };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const actual = await sha256Hex(bytes);
  if (declaredHash !== null && declaredHash.toLowerCase() !== actual) {
    return { ok: false, error: "hash_mismatch" };
  }
  return { ok: true, file: { name: file.name, mime, size: bytes.byteLength, bytes, sha256: actual } };
}

/** A link form entry is `url` (or `url<TAB>label`); only http(s) URLs pass. */
function parseLinkEntry(raw: string): { href: string; host: string } | null {
  const url = raw.split("\t")[0];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname === "") return null;
  return { href: parsed.toString(), host: parsed.hostname };
}

/** POST /api/evidence/upload — authorized, stores files + manifest. */
export async function POST(request: Request): Promise<Response> {
  // Per-IP throttle, reused from the x402 endpoint (task item 5). Checked before
  // any parsing or RPC so a flood never reaches the chain or the store.
  const throttle = checkX402RateLimit(request, "evidence-upload");
  if (!throttle.decision.allowed) {
    return new Response(JSON.stringify({ error: "throttle_exceeded" }, null, 2), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(throttle.decision.retryAfterSeconds),
      },
    });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("bad_multipart", 400);
  }

  const agreement = String(form.get("agreement") ?? "");
  const nonce = String(form.get("nonce") ?? "");
  const signature = String(form.get("signature") ?? "");
  if (agreement === "" || nonce === "" || signature === "") {
    return jsonError("missing_auth_fields", 400);
  }

  // (1) Agreement must exist and be Funded, verified against the chain.
  const funded = await loadFundedAgreement(agreement);
  if (!funded.ok) return funded.response;

  // (2 + 3) Nonce check (stateless HMAC: expiry + agreement binding) and the
  // recipient ed25519 signature. The signature must be by the *stored
  // recipient*, so a stranger cannot upload for someone else.
  let auth;
  try {
    auth = await authorizeEvidenceUpload({
      agreement,
      recipient: funded.recipient,
      nonce,
      signature,
    });
  } catch (error) {
    if (error instanceof MissingNonceSecretError) {
      return jsonError(
        "Evidence uploads need FLINT_NONCE_SECRET set on the server. Set it and redeploy.",
        503,
      );
    }
    throw error;
  }
  if (!auth.ok) return jsonError(auth.reason ?? "unauthorized", 403);

  // Collect files, links and the note from the form.
  const fileEntries = form.getAll("files").filter((v): v is File => v instanceof File);
  const linkEntries = form.getAll("links").filter((v): v is File => v instanceof File);
  if (fileEntries.length > UPLOAD_LIMITS.maxFiles) {
    return jsonError("too_many_files", 400);
  }
  if (linkEntries.length > UPLOAD_LIMITS.maxLinks) {
    return jsonError("too_many_links", 400);
  }

  const items: EvidenceItem[] = [];
  const evidenceId = newEvidenceId();

  try {
    for (const file of fileEntries) {
      const declared = form.get(`hash:${file.name}`);
      const prepared = await prepareFile(file, declared === null ? null : String(declared));
      if (!prepared.ok) return jsonError(prepared.error, 400);
      const stored = await putEvidenceFile(evidenceId, prepared.file.bytes, prepared.file.mime);
      items.push({
        kind: "file",
        name: prepared.file.name,
        size: prepared.file.size,
        mime: prepared.file.mime,
        sha256: prepared.file.sha256,
        blobId: stored.blobId,
      });
    }

    for (const linkFile of linkEntries) {
      const raw = (await linkFile.text()).trim();
      const parsed = parseLinkEntry(raw);
      if (parsed === null) return jsonError("bad_link", 400);
      items.push({
        kind: "link",
        name: parsed.host,
        size: 0,
        mime: "",
        sha256: await sha256Hex(parsed.href),
        blobId: "",
        url: parsed.href,
      });
    }

    const note = form.get("note");
    if (note !== null && String(note) !== "") {
      const text = String(note);
      if (text.length > UPLOAD_LIMITS.maxNoteChars) {
        return jsonError("note_too_long", 400);
      }
      items.push({
        kind: "note",
        name: "note",
        size: new TextEncoder().encode(text).byteLength,
        mime: "",
        sha256: await sha256Hex(text),
        blobId: "",
        text,
      });
    }

    if (items.length === 0) return jsonError("no_evidence", 400);

    const manifest = buildManifest(agreement, items);
    await putEvidenceManifest(evidenceId, manifest);
    const hash = await evidenceHash(manifest);

    // Optional payer email (task item 10): fire-and-forget, best-effort. It is
    // awaited only to keep the result out of the response path — a notification
    // failure never fails an upload, and an unset RESEND_API_KEY skips silently.
    const payerEmail = getPayerEmail(funded.uuid);
    if (payerEmail !== null) {
      await sendClaimReviewEmail({
        to: payerEmail,
        agreementId: funded.uuid,
        title: funded.title,
        // The claim will land now, so the window closes about one window out.
        reviewWindowEndsAt: Math.floor(Date.now() / 1000) + funded.reviewWindowSecs,
      });
    }

    return new Response(
      JSON.stringify(
        {
          evidenceRef: evidenceRefFor(evidenceId),
          evidenceId,
          evidenceHash: hash,
          // The 32 raw bytes the recipient commits on chain with claim_delivery.
          evidenceHashBytes: hexToBytes(hash),
          manifest,
        },
        null,
        2,
      ),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof EvidenceStoreError) {
      return jsonError(error.message, 503);
    }
    return jsonError("upload_failed", 500);
  }
}

