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
import { logInternalFailure } from "../../../../lib/errors";
import { runAgent } from "../../../../lib/agent";
import { policyForScenario, type AgentScenario } from "../../../../lib/demo-policy";
import { requestOrigin } from "../../../../lib/links";
import { checkX402RateLimit } from "../../../../lib/throttle";
import { RESOURCE } from "../../x402/route";

export const dynamic = "force-dynamic";

function isScenario(value: FormDataEntryValue | null): value is AgentScenario {
  return value === "pay" || value === "refuse_spend_cap" || value === "refuse_recipient";
}

export async function POST(request: Request): Promise<Response> {
  // Rate limited under its own scope, and first, for the same reason the 402
  // endpoint is: one click here runs a whole agent loop, which signs several real
  // transactions against the agent wallet's SOL and tokens. A reload loop or a
  // curious script would spend that wallet directly. Its own scope (not the 402's)
  // so the two budgets stay independent — see `lib/throttle.ts`.
  const { decision, addressKey } = checkX402RateLimit(request, "agentRun");
  if (!decision.allowed) {
    console.warn(
      `[agent/run] rate limited ${addressKey}: ${decision.limit} per ` +
        `${decision.windowSeconds}s, retry in ${decision.retryAfterSeconds}s`,
    );
    return Response.json(
      {
        error: "rate_limited",
        message:
          "Too many agent runs: each one drives a real agent loop that signs " +
          "transactions and can spend the agent wallet's devnet SOL and tokens, so " +
          `runs are limited to ${decision.limit} per ${decision.windowSeconds} seconds. ` +
          "Nothing was spent by this request; try again in " +
          `${decision.retryAfterSeconds} seconds.`,
        limit: decision.limit,
        windowSeconds: decision.windowSeconds,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "retry-after": String(decision.retryAfterSeconds), "cache-control": "no-store" },
      },
    );
  }

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

  // Both wallets are loaded inside the guard for the same reason as the x402
  // route: `loadKeypair` names the file it could not read by absolute path, which
  // is the server's own layout and not something a visitor should receive.
  let service;
  let agent;
  try {
    service = loadKeypair(config.serviceKeypairPath, "service");
    agent = loadKeypair(config.agentKeypairPath, "agent");
  } catch (cause) {
    logInternalFailure("loading the service/agent keypairs", cause);
    return Response.json({ error: "not_configured" }, { status: 500 });
  }

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
