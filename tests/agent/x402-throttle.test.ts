/**
 * The x402 endpoint's rate limit (FLINT_BUILD_CONTEXT.md Section 6.3).
 *
 * The claim under test is narrow: an *unpaid* request to the public 402 endpoint
 * proposes a real agreement on devnet at the service wallet's expense, so a caller
 * past the limit must be refused with a status and a message it can act on — `429`,
 * a `Retry-After`, and an explanation — rather than silently dropped or let
 * through. "Nothing was created for this request" is asserted as the *absence of
 * the proposal-signature header*, which is the server's own evidence that it did —
 * or did not — reach the chain.
 *
 * Three layers, deliberately:
 *
 *   - **Keying** — `clientAddressKey` is pure, so header precedence is proven
 *     directly rather than through a socket.
 *   - **The window, hermetically** — `checkX402RateLimit` takes `nowSeconds`, so
 *     the countdown and the rollover are proven without sleeping a real minute and
 *     without a chain call.
 *   - **The refusal over a real socket**, through the actual route handler in a
 *     real `node:http` server, because the status code, the headers and the JSON
 *     body are what a caller (and an auditor) actually sees.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { assert } from "chai";
import { GET as x402Responder } from "../../app/app/api/x402/route";
import {
  checkX402RateLimit,
  clientAddressKey,
  rateLimitConfig,
  resetX402RateLimit,
} from "../../app/lib/throttle";

/** A minimal request carrying just the headers the limiter looks at. */
function requestFrom(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1/api/x402", { headers });
}

/** Sets environment variables for one block of tests and restores them after. */
function withEnv(values: Record<string, string>): { restore: () => void } {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  return {
    restore: () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/** Wraps the real route handler in a real HTTP server, as a caller would hit it. */
async function startResponder(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const port = (server.address() as AddressInfo).port;
        const response = await x402Responder(
          new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
            method: req.method ?? "GET",
            headers: req.headers as Record<string, string>,
            ...(body.length > 0 ? { body } : {}),
          }),
        );
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        res.writeHead(response.status, headers);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(error instanceof Error ? (error.stack ?? error.message) : String(error));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("client address keying", () => {
  it("takes the first entry of x-forwarded-for — the caller, not the proxies", () => {
    assert.equal(
      clientAddressKey(
        requestFrom({ "x-forwarded-for": "203.0.113.9, 70.41.3.18, 150.172.238.178" }),
      ),
      "203.0.113.9",
      "only the first hop is the client; the rest are infrastructure",
    );
    assert.equal(
      clientAddressKey(requestFrom({ "x-forwarded-for": " 198.51.100.7 " })),
      "198.51.100.7",
      "a proxy that pads the header must not produce a second bucket for one caller",
    );
  });

  it("falls back to the single-value equivalents a host may set instead", () => {
    assert.equal(clientAddressKey(requestFrom({ "x-real-ip": "198.51.100.8" })), "198.51.100.8");
    assert.equal(
      clientAddressKey(requestFrom({ "cf-connecting-ip": "198.51.100.9" })),
      "198.51.100.9",
    );
    assert.equal(
      clientAddressKey(
        requestFrom({ "x-forwarded-for": "198.51.100.10", "x-real-ip": "10.0.0.1" }),
      ),
      "198.51.100.10",
      "x-forwarded-for wins when both are present — it is the one set for us",
    );
  });

  it("shares one conservative bucket when the caller cannot be identified", () => {
    // No header at all is not a bypass: it lands in a single bucket, so
    // unidentified callers throttle each other rather than being unlimited.
    assert.equal(clientAddressKey(requestFrom()), "unknown");
    assert.equal(clientAddressKey(requestFrom({ "x-forwarded-for": "   " })), "unknown");
    assert.equal(clientAddressKey(requestFrom({ "x-real-ip": "" })), "unknown");
  });
});

describe("the window", () => {
  let env: { restore: () => void };
  const address = "198.51.100.20";
  /** Injected seconds, so no test sleeps for a real minute. */
  const t0 = 1_000_000;

  before(() => {
    env = withEnv({ FLINT_X402_RATE_LIMIT: "3", FLINT_X402_RATE_WINDOW_SECONDS: "60" });
  });
  after(() => env.restore());
  beforeEach(() => resetX402RateLimit());

  it("allows up to the limit, then refuses — with a Retry-After that counts down", () => {
    const headers = { "x-forwarded-for": address };
    for (let i = 1; i <= 3; i += 1) {
      assert.isTrue(
        checkX402RateLimit(requestFrom(headers), t0).decision.allowed,
        `request ${i} of 3 is within the limit`,
      );
    }

    const refused = checkX402RateLimit(requestFrom(headers), t0);
    assert.isFalse(refused.decision.allowed, "the fourth is past the limit");
    assert.equal(refused.decision.refusedBy, "address");
    assert.equal(refused.decision.limit, 3);
    assert.equal(refused.decision.windowSeconds, 60);
    assert.equal(refused.decision.retryAfterSeconds, 60, "the whole window is still ahead of it");

    // The countdown is real, not a constant: half a window later it says half.
    const later = checkX402RateLimit(requestFrom(headers), t0 + 30);
    assert.isFalse(later.decision.allowed);
    assert.equal(later.decision.retryAfterSeconds, 30);
  });

  it("rolls over once the window has elapsed", () => {
    const headers = { "x-forwarded-for": address };
    for (let i = 0; i < 4; i += 1) checkX402RateLimit(requestFrom(headers), t0);
    assert.isFalse(checkX402RateLimit(requestFrom(headers), t0).decision.allowed);

    // One second before the boundary it is still refused...
    assert.isFalse(checkX402RateLimit(requestFrom(headers), t0 + 59).decision.allowed);
    // ...and at the boundary the bucket is fresh, so the caller is served again.
    const fresh = checkX402RateLimit(requestFrom(headers), t0 + 60);
    assert.isTrue(
      fresh.decision.allowed,
      "a fixed window resets, rather than being a bucket that never refills",
    );
    assert.equal(fresh.decision.retryAfterSeconds, 60);
  });

  it("counts each address separately — one caller cannot refuse another", () => {
    const noisy = requestFrom({ "x-forwarded-for": "203.0.113.5" });
    const quiet = requestFrom({ "x-forwarded-for": "203.0.113.6" });
    for (let i = 0; i < 5; i += 1) checkX402RateLimit(noisy, t0);
    assert.isFalse(checkX402RateLimit(noisy, t0).decision.allowed);
    assert.isTrue(
      checkX402RateLimit(quiet, t0).decision.allowed,
      "a throttled neighbour is not this caller's problem",
    );
  });

  it("throttles unidentified callers against each other", () => {
    for (let i = 0; i < 5; i += 1) checkX402RateLimit(requestFrom(), t0);
    assert.isFalse(
      checkX402RateLimit(requestFrom(), t0).decision.allowed,
      "a request with no address header still counts, and shares the one bucket",
    );
  });
});

describe("configuration", () => {
  let env: { restore: () => void } | undefined;
  after(() => env?.restore());

  it("defaults to 12 requests per 60 seconds when nothing is set", () => {
    env = withEnv({ FLINT_X402_RATE_LIMIT: "", FLINT_X402_RATE_WINDOW_SECONDS: "" });
    assert.deepEqual(rateLimitConfig(), { limit: 12, windowSeconds: 60 });
    env.restore();
  });

  it("takes the deployment's own numbers when they are set", () => {
    env = withEnv({ FLINT_X402_RATE_LIMIT: "7", FLINT_X402_RATE_WINDOW_SECONDS: "30" });
    assert.deepEqual(rateLimitConfig(), { limit: 7, windowSeconds: 30 });
    env.restore();
  });

  it("falls back rather than reading nonsense as unlimited or as zero", () => {
    // Each of these would be catastrophic if taken literally: a limit of 0 refuses
    // every caller, and an unparseable one that defaulted to "no limit" would leave
    // the wallet unprotected by a typo.
    for (const broken of ["0", "-5", "abc", "1.5"]) {
      env = withEnv({ FLINT_X402_RATE_LIMIT: broken, FLINT_X402_RATE_WINDOW_SECONDS: broken });
      assert.deepEqual(
        rateLimitConfig(),
        { limit: 12, windowSeconds: 60 },
        `"${broken}" is not a limit; the default is safer than either extreme`,
      );
      env.restore();
    }
  });
});

describe("the refusal a caller actually sees", () => {
  let env: { restore: () => void };
  let responder: { origin: string; close: () => Promise<void> };

  before(async () => {
    // One request per hour: the second request is unambiguously past the limit, and
    // the window cannot expire mid-test — so the test is about the refusal rather
    // than about timing.
    env = withEnv({ FLINT_X402_RATE_LIMIT: "1", FLINT_X402_RATE_WINDOW_SECONDS: "3600" });
    resetX402RateLimit();
    responder = await startResponder();
  });
  after(async () => {
    if (responder !== undefined) await responder.close();
    env?.restore();
    resetX402RateLimit();
  });

  it("answers 429 with a Retry-After and a reason, and creates nothing on chain", async () => {
    const headers = { "x-forwarded-for": "198.51.100.30" };

    // The allowed request is answered normally: 402, with the proposal signature
    // the server recorded. That header is the evidence this request did reach the
    // chain — and so did cost the service wallet rent.
    const first = await fetch(`${responder.origin}/api/x402`, { headers });
    const firstBody = (await first.json()) as { error?: string };
    assert.equal(first.status, 402, JSON.stringify(firstBody));
    assert.isString(
      first.headers.get("x-flint-proposal-tx"),
      "an allowed request proposes its agreement on chain",
    );
    assert.equal(first.headers.get("cache-control"), "no-store");

    // The second is past the limit. It must be a refusal a client cannot mistake for
    // success, with a Retry-After it can honour, and a body that explains itself.
    const second = await fetch(`${responder.origin}/api/x402`, { headers });
    const secondText = await second.text();
    assert.equal(second.status, 429, secondText);
    assert.isNull(
      second.headers.get("x-flint-proposal-tx"),
      "the refused request created nothing on chain — there is no proposal to point at",
    );
    const retryAfter = second.headers.get("retry-after");
    assert.isString(
      retryAfter,
      "Retry-After is how a client knows to come back rather than retry blindly",
    );
    assert.isAtLeast(Number(retryAfter), 1);
    assert.isAtMost(Number(retryAfter), 3600);
    assert.equal(second.headers.get("cache-control"), "no-store");

    const refusal = JSON.parse(secondText) as {
      error: string;
      message: string;
      limit: number;
      refusedBy: string;
      retryAfterSeconds: number;
      accepts?: unknown;
    };
    assert.equal(refusal.error, "rate_limited", "machine-readable, not a bare status");
    assert.equal(refusal.limit, 1);
    assert.equal(refusal.refusedBy, "address");
    assert.equal(refusal.retryAfterSeconds, Number(retryAfter), "header and body agree");
    assert.isUndefined(
      refusal.accepts,
      "a refusal is not an x402 envelope: there is nothing here to pay",
    );
    assert.include(
      refusal.message,
      "Nothing was created for this request",
      "the caller is told the request cost nothing, rather than left guessing",
    );
    assert.include(
      refusal.message,
      "proposes a real escrow agreement on devnet",
      "and why the limit exists, in terms of the cost it protects",
    );

    // Still refused on a third attempt, while a different address is unaffected:
    // the limit is per address, not a switch that turns the endpoint off.
    const third = await fetch(`${responder.origin}/api/x402`, { headers });
    assert.equal(third.status, 429, "the window has not elapsed");
    await third.text();
    const other = await fetch(`${responder.origin}/api/x402`, {
      headers: { "x-forwarded-for": "203.0.113.31" },
    });
    const otherText = await other.text();
    assert.equal(other.status, 402, otherText);
  });
});



