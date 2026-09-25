/**
 * The agent's decision log (Section 6.2, acceptance 7.2.4).
 *
 * A refusal that nobody can see is a silent refusal, which the spec forbids. This
 * append-only JSONL log is where every decision lands — allowed *and* refused —
 * each with the full check-by-check evaluation that produced it, so a reader can
 * re-derive the verdict from the entry alone. The agent harness page renders it.
 *
 * Append-only on purpose: a log that can be rewritten is not evidence. A failure
 * to write is fatal to the decision (the caller must not pay into a void), so
 * `recordDecision` throws rather than swallowing.
 *
 * Server-only: uses the filesystem, and the entries contain wallet addresses.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BaseUnits, MintAddress, WalletAddress } from "./frs1-types";
import type { PolicyCheck } from "./policy-engine";

/** One row of the log: the decision, its evidence, and what happened next. */
export interface DecisionLogEntry {
  /** When the decision was made (ISO-8601). */
  at: string;
  agreementId: string;
  agreementPda: WalletAddress;
  recipient: WalletAddress;
  /** `null` on a refusal — nothing was paid. */
  payer: WalletAddress | null;
  amount: BaseUnits;
  asset: MintAddress;
  outcome: "allowed" | "refused";
  /** `ok`, or the refusal code from the policy engine. */
  code: string;
  reason: string;
  checks: PolicyCheck[];
  effectiveSpendCap: BaseUnits;
  resource: string;
  /** Present once the agent paid. */
  fundingTx?: string;
  /** Present once the agreement was settled. This is the receipt. */
  settlementTx?: string;
}

/** Appends one decision. Throws if the log cannot be written. */
export function recordDecision(path: string, entry: DecisionLogEntry): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Reads the most recent entries, oldest first. A missing log is an empty log, not
 * an error: a fresh deployment legitimately has no decisions yet.
 */
export function readDecisions(path: string, limit = 50): DecisionLogEntry[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const entries = lines.map((line) => JSON.parse(line) as DecisionLogEntry);
  return entries.slice(Math.max(0, entries.length - limit));
}
