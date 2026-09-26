/**
 * Reading one agreement, server-side, from chain (Phase 3).
 *
 * Every human-flow surface needs the same three things: the agreement's live
 * state, whether the chain clock says it has expired, and the display-only
 * decimal scale of its asset. The create page, the agreement page and the Blink
 * endpoint all need them, and all of them must agree — a Blink that says
 * "expires in 4 minutes" while the page the payer opens says "expired" is a
 * broken payment, not a cosmetic bug.
 *
 * So there is one reader. It reads the account directly (Section 6.2:
 * verification is chain-derived, never cached UI state), derives the PDA from
 * `id` + `recipient` rather than trusting a client-supplied address, and gets its
 * notion of "now" from the Clock sysvar like everything else (Section 4.5) — a
 * container's host clock can be hours off, and an agreement must never appear
 * expired or live because of that.
 *
 * SERVER-ONLY by construction: it reads configuration, never a private key.
 */

import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import { chainNowSeconds } from "./chain-clock";
import { readConfig } from "./config";
import { agreementPda, readAgreement, type RawAgreement } from "./flint-program";
import { toFrs1Agreement, type DecodableAgreement } from "./frs1-chain";
import { formatBaseUnits } from "./display";
import type { Frs1Agreement } from "./frs1-types";

/** A link that cannot address an agreement. */
export class BadAgreementRefError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "BadAgreementRefError";
  }
}

/**
 * The account does not exist.
 *
 * Distinct from "this is not a real agreement": a *cancelled* agreement is a
 * closed account and is a perfectly good answer (Section 4.6), while a
 * recipient/id pair that never existed is a bad link. Both are reported rather
 * than rendered as an empty page.
 */
export class AgreementNotFoundError extends Error {
  constructor(readonly pda: string) {
    super(`No agreement account at ${pda}.`);
    this.name = "AgreementNotFoundError";
  }
}

export interface AgreementView {
  /** The uuid, as published in the link. */
  id: string;
  /** The recipient's address — a PDA seed (Section 4.5). */
  recipient: string;
  /** The agreement PDA. */
  pda: string;
  /** The escrow's SPL token account, where the money actually sits (Section 4.5). */
  escrow: string;
  agreement: Frs1Agreement;
  /** Chain clock, in unix seconds. The only time source (Section 4.5). */
  now: number;
  /** `now >= expiresAt` — the condition that makes refund available (Section 4.2). */
  expired: boolean;
  /** Display-only decimal scale of `asset`, or `null` if the mint is unreadable. */
  decimals: number | null;
  /** Display-only symbol. Never on chain (Section 4.5). */
  symbol: string;
  /** `formatBaseUnits` applied, for rendering. Equals the raw base units when the
   *  mint could not be read, so the exact integer is never hidden by a guess. */
  amountDisplay: string;
  /** Seconds until expiry; negative once expired. */
  secondsUntilExpiry: number;
}

function readRef(
  id: string | undefined,
  recipient: string | null,
): { id: string; recipient: PublicKey } {
  if (id === undefined || id === "") {
    throw new BadAgreementRefError("The link is missing the agreement id.");
  }
  if (recipient === null || recipient === "") {
    // The recipient is a PDA seed, so a link without it addresses nothing.
    throw new BadAgreementRefError(
      "The link is missing the recipient address, which is part of the agreement's identity.",
    );
  }
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    throw new BadAgreementRefError(`"${id}" is not a uuid, so it cannot be an agreement id.`);
  }
  let recipientKey: PublicKey;
  try {
    recipientKey = new PublicKey(recipient);
  } catch {
    throw new BadAgreementRefError(
      `"${recipient}" is not a valid Solana address, so no agreement can be looked up with it.`,
    );
  }
  return { id, recipient: recipientKey };
}

/** The raw account, for callers that need the decoded-but-unconverted shape. */
export async function loadRawAgreement(
  connection: Connection,
  programId: PublicKey,
  id: string | undefined,
  recipient: string | null,
): Promise<{ pda: PublicKey; recipient: PublicKey; raw: RawAgreement }> {
  const ref = readRef(id, recipient);
  const [pda] = agreementPda(ref.recipient, Buffer.from(ref.id.replace(/-/g, ""), "hex"), programId);
  const raw = await readAgreement(connection, programId, pda);
  if (raw === null) throw new AgreementNotFoundError(pda.toBase58());
  return { pda, recipient: ref.recipient, raw };
}

/**
 * Everything the human flow renders about one agreement, read fresh.
 *
 * `assetMint` is passed in rather than re-read from configuration so a page can
 * only ever display an agreement in the asset the agreement itself names — a
 * reader that silently substituted the deployment's default mint would render a
 * correct-looking wrong amount.
 */
export async function loadAgreementView(
  connection: Connection,
  programId: PublicKey,
  id: string | undefined,
  recipient: string | null,
  assetMint: PublicKey,
  symbol: string,
): Promise<AgreementView> {
  const { pda, raw } = await loadRawAgreement(connection, programId, id, recipient);
  const agreement = toFrs1Agreement(raw as unknown as DecodableAgreement);

  let decimals: number | null = null;
  try {
    decimals = (await getMint(connection, assetMint)).decimals;
  } catch {
    // A missing scale must not hide the amount: fall back to raw base units, which
    // is the authoritative value anyway.
    decimals = null;
  }

  const now = await chainNowSeconds(connection);
  return {
    id: agreement.id,
    recipient: agreement.recipientAddress,
    pda: pda.toBase58(),
    escrow:
      agreement.escrowAddress ||
      getAssociatedTokenAddressSync(assetMint, pda, true).toBase58(),
    agreement,
    now,
    expired: now >= agreement.expiresAt,
    decimals,
    symbol,
    amountDisplay:
      decimals === null ? agreement.amount : formatBaseUnits(agreement.amount, decimals),
    secondsUntilExpiry: agreement.expiresAt - now,
  };
}

/** The configured deployment, for the callers that just want the defaults. */
export function deployment() {
  const config = readConfig();
  return { programId: config.programId, assetMint: config.assetMint, symbol: config.assetSymbol };
}
