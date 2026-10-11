/**
 * Agent / x402 flow configuration (Phase 2).
 *
 * Every value here is devnet-only by construction (FLINT_BUILD_CONTEXT.md
 * Sections 6.3 / 12): the only cluster is fixed in `lib/solana.ts`, and nothing
 * in this module can introduce another one.
 *
 * Deliberately *not* hardcoded: the service keypair path, the agent keypair path
 * and the asset mint. Those three are per-deployment facts, and a build that
 * silently defaults them would either sign with the wrong wallet or transact in
 * an unintended asset. `readConfig()` collects every missing variable and fails
 * once, with all of them named, rather than failing later inside a request.
 *
 * Note `assetSymbol` (Section 4.5): a symbol is a **display-only app-layer
 * lookup**. Nothing on chain stores it, and no program check ever reads it.
 */

import { PublicKey } from "@solana/web3.js";
import { CLUSTER } from "./solana";

/**
 * The devnet program id. Same default as `Anchor.toml` / `declare_id!`; override
 * with `FLINT_PROGRAM_ID` if a different program is ever deployed.
 */
export const DEFAULT_PROGRAM_ID = "ziZiaCVcDaenoUP7jHdEPk4R2XJ8zeY5UbMPKFuqZxE";

/**
 * Circle's devnet USDC mint — the exact address from Circle's own contract
 * address page ("Solana Devnet" row), confirmed for Phase 5a rather than
 * recalled from memory. Display defaults only: nothing on chain reads it.
 */
export const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** Everything the agent flow needs, resolved and validated once per process. */
export interface AgentFlowConfig {
  /** The deployed Flint escrow program. */
  programId: PublicKey;
  /** Keypair of the *service* (the recipient in the x402 flow). Signs `create`. */
  serviceKeypairPath: string;
  /** Keypair of the *test agent* (the payer). Signs `fund` and `release`. */
  agentKeypairPath: string;
  /** The SPL mint agreements are denominated in (FRS-1 `asset`). */
  assetMint: PublicKey;
  /** Display-only symbol for `assetMint`. Never sent to the program. */
  assetSymbol: string;
  /** The price the endpoint asks for, in `assetMint` base units (decimal string). */
  priceBaseUnits: string;
  /** How long a freshly proposed agreement stays valid. Clock-checked on chain. */
  agreementTtlSeconds: number;
  /** Append-only decision log (JSONL). */
  decisionLogPath: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Flint agent flow is not configured:\n  - ${problems.join("\n  - ")}\n` +
        `See app/.env.example for the full list.`,
    );
    this.name = "ConfigError";
  }
}

/** Reads base units as a positive integer string; rejects `0`, `NaN`, `1.5`. */
function readPositiveBaseUnits(raw: string, name: string, problems: string[]): string {
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    problems.push(`${name} must be a positive integer in base units, got "${raw}"`);
    return "0";
  }
  return raw;
}

function readPubkey(raw: string | undefined, name: string, problems: string[]): PublicKey {
  if (!raw) {
    problems.push(`${name} is required`);
    return PublicKey.default;
  }
  try {
    return new PublicKey(raw);
  } catch {
    problems.push(`${name} is not a valid base58 public key: "${raw}"`);
    return PublicKey.default;
  }
}

function readKeypairPath(raw: string | undefined, name: string, problems: string[]): string {
  if (!raw) {
    problems.push(`${name} is required (a path to a gitignored keypair file)`);
    return "";
  }
  if (!raw.endsWith(".json")) {
    problems.push(`${name} must be a path to a keypair .json file, got "${raw}"`);
  }
  return raw;
}

/**
 * Resolves the configuration or throws a single `ConfigError` listing every
 * problem. Called at the edge of each entry point (route handler, agent run),
 * never at module load, so a missing variable produces a clear 503 rather than
 * a module-resolution error at boot.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): AgentFlowConfig {
  const problems: string[] = [];

  // FLINT_PROGRAM_ID has a documented devnet default, so its absence is not a
  // problem — the default is a public constant, not a secret.
  let programId: PublicKey;
  if (env.FLINT_PROGRAM_ID) {
    try {
      programId = new PublicKey(env.FLINT_PROGRAM_ID);
    } catch {
      problems.push(
        `FLINT_PROGRAM_ID is not a valid base58 public key: "${env.FLINT_PROGRAM_ID}"`,
      );
      programId = new PublicKey(DEFAULT_PROGRAM_ID);
    }
  } else {
    programId = new PublicKey(DEFAULT_PROGRAM_ID);
  }

  const serviceKeypairPath = readKeypairPath(
    env.FLINT_SERVICE_KEYPAIR,
    "FLINT_SERVICE_KEYPAIR",
    problems,
  );
  const agentKeypairPath = readKeypairPath(
    env.FLINT_AGENT_KEYPAIR,
    "FLINT_AGENT_KEYPAIR",
    problems,
  );
  const assetMint = readPubkey(env.FLINT_ASSET_MINT, "FLINT_ASSET_MINT", problems);

  const priceBaseUnits = readPositiveBaseUnits(
    env.FLINT_PRICE_BASE_UNITS ?? "1000000",
    "FLINT_PRICE_BASE_UNITS",
    problems,
  );

  const ttlRaw = env.FLINT_AGREEMENT_TTL_SECONDS ?? "900";
  const agreementTtlSeconds = Number(ttlRaw);
  if (!Number.isInteger(agreementTtlSeconds) || agreementTtlSeconds < 60) {
    problems.push(
      `FLINT_AGREEMENT_TTL_SECONDS must be an integer >= 60 (the program requires a strictly future expiry), got "${ttlRaw}"`,
    );
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    programId: programId ?? new PublicKey(DEFAULT_PROGRAM_ID),
    serviceKeypairPath,
    agentKeypairPath,
    assetMint,
    // Display-only (Section 4.5), and the default is mint-aware as of Phase 5a:
    // the demo asset is Circle's devnet USDC, so an unset symbol may claim
    // "USDC" *only* when the configured mint is exactly that mint — everything
    // else falls back to "TST", because a throwaway test mint must never be
    // presented as a real stablecoin in the UI or a receipt. An explicit
    // FLINT_ASSET_SYMBOL always wins (the automated tests pin TST that way).
    assetSymbol:
      env.FLINT_ASSET_SYMBOL ??
      (assetMint.toBase58() === USDC_DEVNET_MINT ? "USDC" : "TST"),
    priceBaseUnits,
    agreementTtlSeconds,
    decisionLogPath:
      env.FLINT_DECISION_LOG ?? `${process.cwd()}/.data/decisions.jsonl`,
  };
}

/** What the human flow needs: public settings only, never any keypair. */
export interface HumanFlowConfig {
  programId: PublicKey;
  assetMint: PublicKey;
  assetSymbol: string;
}

export function readHumanConfig(env: NodeJS.ProcessEnv = process.env): HumanFlowConfig {
  const problems: string[] = [];

  let programId = new PublicKey(DEFAULT_PROGRAM_ID);
  if (env.FLINT_PROGRAM_ID) {
    try {
      programId = new PublicKey(env.FLINT_PROGRAM_ID);
    } catch {
      problems.push(
        `FLINT_PROGRAM_ID is not a valid base58 public key: "${env.FLINT_PROGRAM_ID}"`,
      );
    }
  }

  const assetMint = readPubkey(env.FLINT_ASSET_MINT, "FLINT_ASSET_MINT", problems);

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    programId,
    assetMint,
    assetSymbol:
      env.FLINT_ASSET_SYMBOL ??
      (assetMint.toBase58() === USDC_DEVNET_MINT ? "USDC" : "TST"),
  };
}

/** The cluster this build talks to — re-exported so config consumers need one import. */
export const CONFIG_CLUSTER = CLUSTER;
