/**
 * Runs the test agent against the priced endpoint, on demand.
 *
 * POST-only, because it moves money (or deliberately declines to). The page it
 * redirects to is `/agent`, which renders the decision log — the log, not this
 * route's response, is the durable record (7.2.4).
 *
 * The three scenarios exist to make refusals *visible* rather than theoretical:
 *
 *   - `pay` — the agent's policy allows this agreement, so it funds and settles;
 *   - `refuse_spend_cap` — the same endpoint, the same price, but the agent's own
 *     cap is set below the price, so it declines and nothing is signed;
 *   - `refuse_recipient` — the cap is generous but the recipient is not on the
 *     agent's allowlist, so it declines.
 *
 * Note what the scenarios do *not* do: they change the **agent's** policy, never
 * the server's price. A refusal here is the payer's own rule refusing, which is
 * the only kind of refusal that means anything.
 */

import { readConfig, ConfigError } from "../../../../lib/config";
import { getConnection } from "../../../../lib/solana";
import { loadKeypair } from "../../../../lib/keys";
import { runAgent } from "../../../../lib/agent";
import { policyForScenario, type AgentScenario } from "../../../../lib/demo-policy";
import { requestOrigin } from "../../../../lib/links";
import { RESOURCE } from "../../x402/route";

export const dynamic = "force-dynamic";

function isScenario(value: FormDataEntryValue | null): value is AgentScenario {
  return value === "pay" || value === "refuse_spend_cap" || value === "refuse_recipient";
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const scenario: AgentScenario = isScenario(form.get("scenario")) ? String(form.get("scenario")) as AgentScenario : "pay";
  const settle = form.get("settle") === "on";

  let config;
  try {
    config = readConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      return Response.json({ error: "not_configured", problems: error.problems }, { status: 503 });
    }
    throw error;
  }

  const connection = getConnection();
  const service = loadKeypair(config.serviceKeypairPath, "service");
  const agent = loadKeypair(config.agentKeypairPath, "agent");
  const policy = policyForScenario(
    scenario,
    service.address,
    config.assetMint.toBase58(),
    config.priceBaseUnits,
  );

  // The agent calls its own endpoint over HTTP, exactly as a remote agent would.
  // Client-facing origin, so a proxied deployment logs links it can actually serve.
  const origin = requestOrigin(request);
  const result = await runAgent({
    connection,
    programId: config.programId,
    agent: agent.keypair,
    policy,
    resourceUrl: `${origin}${RESOURCE.startsWith("http") ? "" : "/api/x402"}`,
    settle,
    spentSoFar: "0",
    decisionLogPath: config.decisionLogPath,
  });

  // Redirect to the log page: the decision is recorded there, whatever happened.
  return new Response(null, {
    status: 303,
    headers: {
      location: `/agent?last=${result.outcome}`,
      "cache-control": "no-store",
    },
  });
}
