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

/** The limit currently in force — env is read per call so a test (or an operator)
 * can change it without restarting, and so no module-load ordering can freeze it. */
export function rateLimitConfig(): { limit: number; windowSeconds: number } {
  return {
    limit: readPositiveInt(process.env.FLINT_X402_RATE_LIMIT, DEFAULT_LIMIT),
    windowSeconds: readPositiveInt(
      process.env.FLINT_X402_RATE_WINDOW_SECONDS,
      DEFAULT_WINDOW_SECONDS,
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
  nowSeconds: number = Date.now() / 1000,
): RateLimitResult {
  const { limit, windowSeconds } = rateLimitConfig();
  const addressKey = clientAddressKey(request);

  if (buckets.size >= MAX_BUCKETS) {
    for (const [key, bucket] of buckets) {
      if (nowSeconds >= bucket.windowStart + windowSeconds) buckets.delete(key);
    }
    // Still full after dropping everything expired: refuse new addresses rather
    // than grow without bound. A fresh window is a minute away, not a restart.
    if (buckets.size >= MAX_BUCKETS && !buckets.has(addressKey)) {
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

  const existing = buckets.get(addressKey);
  const bucket: Bucket =
    existing === undefined || nowSeconds >= existing.windowStart + windowSeconds
      ? { windowStart: nowSeconds, count: 0 }
      : existing;

  bucket.count += 1;
  buckets.set(addressKey, bucket);

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
