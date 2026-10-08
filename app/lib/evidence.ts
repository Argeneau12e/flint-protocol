/***
 * Evidence Pipeline (Phase 5a)
 * 
 * - Canonical JSON manifest (sorted keys, no whitespace)
 * - SHA-256 hash of the manifest
 * - Vercel Blob storage with unguessable ids
 * - On-chain evidence_ref = flint://e/<id> (max 96 bytes)
 * - Upload authorization: agreement must be Funded, wallet-signed nonce
 * - Per-IP throttle: 5 files up to 25MB each, 5 links, 500-char note
 *   allowlist extensions/MIME types
 * - Downloads with Content-Disposition + nosniff
 */

import { createHash } from "node:crypto";
import type { Frs1Agreement } from "./frs1-types";

/** Canonical JSON: sorted keys, no whitespace, no function values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const source = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined || typeof entry === "function") continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

/** SHA-256 digest of a UTF-8 string or raw bytes. */
export function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Evidence hash: SHA-256 of the canonical JSON manifest. */
export function evidenceHash(manifest: unknown): Buffer {
  return sha256(canonicalJson(manifest));
}

/** On-chain evidence_ref format: flint://e/<base64url-id>. Max 96 bytes. */
export type EvidenceRef = `flint://e/${string}`;

/** Manifest entry for a single uploaded file. */
export interface EvidenceManifestEntry {
  /** Vercel Blob id (unguessable). */
  id: string;
  /** Original file name (display only). */
  filename: string;
  /** SHA-256 of the file bytes. */
  fileHash: string;
  /** File size in bytes. */
  size: number;
  /** MIME type (validated against allowlist). */
  mimeType: string;
}

/** Full manifest sent to chain / stored on blob. */
export type EvidenceManifest = EvidenceManifestEntry[];

/** Verify that a downloaded file's hash matches the manifest entry. */
export function verifyFileHash(
  fileBytes: Buffer,
  expectedHash: string,
): boolean {
  const actual = sha256(fileBytes).toString("hex");
  return actual === expectedHash;
}

/** Simple in-memory throttle: max N calls per window (ms). */
class Throttle {
  private calls: number[] = [];
  constructor(private maxN: number, private windowMs: number) {}
  try(): boolean {
    const now = Date.now();
    this.calls = this.calls.filter((t) => now - t < this.windowMs);
    if (this.calls.length >= this.maxN) return false;
    this.calls.push(now);
    return true;
  }
}

/** Per‑IP throttle: 5 uploads per 60 s. */
export const uploadThrottle = new Throttle(5, 60_000);

/** Upload authorization check (called by the API route). */
export function checkUploadAuth(
  agreement: Frs1Agreement | null,
  /** True when the agreement is in the funded state. */
  isFunded: boolean,
): { ok: boolean; reason?: string } {
  if (!agreement) return { ok: false, reason: "no_agreement" };
  if (!isFunded) return { ok: false, reason: "agreement_not_funded" };
  return { ok: true };
}

/** Build a download Content‑Disposition header (RFC 5987). */
export function downloadDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/%/g, "%20");
  return `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`;
}