/**
 * The deterministic agent policy engine (Section 6.2, acceptance 7.2.2).
 *
 * **No model, anywhere, in this file or in its decision path.** Every check is a
 * comparison over values already in hand: the agreement object the server sent,
 * the agent's own policy, and a caller-supplied clock reading and running total.
 * Same inputs, same verdict, every time — which is the whole point. A pay/no-pay
 * decision that could vary between runs would be a decision nobody can audit, and
 * an LLM in that path would be a stranger deciding where money goes.
 *
 * Consequences of that rule, made explicit:
 *   - the function is pure: no I/O, no clock reads, no randomness, no network;
 *   - it is *total*: it never throws and always returns a verdict with every
 *     check recorded, so a refusal can be explained rather than merely asserted;
 *   - the caller supplies `now` and `spentSoFar`, which keeps "what time is it"
 *     and "how much have I spent" outside the policy and lets tests drive both.
 *
 * Money is handled as `bigint` base units throughout (Section 4.5): a JS number
 * cannot hold a u64 faithfully, and an amount that silently rounds is an amount
 * that can be spent wrongly.
 */

import type {
  BaseUnits,
  Frs1Agreement,
  MintAddress,
  UnixTimestamp,
  WalletAddress,
} from "./frs1-types";

/** The agent's own rules, configured by whoever runs the agent. */
export interface AgentPolicy {
  /** Maximum spend for any single agreement, in `asset` base units. */
  spendCap: BaseUnits;
  /** Maximum cumulative spend for the whole session, in base units. */
  sessionBudget: BaseUnits;
  /** Recipients this agent will pay. Anything else is refused. */
  recipientAllowlist: readonly WalletAddress[];
  /** Assets this agent will pay in. Anything else is refused. */
  assetAllowlist: readonly MintAddress[];
  /**
   * Rejects agreements claiming an implausibly long validity, so a server cannot
   * park an agent's commitment far in the future.
   */
  maxTtlSeconds: number;
}

/** Facts the caller supplies that are not part of the agreement itself. */
export interface PolicyContext {
  /** Current chain time in unix seconds — the Clock sysvar, never the host clock. */
  now: UnixTimestamp;
  /** What this agent has already committed this session, in base units. */
  spentSoFar: BaseUnits;
  /**
   * What the 402 response *claimed* in its x402 envelope, if anything. Checked
   * against the agreement so a payload cannot advertise one amount and settle
   * another.
   */
  claimed?: { amount: BaseUnits; asset: MintAddress; recipient: WalletAddress };
}

/** Every distinct way a decision can come out "no". */
export type RefusalCode =
  | "amount_not_positive"
  | "recipient_not_allowlisted"
  | "asset_not_allowlisted"
  | "agreement_not_pending"
  | "agreement_expired"
  | "ttl_exceeds_limit"
  | "condition_not_enforceable"
  | "spend_cap_exceeded"
  | "session_budget_exceeded"
  | "envelope_mismatch";

/** One evaluated rule, always recorded — passes included. */
export interface PolicyCheck {
  code: RefusalCode | "ok";
  passed: boolean;
  detail: string;
}

/** A verdict, plus the full evaluation that produced it. */
export interface PolicyDecision {
  allow: boolean;
  /** `ok` when allowed, otherwise the first failing check. */
  code: "ok" | RefusalCode;
  /** Human-readable explanation, for the log and the UI. */
  reason: string;
  checks: PolicyCheck[];
  /**
   * The cap actually applied: the agent's own cap, tightened by the agreement's
   * advertised `agentPolicy.spendCap` when that is lower. Both sides bind.
   */
  effectiveSpendCap: BaseUnits;
}

/** Reads a base-unit string as a bigint; throws on malformed input. */
function toBaseUnits(value: BaseUnits, what: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `${what} must be a decimal string of base units, got "${value}"`,
    );
  }
  return BigInt(value);
}

/** The lower of two caps, as base units. */
function stricterCap(a: bigint, b: bigint | null): bigint {
  return b === null ? a : a < b ? a : b;
}

/**
 * Evaluates one agreement against one policy. Pure, total, deterministic.
 *
 * All checks run even after the first failure, so the log shows the whole
 * picture; `code` names the *first* failure in evaluation order, which is the
 * most specific reason the agent has for stopping.
 */
export function evaluateAgreement(
  agreement: Frs1Agreement,
  policy: AgentPolicy,
  context: PolicyContext,
): PolicyDecision {
  const checks: PolicyCheck[] = [];
  const add = (code: PolicyCheck["code"], passed: boolean, detail: string): void => {
    checks.push({ code, passed, detail });
  };

  let amount: bigint;
  let agentCap: bigint;
  let advertisedCap: bigint | null;
  let budget: bigint;
  let spent: bigint;
  try {
    amount = toBaseUnits(agreement.amount, "agreement.amount");
    agentCap = toBaseUnits(policy.spendCap, "policy.spendCap");
    budget = toBaseUnits(policy.sessionBudget, "policy.sessionBudget");
    spent = toBaseUnits(context.spentSoFar, "context.spentSoFar");
    advertisedCap =
      agreement.agentPolicy === undefined
        ? null
        : toBaseUnits(
            agreement.agentPolicy.spendCap,
            "agreement.agentPolicy.spendCap",
          );
  } catch (cause) {
    // A malformed amount is itself a refusal, not a crash: the agent does not
    // pay, and the log says why.
    add("amount_not_positive", false, (cause as Error).message);
    return {
      allow: false,
      code: "amount_not_positive",
      reason: `The agreement's amount could not be read as base units: ${
        (cause as Error).message
      }`,
      checks,
      effectiveSpendCap: policy.spendCap,
    };
  }

  const effectiveSpendCap = stricterCap(agentCap, advertisedCap);

  // 1. The amount must be a real amount. A zero-amount agreement would move no
  //    money and still produce a receipt-shaped claim.
  add(
    "amount_not_positive",
    amount > 0n,
    amount > 0n
      ? `Amount is ${amount} base units.`
      : `Amount is ${amount} base units: an agreement must pay something.`,
  );

  // 2. Who is being paid. The agent pays only the wallets on its list.
  const recipientAllowed = policy.recipientAllowlist.includes(
    agreement.recipientAddress,
  );
  add(
    "recipient_not_allowlisted",
    recipientAllowed,
    recipientAllowed
      ? `Recipient ${agreement.recipientAddress} is on the allowlist.`
      : `Recipient ${agreement.recipientAddress} is not on this agent's allowlist ` +
        `(${policy.recipientAllowlist.length} permitted recipient(s)); refusing to pay an unknown party.`,
  );

  // 3. In what. Paying in an asset the agent does not expect is how a server
  //    talks an agent into a bad trade.
  const assetAllowed = policy.assetAllowlist.includes(agreement.asset);
  add(
    "asset_not_allowlisted",
    assetAllowed,
    assetAllowed
      ? `Asset ${agreement.asset} is on the allowlist.`
      : `Asset ${agreement.asset} is not on this agent's allowlist; ` +
        `refusing to pay in an unexpected asset.`,
  );

  // 4. Only a pending agreement can be paid. A settled, cancelled or
  //    already-funded agreement is not a payment opportunity.
  const isPending = agreement.status === "pending";
  add(
    "agreement_not_pending",
    isPending,
    isPending
      ? "Agreement is pending."
      : `Agreement is ${agreement.status}, not pending; there is nothing to pay.`,
  );

  // 5. The deadline. `now` is the chain's clock, matching the program's own
  //    expiry rule (Section 4.5) — the agent must not pay for an agreement the
  //    program would refuse to release.
  const notExpired = context.now < agreement.expiresAt;
  add(
    "agreement_expired",
    notExpired,
    notExpired
      ? `Expires in ${agreement.expiresAt - context.now}s (chain time).`
      : `Expired at ${agreement.expiresAt} (chain time is ${context.now}); ` +
        `the program would refuse to release it.`,
  );

  // 6. Validity the agent is willing to carry.
  const ttl = agreement.expiresAt - context.now;
  const ttlOk = ttl <= policy.maxTtlSeconds;
  add(
    "ttl_exceeds_limit",
    ttlOk,
    ttlOk
      ? `Validity ${ttl}s is within the ${policy.maxTtlSeconds}s limit.`
      : `Validity ${ttl}s exceeds this agent's ${policy.maxTtlSeconds}s limit.`,
  );

  // 7. The condition must be one the program can actually enforce. Paying for a
  //    promise the chain cannot check would make the receipt meaningless
  //    (Section 4.3).
  const conditionOk = agreement.condition.type === "manual-confirmation";
  add(
    "condition_not_enforceable",
    conditionOk,
    conditionOk
      ? "Condition is manual-confirmation, the only type v1 enforces."
      : `Condition type "${agreement.condition.type}" is not enforced in v1; ` +
        `paying would create a receipt for a condition nobody can check on chain.`,
  );

  // 8. Per-agreement cap: the agent's, tightened by the agreement's advertised
  //    cap when that is lower. The strictest applicable limit wins.
  const withinCap = amount <= effectiveSpendCap;
  const capDetail =
    advertisedCap !== null
      ? ` (agent cap ${agentCap}, agreement cap ${advertisedCap})`
      : ` (agent cap ${agentCap})`;
  add(
    "spend_cap_exceeded",
    withinCap,
    withinCap
      ? `Amount ${amount} is within the effective spend cap ${effectiveSpendCap}${capDetail}.`
      : `Amount ${amount} exceeds the effective spend cap ${effectiveSpendCap}${capDetail}.`,
  );

  // 9. Cumulative budget, so a server cannot walk an agent past its limit with
  //    a series of individually-acceptable agreements.
  const projected = spent + amount;
  const withinBudget = projected <= budget;
  add(
    "session_budget_exceeded",
    withinBudget,
    withinBudget
      ? `Session total would be ${projected} of ${budget} base units.`
      : `Session total would reach ${projected}, over the ${budget} base-unit budget.`,
  );

  // 10. If the response carried an x402 envelope, it must agree with the
  //     agreement object. A payload advertising one thing and pointing at
  //     another is the substitution row 2 exists to stop.
  if (context.claimed) {
    const matches =
      context.claimed.amount === agreement.amount &&
      context.claimed.asset === agreement.asset &&
      context.claimed.recipient === agreement.recipientAddress;
    add(
      "envelope_mismatch",
      matches,
      matches
        ? "The x402 envelope matches the agreement object."
        : `The x402 envelope (${context.claimed.amount} of ${context.claimed.asset} to ` +
          `${context.claimed.recipient}) does not match the agreement ` +
          `(${agreement.amount} of ${agreement.asset} to ${agreement.recipientAddress}).`,
    );
  }

  const failures = checks.filter((check) => !check.passed);
  const firstFailure = failures[0];
  return {
    allow: failures.length === 0,
    code: firstFailure ? (firstFailure.code as RefusalCode) : "ok",
    reason: firstFailure
      ? firstFailure.detail
      : `All ${checks.length} policy checks passed; the agent may pay up to ` +
        `${effectiveSpendCap} base units.`,
    checks,
    effectiveSpendCap: effectiveSpendCap.toString(),
  };
}

/** One-line description of a policy, for the UI and the decision log. */
export function describePolicy(policy: AgentPolicy): string {
  return (
    `spend cap ${policy.spendCap} base units/payment, ` +
    `session budget ${policy.sessionBudget}, ` +
    `${policy.recipientAllowlist.length} allowed recipient(s), ` +
    `${policy.assetAllowlist.length} allowed asset(s), ` +
    `max validity ${policy.maxTtlSeconds}s`
  );
}
