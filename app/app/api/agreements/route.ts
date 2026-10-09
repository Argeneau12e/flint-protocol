/**
 * Create the transaction for a new agreement (Phase 3, acceptance 7.1.1).
 *
 * POST-only: it builds the `create` instruction a recipient is about to sign, so
 * it is the one endpoint in the human flow that is not about an existing
 * agreement. Still POST, still no key material — the server proposes, the
 * recipient's wallet signs.
 *
 * The uuid is minted here, on the server, rather than in the browser, and that is
 * not incidental. The id is half of the agreement's identity (the other half is
 * the recipient, a PDA seed — Section 4.5), and the link the recipient then shares
 * has to carry the same bytes the program stored. Generating it once, here, and
 * returning it in the response removes any possibility of the two sides
 * disagreeing about it; `newUuidBytes` sets the version and variant nibbles
 * (Section 6.3) so the published uuid still maps back to those exact bytes.
 *
 * `recipient` is the address the wallet says it is. It is used to derive the PDA
 * and is not otherwise trusted — the program makes that same address the only
 * signer of `create`, so a mismatch simply fails to sign.
 */

import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { getConnection } from "../../../lib/solana";
import { readConfig, ConfigError } from "../../../lib/config";
import {
  DEFAULT_CONDITION_DESCRIPTION,
  buildCreateTransaction,
  serializeForClient,
} from "../../../lib/flint-program";
import { newUuidBytes, formatUuid } from "../../../lib/frs1-chain";
import { chainNowSeconds } from "../../../lib/chain-clock";
import { parseDisplayAmount } from "../../../lib/display";
import { internalFailureMessage, logInternalFailure } from "../../../lib/errors";
import { isEmailAddress } from "../../../lib/notify";
import { recordPayerEmail } from "../../../lib/payer-email";

export const dynamic = "force-dynamic";

/** Field bounds, from the account layout (Section 4.6). */
const LIMITS = { title: 128, memo: 512, handle: 64 } as const;

function fail(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  let config;
  try {
    config = readConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      return fail(`Flint is not configured: ${error.problems.join("; ")}`, 503);
    }
    throw error;
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail("The request body was not valid JSON.");
  }

  const recipientRaw = body.recipient;
  if (typeof recipientRaw !== "string" || recipientRaw === "") {
    return fail("The recipient's wallet address is required — it is who signs the agreement.");
  }
  let recipient: PublicKey;
  try {
    recipient = new PublicKey(recipientRaw);
  } catch {
    return fail(`"${recipientRaw}" is not a valid Solana address.`);
  }

  // ---- terms, validated with a reason for every rejection (Section 9) ----
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title === "") {
    return fail("Give the agreement a title, so the payer knows what they are paying for.");
  }
  if (Buffer.byteLength(title, "utf8") > LIMITS.title) {
    return fail(
      `The title is too long: at most ${LIMITS.title} bytes, this one is ${Buffer.byteLength(title, "utf8")}.`,
    );
  }

  let decimals: number;
  try {
    decimals = (await getMint(getConnection(), config.assetMint)).decimals;
  } catch {
    return fail("The configured asset mint could not be read from Solana devnet.", 502);
  }

  const parsed = parseDisplayAmount(typeof body.amount === "string" ? body.amount : "", decimals);
  if (!parsed.ok) return fail(parsed.error);

  const memo = typeof body.memo === "string" ? body.memo.trim() : "";
  if (Buffer.byteLength(memo, "utf8") > LIMITS.memo) {
    return fail(`The note is too long: at most ${LIMITS.memo} bytes.`);
  }

  const handle = typeof body.handle === "string" ? body.handle.trim() : "";
  if (Buffer.byteLength(handle, "utf8") > LIMITS.handle) {
    return fail(`The handle is too long: at most ${LIMITS.handle} bytes.`);
  }

  // Optional payer email (task item 10). Purely a notification address: it is
  // never sent on chain and never affects authorization. A malformed address is
  // rejected up front rather than stored and bounced later; an absent one is
  // simply not stored.
  const payerEmailRaw = typeof body.payerEmail === "string" ? body.payerEmail.trim() : "";
  if (payerEmailRaw !== "" && !isEmailAddress(payerEmailRaw)) {
    return fail("That does not look like an email address.");
  }

  // ---- expiry, checked against the chain clock and the program's own rule ----
  const minutes = typeof body.expiryMinutes === "number" ? body.expiryMinutes : NaN;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return fail("Choose how long this agreement stays payable — a positive number of minutes.");
  }
  if (minutes > 525600) {
    return fail("An expiry more than a year out is not a payment term. Choose at most 12 months.");
  }

  const now = await chainNowSeconds(getConnection());
  const expiresAt = now + Math.floor(minutes * 60);
  if (expiresAt <= now) {
    // Unreachable with a positive `minutes`, but the program's check is
    // unconditional and this route must never build a transaction it knows will
    // be rejected.
    return fail("That expiry is not in the future.");
  }

  const id = newUuidBytes();
  const uuid = formatUuid(id);

  try {
    const transaction = await buildCreateTransaction(getConnection(), config.programId, recipient, {
      id,
      amount: parsed.baseUnits,
      asset: config.assetMint,
      expiresAt,
      title,
      memo,
      ...(handle === "" ? {} : { handle }),
    });
    // Only once the transaction actually builds: a failed build must not leave a
    // notification record for an agreement that will never exist.
    if (payerEmailRaw !== "") recordPayerEmail(uuid, payerEmailRaw);
    return new Response(
      JSON.stringify(
        {
          transaction: serializeForClient(transaction),
          id: uuid,
          recipient: recipient.toBase58(),
          message:
            "Approve this in your wallet to create the agreement. This stores the terms and opens a small escrow account; it does not move any money. Whoever funds the agreement first becomes the payer.",
          condition: { type: "manual-confirmation", description: DEFAULT_CONDITION_DESCRIPTION },
        },
        null,
        2,
      ),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      },
    );
  } catch (cause) {
    // Internal failure, so the detail goes to the log rather than to the caller
    // (see lib/errors.ts).
    logInternalFailure("building the create transaction", cause);
    return fail(internalFailureMessage(), 500);
  }
}
