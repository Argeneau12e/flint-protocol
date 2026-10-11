/**
 * The test agent's harness page.
 *
 * Acceptance 7.2.4 asks that a refusal be "logged/visible, not silent" — this is the
 * visible half. The page re-reads the log from disk on every request, so what is on
 * screen is the durable record rather than a flash message a refresh erases.
 *
 * The layout follows how the page is actually read. First: what this agent is allowed
 * to spend, because that is what makes everything below it make sense. Then the run
 * control. Then the log — where the interesting part is not the verdict, which is one
 * word, but the reason, which used to be a column wide enough to break the table on a
 * phone. Each row now leads with the verdict and opens to the check-by-check
 * evaluation, so the evidence is one tap away instead of six columns away.
 */

import { readConfig } from "@/lib/config";
import { readDecisions, type DecisionLogEntry } from "@/lib/decision-log";
import { AGENT_SCENARIOS, policyForScenario } from "@/lib/demo-policy";
import { assetDisplay, formatBaseUnits } from "@/lib/display";
import { describePolicy } from "@/lib/policy-engine";
import { explorerTxUrl, getConnection } from "@/lib/solana";
import { getMint } from "@solana/spl-token";

export const dynamic = "force-dynamic";

const OUTCOME_WORDS: Record<DecisionLogEntry["outcome"], string> = {
  allowed: "paid",
  refused: "refused",
};

function EntryRow({
  entry,
  amountText,
}: {
  entry: DecisionLogEntry;
  amountText: (baseUnits: string) => string;
}) {
  return (
    <tr>
      <td>
        <span className="flint-num">
          {new Date(entry.at).toISOString().replace("T", " ").slice(0, 16)}
        </span>
      </td>
      <td>
        <span
          className={
            entry.outcome === "allowed"
              ? "flint-tag flint-tag-ok"
              : "flint-tag flint-tag-no"
          }
        >
          {OUTCOME_WORDS[entry.outcome]}
        </span>
      </td>
      <td>
        <code>{amountText(entry.amount)}</code>
      </td>
      <td className="flint-reason">
        {/* The verdict is the summary; the reasoning is what a reader came for, and
            it used to be a table column. Collapsed, it is one line; opened, it is
            the full check-by-check evaluation the log actually stores. */}
        <details className="flint-more">
          <summary>
            <code>{entry.code}</code>
          </summary>
          <p>{entry.reason}</p>
          <ul
            className="flint-checks"
            style={{ marginTop: "var(--flint-space-3)" }}
          >
            {entry.checks.map((check, index) => (
              <li key={`${check.code}-${index}`}>
                <span style={{ whiteSpace: "normal" }}>
                  <code>{check.code}</code> — {check.detail}
                </span>
                <span
                  className={
                    check.passed
                      ? "flint-tag flint-tag-ok"
                      : "flint-tag flint-tag-no"
                  }
                >
                  {check.passed ? "pass" : "fail"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      </td>
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
  try {
    config = readConfig();
  } catch (error) {
    console.error("agent page unavailable:", error);
  }
  if (config === null) {
    return (
      <div className="flint-stack">
        <h1 className="flint-page-title">Test agent</h1>
        <div className="flint-card flint-prose">
          <p className="flint-muted">
            The agent demo is not enabled on this deployment.
          </p>
        </div>
      </div>
    );
  }

  // Amounts read as figures with the symbol rather than raw base units (Phase 5a).
  // Null only when the mint cannot be read, and then the raw figure plus
  // "base units" is the honest fallback. The reason column stays verbatim: it is the
  // recorded decision text, and the policy tests assert on it as evidence.
  let assetDecimals: number | null = null;
  try {
    assetDecimals = (await getMint(getConnection(), config.assetMint)).decimals;
  } catch {
    assetDecimals = null;
  }
  // The label explains what the configured symbol means — a raw code like TST
  // is an abbreviation nobody can read on its own.
  const asset = assetDisplay(config.assetSymbol);
  const amountText = (baseUnits: string): string =>
    assetDecimals === null
      ? `${baseUnits} base units`
      : `${formatBaseUnits(baseUnits, assetDecimals)} ${asset.label}`;

  const entries = readDecisions(config.decisionLogPath, 25);
  const policy = policyForScenario(
    "pay",
    "(the service wallet)",
    config.assetMint.toBase58(),
    config.priceBaseUnits
  );

  return (
    <div className="flint-stack">
      <header>
        <p className="flint-eyebrow">Agent</p>
        <h1 className="flint-page-title">Test agent</h1>
        <p className="flint-muted" style={{ fontSize: "var(--flint-text-lg)" }}>
          This agent pays for one HTTP call. It receives a 402 carrying an FRS-1
          agreement, runs it through a deterministic policy engine, and then
          either pays through the same escrow program the human flow uses, or
          refuses and records why. There is no language model anywhere in that
          decision path.
        </p>
      </header>

      <div className="flint-card">
        <div
          className="flint-row flint-row-between"
          style={{ alignItems: "start" }}
        >
          <div>
            <h2 style={{ marginTop: 0 }}>Run it</h2>
            <p
              className="flint-muted"
              style={{ fontSize: "var(--flint-text-sm)" }}
            >
              This signs real transactions on Solana devnet and spends a little
              SOL on rent. It takes a few seconds while devnet confirms.
            </p>
          </div>
        </div>

        <form
          method="post"
          action="/api/agent/run"
          className="flint-form"
          style={{ marginTop: "var(--flint-space-6)" }}
        >
          <div className="flint-field">
            <label htmlFor="scenario" className="flint-label">
              Scenario
            </label>
            <select
              id="scenario"
              name="scenario"
              defaultValue="pay"
              className="flint-input"
            >
              {AGENT_SCENARIOS.map((scenario) => (
                <option key={scenario.value} value={scenario.value}>
                  {scenario.label}
                </option>
              ))}
            </select>
          </div>

          <label htmlFor="settle" className="flint-check">
            <input type="checkbox" id="settle" name="settle" defaultChecked />
            <span>
              Settle after funding{" "}
              <span className="flint-muted">
                (release to the recipient, producing the receipt)
              </span>
            </span>
          </label>

          <div>
            <button type="submit" className="flint-button flint-primary">
              Run the test agent
            </button>
          </div>
        </form>

        {last === undefined ? null : (
          <p
            className="flint-note flint-success"
            style={{ marginTop: "var(--flint-space-6)" }}
          >
            Last run: <strong>{last}</strong>. The full record is in the log
            below.
          </p>
        )}
      </div>
      <div className="flint-card">
        <h2 style={{ marginTop: 0 }}>The policy it runs</h2>
        <p
          className="flint-muted"
          style={{
            fontSize: "var(--flint-text-sm)",
            marginBottom: "var(--flint-space-4)",
          }}
        >
          Shown for the <code>pay</code> scenario, rendered from the same
          function the endpoint uses &#32;&#8212; not a description of it.
        </p>
        <dl className="flint-kv-group">
          <div className="flint-kv">
            <dt>Spend cap</dt>
            <dd className="flint-num">{amountText(policy.spendCap)}</dd>
          </div>
          <div className="flint-kv">
            <dt>Session budget</dt>
            <dd className="flint-num">{amountText(policy.sessionBudget)}</dd>
          </div>
          <div className="flint-kv">
            <dt>Price asked by the endpoint</dt>
            <dd className="flint-num">{amountText(config.priceBaseUnits)}</dd>
          </div>
          <div className="flint-kv">
            <dt>Allowed recipients</dt>
            <dd className="flint-num">{policy.recipientAllowlist.length}</dd>
          </div>
          <div className="flint-kv">
            <dt>Allowed assets</dt>
            <dd className="flint-num">{policy.assetAllowlist.length}</dd>
          </div>
          <div className="flint-kv">
            <dt>Maximum validity</dt>
            <dd className="flint-num">{policy.maxTtlSeconds}s</dd>
          </div>
        </dl>
        <details
          className="flint-more"
          style={{ marginTop: "var(--flint-space-4)" }}
        >
          <summary>Why the cap can come out smaller than it looks</summary>
          <p>
            The spend cap and session budget are the agent&#39;s own limits; the
            agreement&#39;s advertised cap is honoured too, and the stricter of
            the two applies. The engine reports the figure it actually enforced:{" "}
            <span className="flint-num">{describePolicy(policy)}</span>
          </p>
        </details>
      </div>

      <section className="flint-block" aria-labelledby="log-heading">
        <h2 id="log-heading">Decision log</h2>
        {entries.length === 0 ? (
          <div className="flint-card">
            <p className="flint-muted" style={{ margin: 0 }}>
              No decisions yet. Run the agent above and the first entry will
              appear here.
            </p>
          </div>
        ) : (
          <div className="flint-card flint-card-flush">
            <div className="flint-scroll-x">
              <table className="flint-table">
                <caption>
                  Most recent {entries.length} decisions, append-only at{" "}
                  <code>{config.decisionLogPath}</code>
                </caption>
                <thead>
                  <tr>
                    <th scope="col">When (UTC)</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Why</th>
                    <th scope="col">On chain</th>
                  </tr>
                </thead>
                <tbody>
                  {[...entries].reverse().map((entry, index) => (
                    <EntryRow
                      key={`${entry.at}-${index}`}
                      entry={entry}
                      amountText={amountText}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
