/**
 * Evidence submit errors + message signing (Task 3, item 2, part 3a).
 */

"use client";

export function friendlyUploadError(code: string, status: number): string {
  if (status === 429) return "Too many uploads at once. Wait a minute and try again.";
  if (code === "too_many_files") return "Too many files were sent. Attach at most 5.";
  if (code === "too_many_links") return "Too many links were sent. Add at most 5.";
  if (code === "file_too_large") return "One file is larger than 25 MB. Compress it and try again.";
  if (code === "unsupported_type") return "One file has an unsupported type. Use images (not SVG), PDF, ZIP, TXT, Markdown, DOCX, XLSX or CSV.";
  if (code === "bad_link") return "One link is not a valid http or https address.";
  if (code === "note_too_long") return "The note is longer than 500 characters.";
  if (code === "no_evidence") return "Add at least one file, link or note before submitting.";
  if (code === "agreement_not_found") return "The agreement was not found on chain. It may have been cancelled.";
  if (code.startsWith("agreement_not_funded")) return "This agreement is no longer awaiting delivery, so proof cannot be submitted.";
  if (code.startsWith("nonce_")) return "The upload pass expired. Try again for a fresh one.";
  if (code === "bad_signature") return "The wallet signature did not match. Try again.";
  if (status === 503) return "Evidence storage is not available right now. Try again later.";
  return "The upload failed. Check your connection and try again.";
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Sign the upload message; throws a plain-language Error on failure. */
export async function signUploadMessage(
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined,
  message: string,
): Promise<string> {
  if (typeof signMessage !== "function") {
    throw new Error("This wallet cannot sign messages. Reconnect a wallet that supports message signing, such as Phantom.");
  }
  let signed: Uint8Array;
  try {
    signed = await signMessage(new TextEncoder().encode(message));
  } catch (cause) {
    const text = cause instanceof Error ? cause.message : "";
    if (/reject|declin|denied|cancel/i.test(text)) {
      throw new Error("You declined the signature, so nothing was uploaded.");
    }
    throw new Error(text === "" ? "The wallet could not sign the upload message." : text);
  }
  return encodeBase64(signed);
}
