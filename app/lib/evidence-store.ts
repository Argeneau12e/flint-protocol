/**
 * Evidence storage — Vercel Blob, keyed by unguessable ids.
 *
 * Section 13.7: `evidence_ref` is `flint://e/<id>` (at most 96 bytes) and the
 * app resolves it. The id is the whole access control for a *public* blob URL
 * that is otherwise listable-by-nobody, so it has to be unguessable: 16 random
 * bytes (128 bits) from the Web Crypto RNG, base64url-encoded, is far past a
 * brute force and short enough to keep the ref well under 96 bytes.
 *
 * `BLOB_READ_WRITE_TOKEN` is read from the environment and passed explicitly to
 * every call. A missing token is a configuration error surfaced as a typed
 * `EvidenceStoreError`, never a crash and never a silent fall back to a public
 * write: without a token the store is simply not configured, and the route
 * returns a clear JSON error (Section 6.3 / the task's "never crash" rule).
 *
 * Files are stored under `evidence/<id>` and the manifest under
 * `evidence/<id>/manifest.json`, so one agreement's evidence is one prefix and
 * `[id]` can serve both the manifest and a member file from a single id.
 */

import { del, head, put, type PutBlobResult } from "@vercel/blob";
import type { EvidenceManifest } from "./evidence";

/** The scheme + prefix of an on-chain evidence locator. */
export const EVIDENCE_REF_SCHEME = "flint://e/";

/** `flint://e/<id>`, at most 96 bytes (MAX_EVIDENCE_REF_LEN, state.rs). */
export type EvidenceRef = `flint://e/${string}`;

/** Thrown when the store is not configured, or a blob call fails cleanly. */
export class EvidenceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceStoreError";
  }
}

/** The blob write token, or null when the deployment has not set it. */
export function blobToken(): string | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return token === undefined || token.trim() === "" ? null : token.trim();
}

/**
 * A fresh, unguessable evidence id: 16 random bytes, base64url, no padding.
 *
 * base64url (not hex) to keep the resulting `flint://e/<id>` comfortably under
 * the 96-byte on-chain cap even with the manifest prefix; `-`/`_` are the only
 * non-alphanumerics and both are valid in a URL path segment.
 */
export function newEvidenceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The on-chain locator for an id. */
export function evidenceRefFor(id: string): EvidenceRef {
  const ref = `${EVIDENCE_REF_SCHEME}${id}`;
  if (ref.length > 96) {
    // Defensive: an id is fixed-length, so this cannot happen for ids minted by
    // `newEvidenceId`. Guarded anyway because the on-chain field is a hard cap.
    throw new EvidenceStoreError("evidence id too long for the on-chain ref");
  }
  return ref as EvidenceRef;
}

/** The id out of a `flint://e/<id>` ref, or null when it is not one. */
export function evidenceIdFromRef(ref: string): string | null {
  if (!ref.startsWith(EVIDENCE_REF_SCHEME)) return null;
  const id = ref.slice(EVIDENCE_REF_SCHEME.length);
  return id === "" ? null : id;
}

/** The blob pathname a file is stored at, within one evidence id. */
function filePath(id: string, blobId: string): string {
  return `evidence/${id}/${blobId}`;
}

/** The blob pathname the manifest is stored at, within one evidence id. */
function manifestPath(id: string): string {
  return `evidence/${id}/manifest.json`;
}

function requireToken(): string {
  const token = blobToken();
  if (token === null) {
    throw new EvidenceStoreError(
      "Evidence storage is not configured: set BLOB_READ_WRITE_TOKEN.",
    );
  }
  return token;
}

/**
 * Store one file's bytes and return the blob id (a second unguessable id, so a
 * blob's path is not derivable from the evidence id alone). `contentType` is
 * pinned to the allowlisted MIME; downloads re-assert `nosniff` regardless.
 */
export async function putEvidenceFile(
  id: string,
  body: Uint8Array,
  contentType: string,
): Promise<{ blobId: string; url: string }> {
  const token = requireToken();
  const blobId = newEvidenceId();
  const pathname = filePath(id, blobId);
  let result: PutBlobResult;
  try {
    result = await put(pathname, Buffer.from(body), {
      access: "public",
      contentType,
      token,
      // The pathname already carries two unguessable ids; a random suffix would
      // only make the stored path differ from the one we compute to read it back.
      addRandomSuffix: false,
    });
  } catch (error) {
    throw new EvidenceStoreError(
      `Failed to store evidence file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { blobId, url: result.url };
}

/** Store the manifest for an evidence id (canonical JSON, stored verbatim). */
export async function putEvidenceManifest(
  id: string,
  manifest: EvidenceManifest,
): Promise<void> {
  const token = requireToken();
  try {
    await put(manifestPath(id), JSON.stringify(manifest), {
      access: "public",
      contentType: "application/json",
      token,
      addRandomSuffix: false,
    });
  } catch (error) {
    throw new EvidenceStoreError(
      `Failed to store evidence manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Fetch and parse the manifest for an evidence id, or null when absent. */
export async function getEvidenceManifest(
  id: string,
): Promise<EvidenceManifest | null> {
  const token = requireToken();
  const meta = await head(manifestPath(id), { token }).catch(() => null);
  if (meta === null) return null;
  const response = await fetch(meta.url);
  if (!response.ok) return null;
  return (await response.json()) as EvidenceManifest;
}

/** Fetch a stored file's bytes by its blob id, or null when absent. */
export async function getEvidenceFile(
  id: string,
  blobId: string,
): Promise<{ body: ArrayBuffer; contentType: string | null } | null> {
  const token = requireToken();
  const meta = await head(filePath(id, blobId), { token }).catch(() => null);
  if (meta === null) return null;
  const response = await fetch(meta.url);
  if (!response.ok) return null;
  return { body: await response.arrayBuffer(), contentType: meta.contentType };
}

/** Delete one evidence id's manifest (admin / retention use). */
export async function deleteEvidence(id: string): Promise<void> {
  const token = requireToken();
  await del([manifestPath(id)], { token }).catch(() => {
    /* best-effort: a missing manifest is already gone */
  });
}
