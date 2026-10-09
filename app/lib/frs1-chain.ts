/**
 * On-chain account -> FRS-1 object, at the app boundary (Section 4.5).
 *
 * One direction, one function, used by the x402 responder, the verification page,
 * the verifier and the tests. That is deliberate: Section 7.2.5 requires that an
 * agent-settled agreement and a human-settled one be verified *identically*, and
 * the cheapest honest way to guarantee that is to have exactly one reader.
 *
 * Encoding rules being applied (Section 4.5):
 *   - `u64` amounts and timestamps become strings / numbers, never JS floats;
 *   - `Option<T>` becomes `T | null`;
 *   - the on-chain `condition_type` becomes the FRS-1 `type` kebab-case value;
 *   - symbols (e.g. "USDC") are **not** on chain: they are an app-layer lookup
 *     and are never part of the agreement object;
 *   - `receiptProof` is never read from the account in v1 (Section 4.7): the
 *     settlement signature is supplied by the caller that actually has it.
 */

import type {
  Frs1Agreement,
  ConditionType,
  AgreementStatus,
  DisputeReason,
} from "./frs1-types";

/** The Anchor-decoded account shape this module consumes (Section 13.1). */
export interface DecodableAgreement {
  id: number[] | Buffer;
  payerAddress: { toBase58(): string } | null;
  recipientAddress: { toBase58(): string };
  title: string;
  amount: { toString(): string };
  asset: { toBase58(): string };
  escrowAddress: { toBase58(): string };
  memo: string;
  expiresAt: { toNumber(): number };
  status: Record<string, Record<string, never>>;
  condition: {
    conditionType: Record<string, Record<string, never>>;
    description: string;
  };
  reviewWindowSecs: number;
  claimedAt: { toNumber(): number } | null;
  evidenceHash: number[] | Buffer;
  evidenceRef: string;
  disputedAt: { toNumber(): number } | null;
  arbiterDeadline: { toNumber(): number } | null;
  disputeReason: Record<string, Record<string, never>> | null;
  feeAmount: { toString(): string };
  handle?: string | null;
  agentPolicy?: { spendCap: { toString(): string }; allowlist: { toBase58(): string }[] } | null;
}

/**
 * Formats the on-chain 16 bytes as a uuid string.
 *
 * The program stores raw bytes, not a formatted uuid, so version/variant nibbles
 * are set here (RFC 4122 v4 layout) to make the value render as the kind of
 * identifier the schema claims it is. This is a display convention only — the
 * bytes are what identify the agreement.
 */
export function formatUuid(id: Buffer | number[]): string {
  const bytes = Buffer.from(id);
  const v = Buffer.from(bytes);
  v[6] = (v[6] & 0x0f) | 0x40; // version 4
  v[8] = (v[8] & 0x3f) | 0x80; // variant 1
  const hex = v.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * The 16 raw bytes behind a formatted uuid.
 */
export function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Not a uuid: "${uuid}"`);
  }
  return Buffer.from(hex, "hex");
}

/**
 * Generates the 16 bytes for a *new* agreement id, as a uuid-v4.
 *
 * Round-trip requirement, and the reason this exists rather than a bare
 * `randomBytes(16)`: the published `id` must map back to exactly the bytes the
 * program stored, because anyone reading an FRS-1 object re-derives the agreement
 * PDA from `id` + `recipientAddress` (Section 4.5). `formatUuid` sets the version
 * and variant nibbles, so bytes that did not already have them would render as a
 * uuid that no longer describes the stored account — the payer would compute a
 * different PDA and refuse a perfectly valid agreement.
 *
 * So: ids are generated here, and the masking in `formatUuid` is a no-op for them.
 *
 * Web Crypto (`globalThis.crypto.getRandomValues`) rather than `node:crypto`,
 * so this module stays importable from client components: the bytes are the
 * same 16 random bytes either way, and every runtime this build targets
 * (Node 18+, modern browsers) provides Web Crypto.
 */
export function newUuidBytes(): Buffer {
  const bytes = Buffer.alloc(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  return bytes;
}

/**
 * Reads the single-key Anchor enum. Unknown keys are a hard error: silently
 * coercing an unrecognised status would let a verification page render a lie.
 */
function readEnumKey(
  value: Record<string, Record<string, never>> | undefined,
  where: string,
): string {
  const keys = Object.keys(value ?? {});
  if (keys.length !== 1) {
    throw new Error(
      `Expected exactly one key for ${where}, got [${keys.join(", ")}] — the IDL and the deployed program may be out of step`,
    );
  }
  return keys[0];
}

/** Anchor `{ pending: {} }` -> FRS-1 `"pending"` (Section 13.2). */
export function toFRS1Status(
  value: Record<string, Record<string, never>>,
): AgreementStatus {
  switch (readEnumKey(value, "status")) {
    case "pending":
      return "pending";
    case "funded":
      return "funded";
    case "deliveryClaimed":
      return "deliveryClaimed";
    case "disputed":
      return "disputed";
    case "released":
      return "released";
    case "refunded":
      return "refunded";
    case "split":
      return "split";
    case "cancelled":
      return "cancelled";
    default:
      // Unreachable: a program cannot produce a status this build does not know,
      // and an unknown one must fail loudly rather than render as something else.
      throw new Error(`Unknown agreement status: ${readEnumKey(value, "status")}`);
  }
}

/** Anchor `{ manualConfirmation: {} }` -> FRS-1 `"manual-confirmation"`. */
export function toFRS1ConditionType(
  value: Record<string, Record<string, never>>,
): ConditionType {
  switch (readEnumKey(value, "condition.type")) {
    case "manualConfirmation":
      return "manual-confirmation";
    case "oracleAttested":
      return "oracle-attested";
    default:
      throw new Error(
        `Unknown condition type: ${readEnumKey(value, "condition.type")}`,
      );
  }
}

/**
 * Anchor `{ notAsDescribed: {} }` -> FRS-1 `"notAsDescribed"`.
 *
 * The on-chain enum stores only the PascalCase variant name; the FRS-1
 * `DISPUTE_REASON_CODES` mapping is index + 1 of that variant. Unknown keys
 * fail loudly, exactly like an unknown status: a dispute reason that renders
 * as the wrong category would mislead the recipient and the arbiter.
 */
export function toFRS1DisputeReason(
  value: Record<string, Record<string, never>>,
): DisputeReason {
  switch (readEnumKey(value, "disputeReason")) {
    case "notAsDescribed":
      return "notAsDescribed";
    case "incomplete":
      return "incomplete";
    case "notReceived":
      return "notReceived";
    case "quality":
      return "quality";
    case "other":
      return "other";
    default:
      throw new Error(
        `Unknown dispute reason: ${readEnumKey(value, "disputeReason")}`,
      );
  }
}

/**
 * Converts a decoded account into the FRS-1 object.
 *
 * `receiptProof` is passed in, never read from the account (Section 4.7). A
 * caller that has a settlement signature may attach it; every other caller gets
 * `undefined`, which is the honest state of an unsettled agreement.
 */
export function toFrs1Agreement(
  account: DecodableAgreement,
  receiptProof?: string,
): Frs1Agreement {
  const agreement: Frs1Agreement = {
    id: formatUuid(account.id),
    payerAddress: account.payerAddress
      ? account.payerAddress.toBase58()
      : null,
    recipientAddress: account.recipientAddress.toBase58(),
    title: account.title,
    amount: account.amount.toString(),
    asset: account.asset.toBase58(),
    escrowAddress: account.escrowAddress.toBase58(),
    memo: account.memo,
    expiresAt: account.expiresAt.toNumber(),
    status: toFRS1Status(account.status),
    condition: {
      type: toFRS1ConditionType(account.condition.conditionType),
      description: account.condition.description,
    },
    reviewWindowSecs: account.reviewWindowSecs,
    claimedAt: account.claimedAt ? account.claimedAt.toNumber() : null,
    evidenceHash: Buffer.from(account.evidenceHash).toString("hex"),
    evidenceRef: account.evidenceRef,
    disputedAt: account.disputedAt ? account.disputedAt.toNumber() : null,
    arbiterDeadline: account.arbiterDeadline ? account.arbiterDeadline.toNumber() : null,
    disputeReason:
      account.disputeReason === null ? null : toFRS1DisputeReason(account.disputeReason),
    feeAmount: account.feeAmount.toString(),
  };

  if (account.handle !== undefined && account.handle !== null) {
    agreement.handle = account.handle;
  }
  if (account.agentPolicy) {
    agreement.agentPolicy = {
      spendCap: account.agentPolicy.spendCap.toString(),
      allowlist: account.agentPolicy.allowlist.map((a) => a.toBase58()),
    };
  }
  if (receiptProof) {
    agreement.receiptProof = receiptProof;
  }
  return agreement;
}
