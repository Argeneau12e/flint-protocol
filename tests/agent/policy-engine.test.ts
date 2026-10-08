/**
 * The deterministic policy engine, tested with no chain and no model.
 *
 * Acceptance 7.2.2 asks for a policy engine that can pass or fail an agreement
 * deterministically without an LLM. These tests are the proof of that claim, and
 * they are deliberately hermetic: no RPC, no keypairs, no network. If any of them
 * ever needed a connection or a model to run, the property they are testing would
 * already be gone.
 *
 * The three headline cases the phase plan names — pay when within policy, refuse
 * over the spend cap, refuse when the recipient is not allowlisted — are the first
 * three tests, named to match.
 */

import { assert } from "chai";
import {
  evaluateAgreement,
  type AgentPolicy,
  type PolicyDecision,
} from "../../app/lib/policy-engine";
import type { Frs1Agreement } from "../../app/lib/frs1-types";

/** Fixed "chain time" for these tests: 2026-01-01T00:00:00Z. */
const NOW = 1_767_225_600;

const RECIPIENT = "ArdoTwZy2Cqvtk6B1BtNqbwnR45W3mCo73MemgNhrXPK";
const STRANGER = "11111111111111111111111111111111";
const MINT = "79nrrEnrDK6BQrUUgH2uBpYK1XCPJcgKy3tRQF4ecXuY";
const OTHER_MINT = "So11111111111111111111111111111111111111112";
const AMOUNT = "1000000";

/** A pending, allowlisted, affordable agreement — the baseline that must pay. */
function agreement(overrides: Partial<Frs1Agreement> = {}): Frs1Agreement {
  return {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    payerAddress: null,
    recipientAddress: RECIPIENT,
    title: "Market report access",
    amount: AMOUNT,
    asset: MINT,
    escrowAddress: "6BxAnhexayAEa4pAf2pkZ5CQr8jXmUMBNkMXtqCxsF2A",
    memo: "",
    expiresAt: NOW + 900,
    status: "pending",
    condition: { type: "manual-confirmation", description: "Deliver the resource" },
    reviewWindowSecs: 24 * 60 * 60,
    claimedAt: null,
    evidenceHash: "00".repeat(32),
    evidenceRef: "",
    disputedAt: null,
    arbiterDeadline: null,
    disputeReason: null,
    feeAmount: "0",
    ...overrides,
  };
}

/** A policy that allows the baseline agreement above. */
function policy(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    spendCap: "2000000",
    sessionBudget: "5000000",
    recipientAllowlist: [RECIPIENT],
    assetAllowlist: [MINT],
    maxTtlSeconds: 3600,
    ...overrides,
  };
}

function evaluate(
  over: Partial<Frs1Agreement> = {},
  overPolicy: Partial<AgentPolicy> = {},
  context: { spentSoFar?: string; claimed?: { amount: string; asset: string; recipient: string } } = {},
): PolicyDecision {
  return evaluateAgreement(agreement(over), policy(overPolicy), {
    now: NOW,
    spentSoFar: context.spentSoFar ?? "0",
    ...(context.claimed === undefined ? {} : { claimed: context.claimed }),
  });
}

describe("policy engine — deterministic, no LLM (Section 6.2 / 7.2.2)", () => {
  it("test_pays_when_within_policy — an affordable, allowlisted agreement is allowed", () => {
    const decision = evaluate();

    assert.isTrue(decision.allow, decision.reason);
    assert.equal(decision.code, "ok");
    // Every check ran, and every one passed.
    assert.isAtLeast(decision.checks.length, 9);
    assert.deepEqual(
      decision.checks.filter((check) => !check.passed),
      [],
      "no check may fail for a compliant agreement",
    );
    assert.equal(decision.effectiveSpendCap, "2000000");
  });

  it("test_refuses_when_over_spend_cap — an agreement above the cap is refused", () => {
    const decision = evaluate({}, { spendCap: "999999" });

    assert.isFalse(decision.allow);
    assert.equal(decision.code, "spend_cap_exceeded");
    // The refusal explains itself in numbers, not adjectives.
    assert.include(decision.reason, "1000000");
    assert.include(decision.reason, "999999");
    assert.equal(decision.effectiveSpendCap, "999999");
  });

  it("test_refuses_when_recipient_not_allowlisted — an unknown payee is refused", () => {
    const decision = evaluate({ recipientAddress: STRANGER });

    assert.isFalse(decision.allow);
    assert.equal(decision.code, "recipient_not_allowlisted");
    assert.include(decision.reason, STRANGER);
  });

  it("refuses an unexpected asset", () => {
    const decision = evaluate({ asset: OTHER_MINT });

    assert.isFalse(decision.allow);
    assert.equal(decision.code, "asset_not_allowlisted");
  });

  it("refuses an expired agreement, judged against the caller's chain time", () => {
    const decision = evaluate({ expiresAt: NOW });

    assert.isFalse(decision.allow, "an agreement expiring exactly now is not payable");
    assert.equal(decision.code, "agreement_expired");
  });

  it("refuses a validity window longer than the agent will carry", () => {
    const decision = evaluate({ expiresAt: NOW + 86_400 }, { maxTtlSeconds: 3600 });

    assert.isFalse(decision.allow);
    assert.equal(decision.code, "ttl_exceeds_limit");
  });

  it("refuses a condition type v1 cannot enforce", () => {
    const decision = evaluate({
      condition: { type: "oracle-attested", description: "price feed says so" },
    });

    assert.isFalse(decision.allow);
    assert.equal(decision.code, "condition_not_enforceable");
  });

  it("refuses when the session budget would be exceeded", () => {
    const decision = evaluate({}, { sessionBudget: "5000000" }, { spentSoFar: "4500000" });

    assert.isFalse(decision.allow);
    assert.equal(decision.code, "session_budget_exceeded");
    assert.include(decision.reason, "5500000");
  });

  it("allows the final affordable payment, and refuses the one past the budget", () => {
    const last = evaluate({}, { sessionBudget: "5000000" }, { spentSoFar: "4000000" });
    assert.isTrue(last.allow, last.reason);

    const over = evaluate({}, { sessionBudget: "5000000" }, { spentSoFar: "4000001" });
    assert.isFalse(over.allow);
    assert.equal(over.code, "session_budget_exceeded");
  });

  it("refuses when the x402 envelope disagrees with the agreement object", () => {
    const decision = evaluate({}, {}, {
      claimed: { amount: "1", asset: MINT, recipient: RECIPIENT },
    });

    assert.isFalse(decision.allow);
    assert.equal(decision.code, "envelope_mismatch");
  });

  it("honours the stricter of the agent's cap and the agreement's advertised cap", () => {
    const agreementIsStricter = evaluate(
      { agentPolicy: { spendCap: "1000000", allowlist: [] } },
      { spendCap: "9000000" },
    );
    assert.equal(agreementIsStricter.effectiveSpendCap, "1000000");

    const agentIsStricter = evaluate(
      { agentPolicy: { spendCap: "9000000", allowlist: [] } },
      { spendCap: "1000000" },
    );
    assert.equal(agentIsStricter.effectiveSpendCap, "1000000");
    assert.isTrue(agentIsStricter.allow, agentIsStricter.reason);

    // An agreement advertising a cap below its own price is refused on that cap.
    const refused = evaluate(
      { amount: "2000000", agentPolicy: { spendCap: "1000000", allowlist: [] } },
      { spendCap: "9000000" },
    );
    assert.isFalse(refused.allow);
    assert.equal(refused.code, "spend_cap_exceeded");
  });

  it("is deterministic: the same inputs always produce the same verdict", () => {
    const over = { amount: "999999999" };
    const first = evaluate(over, { spendCap: "1000" });
    for (let i = 0; i < 25; i += 1) {
      assert.deepEqual(
        evaluate(over, { spendCap: "1000" }),
        first,
        "a policy decision must not vary between runs",
      );
    }
  });

  it("records every check, passes included, so a refusal can be audited", () => {
    const decision = evaluate({ recipientAddress: STRANGER });

    assert.equal(decision.checks.filter((check) => !check.passed).length, 1);
    assert.isAtLeast(decision.checks.length, 9);
    for (const check of decision.checks) {
      assert.isString(check.detail, "every check carries a human-readable reason");
      assert.isNotEmpty(check.detail);
    }
  });

  it("refuses, rather than throwing, when the amount is not a number", () => {
    const decision = evaluate({ amount: "1e6" });

    assert.isFalse(decision.allow);
    assert.equal(decision.code, "amount_not_positive");
  });

  it("refuses a zero-amount agreement outright", () => {
    const decision = evaluate({ amount: "0" });

    assert.isFalse(decision.allow);
    assert.equal(decision.code, "amount_not_positive");
  });
});
