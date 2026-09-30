/**
 * Verification: recomputing an agreement's facts from the chain (Sections 4.4,
 * 6.2, 7.2.5; threat-model row 7).
 *
 * The rule this module exists to enforce: **a receipt is a claim until it has
 * been recomputed.** Nothing here trusts a payload, a header, a stored string or
 * a previous render. Given a settlement signature, the report is built by reading
 * the agreement account, re-deriving its PDA from the account's own fields,
 * locating the instruction inside the transaction, and checking that what
 * actually happened matches the terms that were agreed.
 *
 * Two consequences worth stating:
 *   - the same function verifies a human-settled and an agent-settled agreement,
 *     because nothing in it knows which flow produced the transaction. That is
 *     how acceptance 7.2.5 is satisfied structurally rather than by a promise;
 *   - a forged or replayed receipt fails loudly. A signature that is not a
 *     settlement of *this* program, for *this* account, for *this* amount is not
 *     a receipt, whatever anyone claims.
 */

import { createHash } from "node:crypto";
import { getAccount } from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  type VersionedTransaction,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import type { Frs1Agreement } from "./frs1-types";
import { agreementPda, readAgreement } from "./flint-program";
import { toFrs1Agreement, type DecodableAgreement } from "./frs1-chain";
import { formatBaseUnits } from "./display";

/**
 * How an amount should read *to a person* in a check detail (Phase 5a).
 *
 * Optional everywhere: with no display configured (the x402 responder, every
 * test) the detail strings stay byte-identical to before — raw base units,
 * which is the correct machine-facing form. The verification page passes its
 * deployment's mint and symbol so the same check reads "2.5 USDC" instead.
 * An agreement on a *different* mint is deliberately left unformatted: a
 * symbol that was never confirmed for a mint is a lie a receipt must not tell.
 */
export interface VerifyDisplay {
  /** Base58 mint this deployment prices in. */
  mint: string;
  /** Decimals of that mint, read from chain. */
  decimals: number;
  /** Display-only symbol for that mint (Section 4.5). */
  symbol?: string;
}

/** Formats one amount for a human, or as raw base units when it cannot be trusted. */
function shownAmount(
  value: string | bigint,
  display: VerifyDisplay | undefined,
  mint: string,
): string {
  const raw = value.toString();
  if (display === undefined || mint !== display.mint) return `${raw} base units`;
  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;
  const figure = formatBaseUnits(digits, display.decimals);
  const symbol = display.symbol ? ` ${display.symbol}` : "";
  return `${negative ? "-" : ""}${figure}${symbol}`;
}

/** One named check in a report. Passes are recorded too — the report is evidence. */
export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** What the chain says about an agreement right now. */
export interface AgreementFacts {
  agreementPda: string;
  agreement: Frs1Agreement | null;
  escrowAddress: string | null;
  /** Escrow token balance in base units, as a string. */
  escrowBalance: string | null;
  escrowMint: string | null;
  escrowAuthority: string | null;
  /** `true` when the account does not exist — cancelled, or never created. */
  closed: boolean;
}

/** The verdict on one transaction. */
export interface VerificationReport {
  ok: boolean;
  /** The signature that was checked, or `null` when none could be read. */
  signature: string | null;
  settlementKind: "release" | "refund" | null;
  facts: AgreementFacts;
  /** The settlement signature, but only when `ok`. Never asserted independently. */
  receiptProof: string | null;
  checks: VerificationCheck[];
}

/** Anchor's 8-byte instruction discriminator: sha256(`global:<name>`)[0..8]. */
function instructionDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/** Anchor's account discriminator: sha256(`account:<Name>`)[0..8]. */
function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

const RELEASE_DISC = instructionDiscriminator("release");
const REFUND_DISC = instructionDiscriminator("refund");
const FUND_DISC = instructionDiscriminator("fund");
const AGREEMENT_ACCOUNT_DISC = accountDiscriminator("FlintAgreement");

/** A parsed instruction: which program, which accounts, what data. */
interface ParsedInstruction {
  programId: PublicKey;
  keys: PublicKey[];
  data: Buffer;
}

/**
 * Lists the instructions in a fetched transaction.
 *
 * `getTransaction` returns a `VersionedTransactionResponse`. Its message is a
 * web3.js `Message` (legacy) or `MessageV0`, and the two expose instructions
 * differently: a legacy message's `instructions` are *resolved* (each account is
 * `{index, isSigner, isWritable}`), while both shapes also carry the raw
 * `compiledInstructions` with `accountKeyIndexes`. This reads the compiled form —
 * one shape for both message types — and resolves accounts by index through the
 * message's own key table, which is the same work a runtime does.
 *
 * Which key table to use is decided by which field the message actually carries,
 * never by assumption. An unrecognised shape raises rather than returning a partial
 * list: a verification that quietly skipped instructions it could not read would be
 * worse than no verification.
 */
function parseInstructions(response: VersionedTransactionResponse): ParsedInstruction[] {
  const message = response.transaction.message as unknown as {
    accountKeys?: PublicKey[];
    staticAccountKeys?: PublicKey[];
    compiledInstructions?: {
      programIdIndex: number;
      accountKeyIndexes: number[];
      data: Uint8Array;
    }[];
    instructions?: {
      programIdIndex: number;
      accounts: { index: number }[];
      data: Uint8Array;
    }[];
  };
  const keys = message.accountKeys ?? message.staticAccountKeys;
  const compiled = message.compiledInstructions ?? message.instructions?.map((ix) => ({
    programIdIndex: ix.programIdIndex,
    accountKeyIndexes: ix.accounts.map((account) => account.index),
    data: ix.data,
  }));
  if (keys === undefined || compiled === undefined) {
    throw new Error(
      "Unrecognised transaction message shape: no instruction list could be read, " +
        "so the transaction cannot be verified.",
    );
  }
  return compiled.map((ix) => ({
    programId: keys[ix.programIdIndex],
    keys: ix.accountKeyIndexes.map((index) => keys[index]),
    data: Buffer.from(ix.data),
  }));
}


/** How one token account's balance changed across a transaction. */
interface TokenDelta {
  account: PublicKey;
  mint: string;
  /** Positive when the account gained tokens, negative when it lost them. */
  delta: bigint;
}

/**
 * The token balance changes a transaction actually caused, from its metadata.
 *
 * This is the evidence the verifier uses for "did the money move, and to whom",
 * and it is deliberately *not* an instruction decode. Two reasons:
 *
 *   1. The token movement inside `release`/`refund` is a CPI, so it is not in the
 *      transaction's top-level instructions at all; it lives in the metadata's
 *      inner instructions, whose encoding varies with how the transaction was
 *      fetched.
 *   2. Balance deltas are what a person means by "the money moved": they are the
 *      state change itself. Reading them makes the check independent of any
 *      particular instruction encoding, and independent of whether the transfer was
 *      issued by the escrow program or by a token program CPI.
 *
 * Joined on (account, mint) so a mint that changed in several accounts is not
 * conflated.
 */
function tokenBalanceDeltas(
  response: VersionedTransactionResponse,
  keys: PublicKey[],
): TokenDelta[] {
  const meta = (response as {
    meta?: {
      preTokenBalances?: unknown;
      postTokenBalances?: unknown;
    };
  }).meta;
  interface TokenBalanceEntry {
    accountIndex: number;
    mint: string;
    uiTokenAmount: { amount: string };
  }
  const pre = (meta?.preTokenBalances ?? []) as TokenBalanceEntry[];
  const post = (meta?.postTokenBalances ?? []) as TokenBalanceEntry[];

  const after = new Map<string, bigint>();
  for (const entry of post) {
    after.set(`${entry.accountIndex}:${entry.mint}`, BigInt(entry.uiTokenAmount.amount));
  }

  const deltas: TokenDelta[] = [];
  for (const entry of pre) {
    const account = keys[entry.accountIndex];
    if (account === undefined) continue;
    const before = BigInt(entry.uiTokenAmount.amount);
    const to = after.get(`${entry.accountIndex}:${entry.mint}`);
    const end = to ?? 0n;
    if (end === before) continue;
    deltas.push({ account, mint: entry.mint, delta: end - before });
  }
  // An account that only appears in `post` (created, then funded) is a delta too.
  for (const entry of post) {
    if (pre.some((p) => p.accountIndex === entry.accountIndex && p.mint === entry.mint)) continue;
    const account = keys[entry.accountIndex];
    if (account === undefined) continue;
    const amount = BigInt(entry.uiTokenAmount.amount);
    if (amount === 0n) continue;
    deltas.push({ account, mint: entry.mint, delta: amount });
  }
  return deltas;
}

/** The owner of a token account, read from chain; `null` if unreadable. */
async function tokenAccountOwner(
  connection: Connection,
  account: PublicKey,
): Promise<string | null> {
  try {
    return (await getAccount(connection, account)).owner.toBase58();
  } catch {
    return null;
  }
}

/** Reads the escrow token account's balance, mint and authority. */
async function readEscrowFacts(
  connection: Connection,
  escrow: PublicKey,
): Promise<{ balance: string; mint: string | null; authority: string | null }> {
  try {
    const account = await getAccount(connection, escrow);
    return {
      balance: account.amount.toString(),
      mint: account.mint.toBase58(),
      authority: account.owner.toBase58(),
    };
  } catch {
    return { balance: "0", mint: null, authority: null };
  }
}

/**
 * Recomputes an agreement's current facts, straight from the account.
 *
 * Used by the verification page, by the x402 responder, and by the tests. A
 * missing account is reported as `closed: true` rather than as an error: a
 * cancelled agreement legitimately has no account (Section 4.6), and that is a
 * fact the reader should see.
 */
export async function describeAgreement(
  connection: Connection,
  programId: PublicKey,
  agreementPdaAddress: PublicKey,
  receiptProof?: string,
): Promise<AgreementFacts> {
  const raw = await readAgreement(connection, programId, agreementPdaAddress);
  if (raw === null) {
    return {
      agreementPda: agreementPdaAddress.toBase58(),
      agreement: null,
      escrowAddress: null,
      escrowBalance: null,
      escrowMint: null,
      escrowAuthority: null,
      closed: true,
    };
  }
  const escrow = await readEscrowFacts(connection, raw.escrowAddress);
  return {
    agreementPda: agreementPdaAddress.toBase58(),
    agreement: toFrs1Agreement(raw as unknown as DecodableAgreement, receiptProof),
    escrowAddress: raw.escrowAddress.toBase58(),
    escrowBalance: escrow.balance,
    escrowMint: escrow.mint,
    escrowAuthority: escrow.authority,
    closed: false,
  };
}

/**
 * Finds the agreement account a transaction touched, by looking for an account
 * owned by the program whose data starts with the `FlintAgreement` discriminator.
 *
 * Discovered rather than assumed from a position in the account list, so a
 * reordered or padded account list cannot point the verifier at the wrong account.
 */
async function findAgreementIn(
  connection: Connection,
  programId: PublicKey,
  instructions: ParsedInstruction[],
): Promise<PublicKey | null> {
  const candidates = new Set<PublicKey>();
  for (const ix of instructions) {
    if (!ix.programId.equals(programId)) continue;
    for (const key of ix.keys) candidates.add(key);
  }
  for (const candidate of candidates) {
    const info = await connection.getAccountInfo(candidate);
    if (info === null) continue;
    if (!info.owner.equals(programId)) continue;
    if (!Buffer.from(info.data.subarray(0, 8)).equals(AGREEMENT_ACCOUNT_DISC)) continue;
    return candidate;
  }
  return null;
}

/** A payment claim: "I funded this agreement", checked against the chain. */
export interface PaymentVerification {
  ok: boolean;
  signature: string;
  facts: AgreementFacts;
  checks: VerificationCheck[];
}

/** Accumulates a report's checks and derives the verdict from them. */
function makeChecks() {
  const checks: VerificationCheck[] = [];
  return {
    add: (name: string, passed: boolean, detail: string): void => {
      checks.push({ name, passed, detail });
    },
    all: (): VerificationCheck[] => checks,
    ok: (): boolean => checks.every((check) => check.passed),
  };
}

/** Facts for a report that could not get as far as reading an agreement. */
function emptyFacts(agreementPda = ""): AgreementFacts {
  return {
    agreementPda,
    agreement: null,
    escrowAddress: null,
    escrowBalance: null,
    escrowMint: null,
    escrowAuthority: null,
    closed: true,
  };
}

/**
 * A fetched transaction, read once and shared by every check.
 *
 * `instructions` are the top-level ones — a settlement call is always one of those.
 * `signers` comes from the message header, which states how many leading keys are
 * required signatures. `deltas` are the token balance changes the transaction caused.
 */
interface ParsedTransaction {
  instructions: ParsedInstruction[];
  signers: PublicKey[];
  deltas: TokenDelta[];
}

/**
 * Whether a string could be a transaction signature at all.
 *
 * A public verification page is handed whatever arrives in the URL, and the RPC
 * *rejects* a malformed signature as a bad parameter rather than answering "no such
 * transaction". So the shape is checked before the call: garbage in gets a verdict
 * ("not verified") instead of an exception, which is the whole point of a verifier
 * that never over-claims and never crashes on its input.
 */
function looksLikeSignature(value: string): boolean {
  // 64 bytes in base58 is 86–88 characters; the alphabet excludes 0, O, I and l.
  return /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(value);
}

/** Fetches a confirmed transaction and reads it: top-level, inner, and signers. */
async function loadTransaction(
  connection: Connection,
  signature: string,
): Promise<{ ok: true; transaction: ParsedTransaction } | { ok: false; detail: string }> {
  if (!looksLikeSignature(signature)) {
    return {
      ok: false,
      detail: `"${signature.slice(0, 24)}…" is not a valid transaction signature.`,
    };
  }
  let response;
  try {
    response = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (cause) {
    // A rate limit or a transport failure must not read as a verdict. Say what
    // happened and let the caller fail the check.
    return { ok: false, detail: `The RPC could not be queried: ${(cause as Error).message}` };
  }
  if (response === null) {
    return { ok: false, detail: `No confirmed transaction with signature ${signature}.` };
  }

  const message = response.transaction.message as unknown as {
    accountKeys?: PublicKey[];
    staticAccountKeys?: PublicKey[];
    header?: { numRequiredSignatures?: number };
  };
  const keys = message.accountKeys ?? message.staticAccountKeys ?? [];
  const instructions = parseInstructions(response);
  return {
    ok: true,
    transaction: {
      instructions,
      // The header states how many leading keys are required signatures, so the
      // signer set is read from the message itself rather than from a field whose
      // RPC encoding is not guaranteed.
      signers: keys.slice(0, message.header?.numRequiredSignatures ?? 0),
      deltas: tokenBalanceDeltas(response, keys),
    },
  };
}

/** Checks an agreement account against the PDA re-derived from its own fields. */
function canonicalPdaCheck(
  c: ReturnType<typeof makeChecks>,
  programId: PublicKey,
  facts: AgreementFacts,
): void {
  const agreement = facts.agreement;
  if (agreement === null) {
    c.add("agreement_is_canonical_pda", false, "No agreement object to re-derive a PDA from.");
    return;
  }
  const [derived] = agreementPda(
    new PublicKey(agreement.recipientAddress),
    Buffer.from(agreement.id.replace(/-/g, ""), "hex"),
    programId,
  );
  const canonical = derived.toBase58() === facts.agreementPda;
  c.add(
    "agreement_is_canonical_pda",
    canonical,
    canonical
      ? "The account is the canonical PDA for its own stored recipient and id."
      : `Not the canonical PDA for its stored fields (${derived.toBase58()}).`,
  );
}

/**
 * Verifies a *payment* claim: the `fund` transaction the `X-PAYMENT` header names.
 *
 * The payer supplies a signature; this decides whether the money actually reached
 * this agreement's escrow. Nothing in the payload is believed, and a signature for
 * an unrelated transaction fails here rather than unlocking a resource.
 */
export async function verifyFunding(
  connection: Connection,
  programId: PublicKey,
  fundingSignature: string,
  claimedPda?: string,
  display?: VerifyDisplay,
): Promise<PaymentVerification> {
  const c = makeChecks();
  const loaded = await loadTransaction(connection, fundingSignature);

  if (!loaded.ok) {
    c.add("transaction_found", false, loaded.detail);
    return { ok: false, signature: fundingSignature, facts: emptyFacts(claimedPda), checks: c.all() };
  }
  c.add("transaction_found", true, `Transaction ${fundingSignature} is on chain.`);

  const fund = loaded.transaction.instructions.find(
    (ix) =>
      ix.programId.equals(programId) && ix.data.subarray(0, 8).equals(FUND_DISC),
  );
  if (fund === undefined) {
    c.add(
      "payment_instruction_recognised",
      false,
      "No `fund` instruction for the Flint program: this is not a payment.",
    );
    return { ok: false, signature: fundingSignature, facts: emptyFacts(claimedPda), checks: c.all() };
  }
  c.add("payment_instruction_recognised", true, "The transaction calls `fund`.");

  const found = await findAgreementIn(connection, programId, loaded.transaction.instructions);
  if (found === null) {
    c.add("agreement_account_found", false, "No FRS-1 agreement account was touched.");
    return { ok: false, signature: fundingSignature, facts: emptyFacts(claimedPda), checks: c.all() };
  }
  c.add("agreement_account_found", true, `Funded agreement ${found.toBase58()}.`);

  const facts = await describeAgreement(connection, programId, found);
  if (facts.agreement === null) {
    c.add("agreement_readable", false, "The agreement account could not be read.");
    return { ok: false, signature: fundingSignature, facts, checks: c.all() };
  }
  c.add("agreement_readable", true, "The agreement account was read and decoded.");

  if (claimedPda !== undefined) {
    const matches = facts.agreementPda === claimedPda;
    c.add(
      "payment_matches_claimed_agreement",
      matches,
      matches
        ? "The funded agreement is the one the request claimed."
        : `The request claimed ${claimedPda}, but the transaction funded ${facts.agreementPda}.`,
    );
  }
  canonicalPdaCheck(c, programId, facts);

  const agreement = facts.agreement;
  const funded = agreement.status !== "pending";
  c.add(
    "agreement_is_funded",
    funded,
    funded ? `Status is ${agreement.status}: it was funded.` : "Still pending: no funds reached escrow.",
  );

  const escrowed = BigInt(facts.escrowBalance ?? "0");
  const agreed = BigInt(agreement.amount);
  const amountText = (value: string | bigint): string =>
    shownAmount(value, display, agreement.asset);
  c.add(
    "escrow_holds_agreed_amount",
    escrowed === 0n || escrowed >= agreed,
    escrowed === 0n
      ? "Escrow is empty, consistent with an already-settled agreement."
      : `Escrow holds ${amountText(escrowed)} against an agreed ${amountText(agreed)}.`,
  );

  const funder = fund.keys[0];
  const payerMatches =
    agreement.payerAddress !== null && funder.toBase58() === agreement.payerAddress;
  c.add(
    "payer_is_the_funder",
    payerMatches,
    payerMatches
      ? `The stored payerAddress funded it (${agreement.payerAddress}).`
      : `Funded by ${funder.toBase58()}, not the stored payerAddress (${agreement.payerAddress}).`,
  );

  return { ok: c.ok(), signature: fundingSignature, facts, checks: c.all() };
}

/**
 * Verifies a *settlement* claim: recomputes whether this signature really settled
 * this agreement, for the stored amount and asset, on behalf of the stored payer.
 *
 * This is the receipt. It is returned only when every check passes, and the
 * identical code path serves both flows — nothing here knows or cares whether a
 * human Blink or an autonomous agent produced the transaction (7.2.5).
 */
export async function verifySettlement(
  connection: Connection,
  programId: PublicKey,
  signature: string,
  display?: VerifyDisplay,
): Promise<VerificationReport> {
  const c = makeChecks();
  const loaded = await loadTransaction(connection, signature);

  if (!loaded.ok) {
    c.add("transaction_found", false, loaded.detail);
    return {
      ok: false,
      signature,
      settlementKind: null,
      facts: emptyFacts(),
      receiptProof: null,
      checks: c.all(),
    };
  }
  c.add("transaction_found", true, `Transaction ${signature} is on chain.`);

  const settlement = loaded.transaction.instructions.find(
    (ix) =>
      ix.programId.equals(programId) &&
      (ix.data.subarray(0, 8).equals(RELEASE_DISC) ||
        ix.data.subarray(0, 8).equals(REFUND_DISC)),
  );
  const kind =
    settlement === undefined
      ? null
      : settlement.data.subarray(0, 8).equals(RELEASE_DISC)
        ? ("release" as const)
        : ("refund" as const);

  if (settlement === undefined || kind === null) {
    c.add(
      "settlement_instruction_recognised",
      false,
      "No `release` or `refund` instruction for the Flint program: not a settlement.",
    );
    return {
      ok: false,
      signature,
      settlementKind: null,
      facts: emptyFacts(),
      receiptProof: null,
      checks: c.all(),
    };
  }
  c.add(
    "settlement_instruction_recognised",
    true,
    `The transaction calls \`${kind}\` on the Flint program.`,
  );

  const found = await findAgreementIn(connection, programId, loaded.transaction.instructions);
  if (found === null) {
    c.add("agreement_account_found", false, "No FRS-1 agreement account was touched.");
    return {
      ok: false,
      signature,
      settlementKind: kind,
      facts: emptyFacts(),
      receiptProof: null,
      checks: c.all(),
    };
  }
  c.add("agreement_account_found", true, `Settled agreement ${found.toBase58()}.`);

  const facts = await describeAgreement(connection, programId, found);
  if (facts.agreement === null) {
    c.add("agreement_readable", false, "The agreement account could not be read.");
    return { ok: false, signature, settlementKind: kind, facts, receiptProof: null, checks: c.all() };
  }
  c.add("agreement_readable", true, "The agreement account was read and decoded.");
  canonicalPdaCheck(c, programId, facts);

  const agreement = facts.agreement;
  const expectedStatus = kind === "release" ? "released" : "refunded";
  const statusMatches = agreement.status === expectedStatus;
  c.add(
    "status_matches_settlement",
    statusMatches,
    statusMatches
      ? `Status is ${agreement.status}, as a \`${kind}\` requires.`
      : `Status is ${agreement.status}, but a \`${kind}\` should leave it ${expectedStatus}.`,
  );

  // ---- what the money actually did, per the transaction's own balance deltas ----
  const agreed = BigInt(agreement.amount);
  const amountText = (value: string | bigint): string =>
    shownAmount(value, display, agreement.asset);
  const deltas = loaded.transaction.deltas.filter(
    (delta) => delta.mint === agreement.asset,
  );
  const escrowDelta = deltas.find(
    (delta) => delta.account.toBase58() === facts.escrowAddress,
  );
  const debitedExactly = escrowDelta !== undefined && escrowDelta.delta === -agreed;
  c.add(
    "escrow_debited_agreed_amount",
    debitedExactly,
    debitedExactly
      ? `The escrow was debited exactly the agreed ${amountText(agreed)} by this transaction.`
      : `The escrow's change in this transaction was ${
          escrowDelta === undefined ? "absent" : amountText(escrowDelta.delta)
        }, not -${amountText(agreed)}.`,
  );

  // Whoever was supposed to be paid must be an account that gained the agreed
  // amount, and that account's on-chain owner must be the stored counterparty.
  const counterparty =
    kind === "release" ? agreement.recipientAddress : agreement.payerAddress;
  const roleName = kind === "release" ? "recipient" : "payer";
  let credited = false;
  let creditDetail = "No account gained the agreed amount in the agreed asset.";
  for (const credit of deltas.filter((delta) => delta.delta > 0n)) {
    if (credit.delta !== agreed) {
      creditDetail = `${credit.account.toBase58()} gained ${amountText(credit.delta)}, not ${amountText(agreed)}.`;
      continue;
    }
    const owner = await tokenAccountOwner(connection, credit.account);
    if (owner === counterparty) {
      credited = true;
      creditDetail = `${credit.account.toBase58()} gained the agreed ${amountText(agreed)} and is owned by the stored ${roleName}.`;
      break;
    }
    creditDetail = `${credit.account.toBase58()} gained ${amountText(agreed)} but is owned by ${owner ?? "an unreadable account"}, not the stored ${roleName}.`;
  }
  c.add(
    kind === "release"
      ? "funds_reached_stored_recipient"
      : "refund_returned_to_stored_payer",
    credited,
    creditDetail,
  );

  const escrowEmpty = (facts.escrowBalance ?? "0") === "0";
  c.add(
    "escrow_emptied",
    escrowEmpty,
    escrowEmpty
      ? "Escrow is empty: the full amount left custody."
      : `The escrow still holds ${amountText(facts.escrowBalance ?? "0")}.`,
  );

  if (kind === "release") {
    const signer = settlement.keys[0];
    const authorized =
      agreement.payerAddress !== null &&
      signer.toBase58() === agreement.payerAddress &&
      loaded.transaction.signers.some((s) => s.equals(signer));
    c.add(
      "release_authorized_by_stored_payer",
      authorized,
      authorized
        ? `The stored payer (${agreement.payerAddress}) signed the release.`
        : `Signed by ${signer.toBase58()}, not the stored payer (${agreement.payerAddress}).`,
    );
  }
  const ok = c.ok();
  return {
    ok,
    signature,
    settlementKind: kind,
    // Re-read with the receipt attached, so the rendered object and the report
    // cannot disagree about which signature is being certified.
    facts: ok ? await describeAgreement(connection, programId, found, signature) : facts,
    receiptProof: ok ? signature : null,
    checks: c.all(),
  };
}