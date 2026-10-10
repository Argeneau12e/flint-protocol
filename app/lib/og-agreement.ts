/**
 * What a link-preview card needs about an agreement.
 *
 * Server-side only (chain reads over the configured RPC). Resolves the page's
 * address scheme — a bare agreement PDA, or a uuid plus `?recipient=` — to a
 * PDA, reads the account, and returns the stable display facts a card may
 * print. Any failure (bad address, missing account, RPC down) is `null`, and
 * callers render the generic card instead of erroring: a preview must never
 * 404 a share.
 *
 * Stable facts only: amount, asset name and shortened recipient. Never status,
 * never proof content.
 */

import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { getConnection } from "./solana";
import { DEFAULT_PROGRAM_ID, USDC_DEVNET_MINT } from "./config";
import { agreementPda, readAgreement } from "./flint-program";
import { toFrs1Agreement, uuidToBytes, type DecodableAgreement } from "./frs1-chain";
import { assetDisplay, formatBaseUnits } from "./display";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function programId(): PublicKey {
  const raw = process.env.NEXT_PUBLIC_PROGRAM_ID;
  if (raw !== undefined && raw !== "") {
    try {
      return new PublicKey(raw);
    } catch {
      // Fall through to the deployed default.
    }
  }
  return new PublicKey(DEFAULT_PROGRAM_ID);
}

/** Display the on-chain asset: USDC for Circle's devnet mint, Test USDC otherwise. */
function assetName(mint: string): string {
  if (mint === USDC_DEVNET_MINT) {
    return process.env.FLINT_ASSET_SYMBOL ?? "USDC";
  }
  return assetDisplay("TST").label;
}

export interface OgAgreement {
  /** "250 Test USDC" — the formatted figure and asset name. */
  amountLine: string;
  /** "to 7xKp…9dQ2" — shortened recipient for the "to" line. */
  recipientLine: string;
  /** The full recipient, for metadata text (never printed raw on the card). */
  recipient: string;
}

function shorten(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * Resolve `id` (+ optional `recipient` share-link param) to card facts.
 * Returns `null` on any failure.
 */
export async function readOgAgreement(
  id: string,
  recipientParam?: string,
): Promise<OgAgreement | null> {
  try {
    const pid = programId();
    let address: PublicKey;
    if (UUID_RE.test(id) && recipientParam !== undefined && recipientParam !== "") {
      const recipient = new PublicKey(recipientParam);
      const [pda] = agreementPda(recipient, uuidToBytes(id), pid);
      address = pda;
    } else {
      address = new PublicKey(id);
    }
    const connection = getConnection();
    const raw = await readAgreement(connection, pid, address);
    if (raw === null) return null;
    const agreement = toFrs1Agreement(raw as unknown as DecodableAgreement);
    let amount: string;
    try {
      const decimals = (await getMint(connection, new PublicKey(agreement.asset))).decimals;
      amount = `${formatBaseUnits(agreement.amount, decimals)} ${assetName(agreement.asset)}`;
    } catch {
      amount = `${agreement.amount} base units`;
    }
    return {
      amountLine: amount,
      recipientLine: `to ${shorten(agreement.recipientAddress)}`,
      recipient: agreement.recipientAddress,
    };
  } catch {
    return null;
  }
}
