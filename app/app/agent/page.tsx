/**
 * The test agent's harness page.
 *
 * Acceptance 7.2.4 asks that a refusal be "logged/visible, not silent". This page
 * is the visible half: it runs the agent on demand (POST — it may move money) and
 * renders the decision log, refusals first-class alongside payments.
 *
 * The page re-reads the log from disk on every request, so what is on screen is the
 * durable record rather than a flash message a refresh erases.
 *
 * Structure only, per Section 9: a real form with real labels, real error states,
 * no styling decisions of my own.
 */

import Link from "next/link";
import { readConfig } from "@/lib/config";
import { readDecisions, type DecisionLogEntry } from "@/lib/decision-log";
import { AGENT_SCENARIOS, policyForScenario } from "@/lib/demo-policy";
import { describePolicy } from "@/lib/policy-engine";
import { explorerTxUrl } from "@/lib/solana";

export const dynamic = "force-dynamic";

const OUTCOME_WORDS: Record<DecisionLogEntry["outcome"], string> = {
  allowed: "paid",
  refused: "refused",
};

function EntryRow({ entry }: { entry: DecisionLogEntry }) {
  return (
    <tr>
      <td>
        <span className="flint-num">
          {new Date(entry.at).toISOString().replace("T", " ").slice(0, 19)}
        </span>
      </td>
      <td>
        <strong>{OUTCOME_WORDS[entry.outcome]}</strong>
      </td>
      <td>
        <code>{entry.code}</code>
      </td>
      <td>
        <code>{entry.amount}</code>
      </td>
      <td className="flint-muted">{entry.reason}</td>
      <td>
        {entry.settlementTx ? (
          <a href={explorerTxUrl(entry.settlementTx)}>receipt</a>
        ) : entry.fundingTx ? (
          <a href={explorerTxUrl(entry.fundingTx)}>funded, not settled</a>
        ) : (
          <span className="flint-muted">no transaction</span>
        )}
      </td>
    </tr>
  );
}

export default async function AgentPage({
  searchParams,
}: {
  searchParams: Promise<{ last?: string }>;
}) {
  const { last } = await searchParams;
  let config = null;
  let configError: string | null = null;
  try {
    config = readConfig();
  } catch (error) {
    configError = (error as Error).message;
  }
  if (config === null) {
    return (
      <div className="flint-shell">
        <h1 className="text-2xl font-semibold">Test agent</h1>
        <p className="flint-note mt-3">
          The agent harness is not configured on this machine.
          <br />
          <code>{configError}</code>
        </p>
      </div>
    );
  }

  const entries = readDecisions(config.decisionLogPath, 25);
  const policy = policyForScenario(
    "pay",
    "(the service wallet)",
    config.assetMint.toBase58(),
    config.priceBaseUnits,
  );

  return (
    <div className="flint-shell">
      <h1 className="text-2xl font-semibold">Test agent — x402 payment harness</h1>
      <p className="flint-muted mt-2">
        This agent pays for one HTTP call. It receives a 402 carrying an FRS-1
        agreement, runs it through a deterministic policy engine, and then either
        pays through the same escrow program the human flow uses, or refuses and
        records why. There is no language model anywhere in that decision path.
      </p>

      <section className="flint-section" aria-labelledby="policy-heading">
        <h2 id="policy-heading" className="text-lg font-semibold">
          The agent&rsquo;s policy (paying scenario)
        </h2>
        <p className="flint-muted mt-1 text-sm">{describePolicy(policy)}</p>
        <p className="flint-muted mt-1 text-sm">
          Price asked by the endpoint: <code>{config.priceBaseUnits}</code> base units
          of <code>{config.assetSymbol}</code> (<code>{config.assetMint.toBase58()}</code>).
          The spend cap and session budget are the agent&rsquo;s own limits; the
          agreement&rsquo;s advertised cap is honoured too, and the stricter of the two
          applies.
        </p>
      </section>

      <section className="flint-section" aria-labelledby="run-heading">
        <h2 id="run-heading" className="text-lg font-semibold">
          Run it
        </h2>
        <p className="flint-muted mt-1 text-sm">
          This signs real transactions on Solana devnet and spends a little SOL on
          rent. It takes a few seconds while devnet confirms.
        </p>
        <form method="post" action="/api/agent/run" className="mt-3 flex flex-col gap-3">
          <div>
            <label htmlFor="scenario" className="block font-medium">
              Scenario
            </label>
            <select id="scenario" name="scenario" defaultValue="pay" className="mt-1 block">
              {AGENT_SCENARIOS.map((scenario) => (
                <option key={scenario.value} value={scenario.value}>
                  {scenario.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="settle" className="inline-flex items-center gap-2">
              <input type="checkbox" id="settle" name="settle" defaultChecked />
              <span>
                Settle after funding (release to the recipient, producing the receipt)
              </span>
            </label>
          </div>
          <div>
            <button type="submit" className="flint-button">
              Run the test agent
            </button>
          </div>
        </form>
        {last !== undefined ? (
          <p className="flint-note mt-3">
            Last run: <strong>{last}</strong>. The full record is in the log below.
          </p>
        ) : null}
      </section>

      <section className="flint-section" aria-labelledby="log-heading">
        <h2 id="log-heading" className="text-lg font-semibold">
          Decision log
        </h2>
        <p className="flint-muted mt-1 text-sm">
          Append-only, at <code>{config.decisionLogPath}</code>. Every decision is
          recorded with the full check-by-check evaluation, whether it allowed a
          payment or refused one.
        </p>
        {entries.length === 0 ? (
          <p className="flint-note mt-3">
            No decisions yet. Run the agent above and the first entry will appear here.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="flint-table">
              <caption>Most recent {entries.length} decisions</caption>
              <thead>
                <tr>
                  <th scope="col">When (UTC)</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Code</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Reason</th>
                  <th scope="col">On chain</th>
                </tr>
              </thead>
              <tbody>
                {[...entries].reverse().map((entry, index) => (
                  <EntryRow key={`${entry.at}-${index}`} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-4">
        <Link href="/">Back to the Flint overview</Link>
      </p>
    </div>
  );
}
