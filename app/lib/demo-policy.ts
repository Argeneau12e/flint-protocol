/**
 * The demo agent's policies (Section 6.2, acceptance 7.2.4).
 *
 * Three scenarios, all driven by the **payer's** rules. The server's price never
 * changes between them, which is the point: a refusal must come from the payer's
 * own policy refusing, not from the seller being difficult.
 *
 *   - `pay` — within cap, recipient allowlisted: the agent pays and settles;
 *   - `refuse_spend_cap` — same agreement, cap below the price: the agent declines;
 *   - `refuse_recipient` — cap of plenty, unknown recipient: the agent declines.
 *
 * Lives in `lib/` rather than in the route so the harness page can render exactly
 * the policy the route will use, rather than a description of it.
 */

import type { AgentPolicy } from "./policy-engine";

/** Which demonstration to run. */
export type AgentScenario = "pay" | "refuse_spend_cap" | "refuse_recipient";

export const AGENT_SCENARIOS: ReadonlyArray<{ value: AgentScenario; label: string }> = [
  { value: "pay", label: "Pay — within policy (funds escrow, then settles)" },
  { value: "refuse_spend_cap", label: "Refuse — price is over the agent's spend cap" },
  { value: "refuse_recipient", label: "Refuse — recipient is not allowlisted" },
];

/** Builds the agent's policy for a scenario. */
export function policyForScenario(
  scenario: AgentScenario,
  serviceAddress: string,
  assetMint: string,
  price: string,
): AgentPolicy {
  const times = (multiplier: bigint): string => (BigInt(price) * multiplier).toString();
  const base: AgentPolicy = {
    spendCap: times(2n),
    sessionBudget: times(5n),
    recipientAllowlist: [serviceAddress],
    assetAllowlist: [assetMint],
    maxTtlSeconds: 3600,
  };
  switch (scenario) {
    case "refuse_spend_cap":
      // A cap below the asking price: the agreement is fine, the rule is not met.
      return { ...base, spendCap: (BigInt(price) / 2n).toString() };
    case "refuse_recipient":
      // A cap of plenty, but nobody on the allowlist: the classic unknown payee.
      return { ...base, recipientAllowlist: ["11111111111111111111111111111111"] };
    case "pay":
    default:
      return base;
  }
}
