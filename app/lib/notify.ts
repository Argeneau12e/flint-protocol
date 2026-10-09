/**
 * Optional payer email (task item 10).
 *
 * When an email was entered at creation, the payer can be told that a delivery
 * claim was recorded and their review window is open. Everything here is
 * best-effort and side-effect only: the feature is *optional*, so a deployment
 * with no `RESEND_API_KEY` returns `{ sent: false, reason: "not_configured" }`
 * without throwing — "skip silently if not configured" — and a Resend failure
 * is caught and reported, never propagated to the caller, because a notification
 * must not be able to fail a payment flow.
 *
 * No key material lives here: Resend authenticates with the API key from the
 * environment, and the sender/subject are fixed server-side, so a caller cannot
 * turn this into an open relay — only "the payer of agreement X was told about
 * claim Y", with the body composed from on-chain facts.
 */

/** What a send attempt did, in every case. */
export interface EmailResult {
  sent: boolean;
  reason?: "not_configured" | "missing_recipient" | "send_failed" | "ok";
}

/** Basic shape check: something@something.tld, no control characters. */
export function isEmailAddress(value: string): boolean {
  if (value.length > 254 || /[\r\n\0]/.test(value)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** The Resend key, or null when the deployment did not configure email. */
export function resendApiKey(): string | null {
  const key = process.env.RESEND_API_KEY;
  return key === undefined || key.trim() === "" ? null : key.trim();
}

/** The fixed sender address. Resend requires a verified domain identity. */
const FROM = "Flint <no-reply@flint.example>";

/**
 * Send the "delivery evidence submitted" email to the payer.
 *
 * Returns a result rather than throwing in every path, so callers can `await`
 * it inline and carry on. `reviewWindowEndsAt` is a Unix second; the email says
 * when the window closes so the payer knows their deadline.
 */
export async function sendClaimReviewEmail(params: {
  to: string;
  agreementId: string;
  title: string;
  reviewWindowEndsAt: number;
}): Promise<EmailResult> {
  const apiKey = resendApiKey();
  if (apiKey === null) return { sent: false, reason: "not_configured" };
  if (!isEmailAddress(params.to)) return { sent: false, reason: "missing_recipient" };

  const deadline = new Date(params.reviewWindowEndsAt * 1000).toISOString();
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: FROM,
      to: params.to,
      subject: `Delivery claimed: ${params.title}`,
      text:
        `The recipient prepared delivery evidence for your Flint agreement ` +
        `"${params.title}" and is about to claim delivery on chain.\n\n` +
        `Agreement: ${params.agreementId}\n` +
        `Review window: ${Math.round((params.reviewWindowEndsAt - Date.now() / 1000) / 3600)}h ` +
        `(closes about ${deadline})\n\n` +
        `Once the claim lands you can dispute it while the window is open, if the ` +
        `work is not what was agreed. If you do nothing, the escrow releases to the ` +
        `recipient when the window closes.`,
    });
    if (error !== null) return { sent: false, reason: "send_failed" };
    return { sent: true, reason: "ok" };
  } catch {
    // A notification must never break a payment flow: swallow and report.
    return { sent: false, reason: "send_failed" };
  }
}
