/**
 * Resolve an evidence locator — GET /api/evidence/[id] (task item 4/5).
 *
 * The on-chain `evidence_ref` is `flint://e/<id>`; this route is what that
 * resolves to. `[id]` is the unguessable evidence id, and the two things it can
 * serve are:
 *
 *   - `?blob=<blobId>`  the stored file bytes, as an attachment;
 *   - (default)         the canonical JSON manifest.
 *
 * Security (task item 5): a file is *always* served with
 * `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, and
 * its content type is pinned to the allowlisted MIME recorded in the manifest —
 * never to whatever the blob reports. An uploaded document is therefore never
 * rendered inline as HTML or SVG in this origin; the browser can only download
 * it. SVG and HTML are not on the upload allowlist in the first place
 * (`lib/evidence.ts`), so this is defence in depth, not the only gate.
 *
 * A missing store token is a 503 with a clear JSON body (task item 4: "never
 * crash"), and a missing blob/manifest is a 404 — an id nobody minted is
 * indistinguishable from one that expired, which is the point.
 */

import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../../../lib/solana";
import { DEFAULT_PROGRAM_ID } from "../../../../lib/config";
import {
  downloadDisposition,
  manifestMatchesHash,
  type EvidenceManifest,
} from "../../../../lib/evidence";
import {
  EvidenceStoreError,
  evidenceIdFromRef,
  getEvidenceFile,
  getEvidenceManifest,
} from "../../../../lib/evidence-store";
import { readAgreement } from "../../../../lib/flint-program";
import { toFrs1Agreement, type DecodableAgreement } from "../../../../lib/frs1-chain";

export const dynamic = "force-dynamic";

const NOSNIFF = "nosniff";

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;

  // The path segment is the bare id; also accept a full flint://e/<id> so a
  // caller can paste the on-chain ref straight into the URL path.
  const evidenceId = evidenceIdFromRef(id) ?? id;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(evidenceId)) {
    return jsonError("bad_evidence_id", 400);
  }

  const url = new URL(request.url);
  const blobId = url.searchParams.get("blob");

  try {
    if (blobId !== null) {
      return await serveFile(evidenceId, blobId);
    }
    return await serveManifest(evidenceId);
  } catch (error) {
    if (error instanceof EvidenceStoreError) {
      // Missing token or a clean store failure: a 503, never a 500 crash.
      return jsonError(error.message, 503);
    }
    return jsonError("evidence_unavailable", 502);
  }
}

async function serveManifest(evidenceId: string): Promise<Response> {
  const manifest = await getEvidenceManifest(evidenceId);
  if (manifest === null) return jsonError("not_found", 404);

  // Best-effort integrity cross-check: if the manifest names an agreement that
  // is on chain and claimed, confirm the on-chain evidence_hash still matches a
  // recomputation of this manifest. A mismatch is reported in a header but does
  // not block the download — /verify is the authoritative check.
  const onChainHash = await onChainEvidenceHash(manifest).catch(() => null);
  const matches =
    onChainHash === null ? null : await manifestMatchesHash(manifest, onChainHash);

  return new Response(JSON.stringify(manifest, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": NOSNIFF,
      ...(matches === null ? {} : { "x-evidence-hash-match": String(matches) }),
    },
  });
}

async function serveFile(evidenceId: string, blobId: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(blobId)) {
    return jsonError("bad_blob_id", 400);
  }

  // Read the manifest first: the file's content type and name come from the
  // *manifest*, not from the blob, so a mislabelled blob cannot override them.
  const manifest = await getEvidenceManifest(evidenceId);
  if (manifest === null) return jsonError("not_found", 404);
  const item = manifest.items.find((i) => i.blobId === blobId);
  if (item === undefined || item.kind !== "file") return jsonError("not_found", 404);

  const file = await getEvidenceFile(evidenceId, blobId);
  if (file === null) return jsonError("not_found", 404);

  // Pin the content type to the allowlisted MIME the manifest recorded. Never
  // trust the blob's own content-type, and never text/html or image/svg+xml.
  const contentType = item.mime !== "" ? item.mime : "application/octet-stream";

  return new Response(file.body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": downloadDisposition(item.name),
      "x-content-type-options": NOSNIFF,
      "cache-control": "no-store",
      // A stored file is inert bytes; this blocks scripting and MIME sniffing.
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

/** The agreement's on-chain evidence_hash, if this manifest names a claim. */
async function onChainEvidenceHash(manifest: EvidenceManifest): Promise<string | null> {
  let agreementPubkey: PublicKey;
  try {
    agreementPubkey = new PublicKey(manifest.agreement);
  } catch {
    return null;
  }
  const connection = getConnection();
  const raw = await readAgreement(
    connection,
    new PublicKey(DEFAULT_PROGRAM_ID),
    agreementPubkey,
  );
  if (raw === null) return null;
  const agreement = toFrs1Agreement(raw as unknown as DecodableAgreement);
  return agreement.evidenceHash === "" ? null : agreement.evidenceHash;
}
