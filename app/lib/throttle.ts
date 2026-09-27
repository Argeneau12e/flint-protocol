/**
 * A per-IP, fixed-window rate limit for the public x402 endpoint (Section 6.3).
 *
 * Why this exists at all: an *unpaid* request to `/api/x402` is not a read. It
 * proposes a real FRS-1 agreement on devnet, and the service wallet pays the rent
 * for that account — so a loop, or a judging session's worth of idle curiosity,
 * spends a wallet. The handler therefore checks this *before* it does any work, so
 * a refused request never reaches the RPC.
 *
 * Deliberately in-memory and dependency-free. This is a devnet hackathon demo in a
 * single process: a shared store would be more machinery than the threat justifies,
 * and its absence has exactly one failure mode — a restart resets the window. The
 * limits are configuration rather than constants (`FLINT_X402_RATE_LIMIT`,
 * `FLINT_X402_RATE_WINDOW_SECONDS`), so they can be tightened per deployment.
 *
 * Keyed by client IP, read from the forwarding headers a hosting proxy sets. When
 * none is present every caller shares one `"unknown"` bucket, which is conservative
 * rather than permissive: the thing being protected is a wallet, not a permission.
 */

/** What the caller is told, and what the handler logs. */
export interface RateLimitDecision {
  allowed: boolean;
  /** The ceiling in force, echoed so a 429 can explain itself in concrete numbers. */
  limit: number;
  windowSeconds: number;
  /** Seconds until this bucket's window resets — also sent as `Retry-After`. */
  retryAfterSeconds: number;
  /**
   * Which bucket refused. v1 has only the per-address bucket; the field is named
   * rather than omitted so a log line (and the response) can distinguish buckets
   * if a second kind is ever added.
   */
  refusedBy?: "address";
}

export interface RateLimitResult {
  decision: RateLimitDecision;
  /** The bucket this request was counted in, for logs. */
  addressKey: string;
}

/**
 * The named buckets, each with its own environment overrides.
 *
 * A *scope* is one protected endpoint. Scopes exist so two endpoints cannot share
 * a budget — an agent run and an unpaid 402 are different costs with different
 * cadences, and coupling them would mean a burst of one refusing the other.
 * Env names are listed per scope rather than derived from the scope string, so the
 * public variable names stay exactly as documented in `.env.example`.
 */
export interface ThrottleScope {
  /** Requests allowed per address per window when nothing overrides it. */
  defaultLimit: number;
  defaultWindowSeconds: number;
  limitEnv: string;
  windowEnv: string;
}

/**
 * Requests allowed per address per window, when nothing overrides it.
 *
 * Twelve a minute, not two: this is a backstop against a loop, not a quota for
 * real use, and the flows in this repo (and their tests) legitimately issue a
 * handful of unpaid requests in a row. Overshooting is bounded — each refused
 * request creates nothing — while under-setting it would make the endpoint look
 * broken to a person clicking around. Override per deployment with
 * `FLINT_X402_RATE_LIMIT`.
 */
const DEFAULT_LIMIT = 12;
const DEFAULT_WINDOW_SECONDS = 60;

const SCOPES: Record<string, ThrottleScope> = {
  /**
   * `/api/x402` GET. An unpaid request proposes a real agreement on chain, so the
   * service wallet pays rent for it (the reason this module exists).
   */
  x402: {
    defaultLimit: DEFAULT_LIMIT,
    defaultWindowSeconds: DEFAULT_WINDOW_SECONDS,
    limitEnv: "FLINT_X402_RATE_LIMIT",
    windowEnv: "FLINT_X402_RATE_WINDOW_SECONDS",
  },
  /**
   * `/api/agent/run` POST. An unauthenticated POST here runs the whole agent
   * loop against a live keypair: it funds, and sometimes releases, a real
   * agreement — so each call spends the *agent* wallet's SOL for fees and its
   * tokens for the payment. Lower than the 402 default on purpose: a run costs
   * several transactions, not one, and a person clicking "run" twice in a row is
   * still served (two is under this limit).
   */
  agentRun: {
    defaultLimit: 3,
    defaultWindowSeconds: 60,
    limitEnv: "FLINT_AGENT_RUN_RATE_LIMIT",
    windowEnv: "FLINT_AGENT_RUN_RATE_WINDOW_SECONDS",
  },
};

/** The scope used when a caller names none; the 402 bucket, the original one. */
export const DEFAULT_SCOPE = "x402";

/**
 * Bound on retained buckets. Expired buckets are dropped opportunistically, and
 * this is the hard ceiling for the pathological case (every request from a new
 * address inside one window). No timers, no sweeps on a schedule.
 */
const MAX_BUCKETS = 4096;

interface Bucket {
  /** Start of the current fixed window, in seconds. */
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

/** Reads a positive integer from the environment, falling back on nonsense. */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** The limit currently in force for a scope. Env is read per call so a test (or an
 * operator) can change it without restarting, and so no module-load ordering can
 * freeze it. */
export function rateLimitConfig(scope: string = DEFAULT_SCOPE): {
  limit: number;
  windowSeconds: number;
} {
  const scopeConfig = SCOPES[scope] ?? SCOPES[DEFAULT_SCOPE];
  return {
    limit: readPositiveInt(process.env[scopeConfig.limitEnv], scopeConfig.defaultLimit),
    windowSeconds: readPositiveInt(
      process.env[scopeConfig.windowEnv],
      scopeConfig.defaultWindowSeconds,
    ),
  };
}

/**
 * The bucket key for a request: the first client address a proxy says it saw.
 *
 * `x-forwarded-for` is a list (client, then proxies), so only its first entry is
 * the caller. The later headers are the single-value equivalents some hosts set
 * instead. A request with none of them is keyed `"unknown"` and shares a bucket.
 */
export function clientAddressKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim() ?? "";
    if (first !== "") return first;
  }
  for (const header of ["x-real-ip", "cf-connecting-ip"] as const) {
    const value = request.headers.get(header);
    if (value !== null && value.trim() !== "") return value.trim();
  }
  return "unknown";
}

/**
 * Counts one request against its bucket and decides.
 *
 * `nowSeconds` is injectable so a test can prove the window rolls over without
 * sleeping for a real minute — the only reason it is a parameter at all.
 */
export function checkX402RateLimit(
  request: Request,
  scope: string = DEFAULT_SCOPE,
  nowSeconds: number = Date.now() / 1000,
): RateLimitResult {
  const { limit, windowSeconds } = rateLimitConfig(scope);
  const addressKey = clientAddressKey(request);
  // The scope is part of the key, not just a lookup for the limit: without it two
  // endpoints would draw on one shared budget, so a burst of unpaid 402s could
  // refuse a legitimate agent run (and vice versa) — the coupling the scope
  // registry exists to prevent.
  const bucketKey = `${scope}:${addressKey}`;

  if (buckets.size >= MAX_BUCKETS) {
    for (const [key, bucket] of buckets) {
      if (nowSeconds >= bucket.windowStart + windowSeconds) buckets.delete(key);
    }
    // Still full after dropping everything expired: refuse new addresses rather
    // than grow without bound. A fresh window is a minute away, not a restart.
    if (buckets.size >= MAX_BUCKETS && !buckets.has(bucketKey)) {
      return {
        decision: {
          allowed: false,
          limit,
          windowSeconds,
          retryAfterSeconds: windowSeconds,
          refusedBy: "address",
        },
        addressKey,
      };
    }
  }

  const existing = buckets.get(bucketKey);
  const bucket: Bucket =
    existing === undefined || nowSeconds >= existing.windowStart + windowSeconds
      ? { windowStart: nowSeconds, count: 0 }
      : existing;

  bucket.count += 1;
  // Scoped, exactly as the lookup above: storing under the bare address would make
  // every read miss (the map holds "1.2.3.4", the lookup asks for "x402:1.2.3.4"),
  // so every request would start a fresh bucket at count 1 and never be refused.
  buckets.set(bucketKey, bucket);

  const resetsIn = Math.max(1, Math.ceil(bucket.windowStart + windowSeconds - nowSeconds));
  return {
    decision: {
      allowed: bucket.count <= limit,
      limit,
      windowSeconds,
      retryAfterSeconds: resetsIn,
      ...(bucket.count <= limit ? {} : { refusedBy: "address" as const }),
    },
    addressKey,
  };
}

/**
 * Clears every bucket. Test-only: it exists so one test's traffic cannot refuse
 * another test's request, and so suites that share a process (the x402 flow suite
 * and this one) do not inherit each other's counts.
 */
export function resetX402RateLimit(): void {
  buckets.clear();
}
