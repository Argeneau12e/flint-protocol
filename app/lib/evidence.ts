/**
 * Evidence pipeline — the manifest, its canonical form, and its hash.
 *
 * Section 13.7: `evidence_hash` on chain is the SHA-256 of a **canonical JSON
 * manifest** (sorted keys, no whitespace) describing the delivered work, and
 * `evidence_ref` is a compact locator (`flint://e/<id>`, at most 96 bytes) the
 * app resolves. `/verify` reads the on-chain hash, fetches the manifest,
 * recomputes its hash and compares — and compares any dropped file's own
 * SHA-256 against the manifest's items. All-zeros is the "no claim" sentinel
 * and is refused as a claim hash.
 *
 * This module is the single source of that hashing so the browser (which hashes
 * each file before upload), the upload route (which commits the manifest), and
 * the verifier (which recomputes it) can never drift. Hashing uses the Web
 * Crypto API (`globalThis.crypto.subtle`) on purpose: it is the same primitive
 * in the browser and in Node 18+, so one implementation serves both.
 */

/** Manifest schema version. Bump only on a breaking change to the shape. */
export const MANIFEST_VERSION = 1;

/** One piece of evidence. The six core fields are present on every kind. */
export interface EvidenceItem {
  /** file | link | note. */
  kind: "file" | "link" | "note";
  /** Display name: filename, link label, or note title. */
  name: string;
  /** Bytes for a file; 0 for a link; UTF-8 byte length for a note. */
  size: number;
  /** MIME type for a file (from the allowlist); "" for a link or note. */
  mime: string;
  /** Hex SHA-256: of the file bytes, the URL, or the note text. */
  sha256: string;
  /** Storage id (unguessable) for a file; "" for a link or note (inline). */
  blobId: string;
  /** Absolute http(s) URL — link only. */
  url?: string;
  /** Note body — note only. */
  text?: string;
}

/** The canonical evidence manifest committed on chain by its hash. */
export interface EvidenceManifest {
  version: number;
  /** The agreement address (base58) this evidence belongs to. */
  agreement: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  items: EvidenceItem[];
}

/**
 * Canonical JSON: object keys sorted, no insignificant whitespace, arrays in
 * order, `undefined`/functions omitted. This is the exact byte string whose
 * SHA-256 is `evidence_hash`, so it must be byte-for-byte reproducible in the
 * browser, on the server, and in the verifier — which is why it is hand-rolled
 * rather than delegated to `JSON.stringify(value, null, 2)`.
 */
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

const textEncoder = new TextEncoder();

/**
 * Hex SHA-256 of a UTF-8 string or raw bytes, via the Web Crypto API.
 *
 * Async because `crypto.subtle.digest` is. The same call runs in the browser
 * (where the file is hashed before upload) and in Node 18+ (where the route and
 * the verifier run), which is the whole reason this is Web Crypto and not
 * `node:crypto`.
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The manifest's evidence hash: hex SHA-256 of its canonical JSON. */
export async function evidenceHash(manifest: unknown): Promise<string> {
  return sha256Hex(canonicalJson(manifest));
}

/** The all-zeros sentinel the program reserves for "no claim yet". */
export const NO_CLAIM_HASH = "00".repeat(32);

/** Decode a hex string to bytes, for the on-chain `[u8; 32]` claim argument. */
export function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`Not a hex string: "${hex}"`);
  }
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

/** Build a manifest with a stable version, agreement and timestamp. */
export function buildManifest(
  agreement: string,
  items: EvidenceItem[],
  createdAt: string = new Date().toISOString(),
): EvidenceManifest {
  return { version: MANIFEST_VERSION, agreement, createdAt, items };
}

/**
 * True when a recomputed manifest hash equals the on-chain hash.
 *
 * `onChainHash` is the hex string read from the agreement's `evidence_hash`
 * field. The all-zeros sentinel never matches a real manifest, so an unclaimed
 * agreement can never verify.
 */
export async function manifestMatchesHash(
  manifest: unknown,
  onChainHash: string,
): Promise<boolean> {
  if (onChainHash === NO_CLAIM_HASH) return false;
  const recomputed = await evidenceHash(manifest);
  return timingSafeEqualHex(recomputed, onChainHash);
}

/** Find the manifest item a dropped file's hash belongs to, if any. */
export function findItemByHash(
  manifest: EvidenceManifest,
  fileHashHex: string,
): EvidenceItem | undefined {
  return manifest.items.find(
    (item) => item.kind === "file" && item.sha256.toLowerCase() === fileHashHex.toLowerCase(),
  );
}

/** Constant-time hex comparison, so a verify endpoint leaks nothing by timing. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Upload allowlist (Section 13 / task): images *except* SVG, pdf, zip, txt,
// md, docx, xlsx, csv. SVG and any HTML are deliberately absent — an uploaded
// SVG or HTML document is script that would run in the origin that serves it,
// so it is never accepted, and downloads are forced to `attachment` +
// `nosniff` regardless (see the [id] route).
// ---------------------------------------------------------------------------

/** Extension (lowercase, no dot) -> the MIME types that extension may carry. */
export const ALLOWED_UPLOADS: Readonly<Record<string, readonly string[]>> = {
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  pdf: ["application/pdf"],
  zip: ["application/zip", "application/x-zip-compressed"],
  txt: ["text/plain"],
  md: ["text/markdown"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  csv: ["text/csv"],
};

/** The lowercased extension of a filename, or "" when it has none. */
export function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * True when `filename`'s extension is allowlisted and `mime` is one of the MIME
 * types that extension may carry. Both must agree: a `.png` claiming
 * `text/html` is refused, which is what stops a script wearing an image name.
 */
export function isAllowedUpload(filename: string, mime: string): boolean {
  const ext = fileExtension(filename);
  const allowed = ALLOWED_UPLOADS[ext];
  if (allowed === undefined) return false;
  return allowed.includes(mime.toLowerCase());
}

/** Build a download Content-Disposition header (RFC 5987), forcing attachment. */
export function downloadDisposition(filename: string): string {
  const safe = filename.replace(/[\r\n"\\]/g, "");
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}