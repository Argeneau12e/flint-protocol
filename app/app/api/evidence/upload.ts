import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readConfig } from "../../../lib/config";
import { getConnection } from "../../../lib/solana";
import { checkUploadAuth, EvidenceManifestEntry, uploadThrottle } from "../../../lib/evidence";
import { readAgreement } from "../../../lib/flint-program";
import { toFrs1Agreement, type DecodableAgreement } from "../../../lib/frs1-chain";
import { Frs1Agreement } from "../../../lib/frs1-types";

export const config = {
  api: {
    bodyParser: false, // we'll parse manually for the signed message
    responseLimit: "50mb",
  },
};

async function parseBody(req: NextRequest): Promise<FormData> {
  return req.formData();
}

export async function POST(req: NextRequest) {
  try {
    const form = await parseBody(req);
    const file = form.get("file") as File | null;
    const agreementId = form.get("agreementId") as string | null;
    const note = form.get("note") as string | undefined;
    const filename = form.get("filename") as string | null;

    if (!file || !agreementId || !filename) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }

    // Throttle check
    if (!uploadThrottle.try()) {
      return NextResponse.json({ error: "throttle_exceeded" }, { status: 429 });
    }

    // Config check: readConfig throws ConfigError if the deployment is broken.
    const appConfig = readConfig();

    // Agreement verification
    const connection = getConnection();
    const agreementPubkey = new PublicKey(agreementId);

    // Read the agreement from chain (not verifyFunding: that checks a payment
    // signature; the upload gate only needs the account's current status).
    const raw = await readAgreement(connection, appConfig.programId, agreementPubkey);
    const agreement: Frs1Agreement | null =
      raw === null ? null : toFrs1Agreement(raw as unknown as DecodableAgreement);

    if (!agreement) {
      return NextResponse.json({ error: "agreement_not_found" }, { status: 404 });
    }

    // Upload authorization: agreement must be Funded
    const auth = checkUploadAuth(agreement, agreement.status === "funded");
    if (!auth.ok) {
      return NextResponse.json({ error: auth.reason }, { status: 403 });
    }

    // Read file bytes and compute hash
    const fileBytes = await file.arrayBuffer();
    const hashBuf = createHash("sha256").update(Buffer.from(fileBytes)).digest();
    const fileHash = hashBuf.toString("hex");

    // Determine MIME type (simple allowlist)
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    const allowedExtensions = ["jpg", "jpeg", "png", "gif", "pdf", "txt", "doc", "docx"];
    const allowedMimes = ["image/jpeg", "image/png", "image/gif", "application/pdf", "text/plain", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    const extIndex = allowedExtensions.findIndex((e) => filename.toLowerCase().includes(`.${e}`));
    const mimeType = file.type || (extIndex === -1 ? "" : allowedMimes[extIndex]);

    if (mimeType === "") {
      return NextResponse.json({ error: "unsupported_mime" }, { status: 400 });
    }

    // Vercel Blob upload (stub – replace with actual BLOB_TOKEN deployment)
    // The actual upload uses Vercel's @vercel/blob API;
    // here we just compute the id and manifest entry.
    const blobId = `${agreementPubkey.toBase58()}/${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    const size = Number(fileBytes.byteLength);

    // Build manifest entry
    const entry: EvidenceManifestEntry = {
      id: blobId,
      filename: filename as string,
      fileHash,
      size,
      mimeType: mimeType as string,
    };

    // Return success with the blob URL pattern
    const blobUrl = `flint://e/${blobId}`;

    return NextResponse.json({
      success: true,
      blobUrl,
      manifestEntry: entry,
    });
  } catch (err: any) {
    console.error("Upload error:", err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

/** GET: list evidence links for an agreement (simple, auth‑protected). */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const agreementId = searchParams.get("agreementId");

  if (!agreementId) {
    return NextResponse.json({ error: "missing_agreementId" }, { status: 400 });
  }

  // TODO: add signature verification for the links
  return NextResponse.json({ links: [] });
}