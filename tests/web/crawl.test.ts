/**
 * The crawl safety net (Phase 5a, item 5): every page the site links to must
 * actually answer 200.
 *
 * This is the test that would have caught the `/verify` 404 — the landing page
 * linked a route that did not exist, and no suite looked at links at all. The
 * crawl starts from the four known routes plus a well-formed signature for the
 * dynamic `/verify/[tx]` segment, then follows every same-origin `href` it
 * finds, transitively, asserting a 200 for each. External links (explorers,
 * Circle) are deliberately out of scope: another site being down is not our
 * regression.
 */

import { assert } from "chai";
import { isTransactionSignature } from "../../app/lib/signature";
import { startDevServer, type DevServer } from "./dev-server";

// bs58 is already in the tree (a web3.js dependency); typed narrowly here so
// the test does not depend on @types/bs58 existing.
const bs58 = require("bs58") as { encode(bytes: Uint8Array): string };

describe("web: crawl — every internal link returns 200 (Phase 5a)", function () {
  this.timeout(420_000);

  let server: DevServer;

  before(async () => {
    server = await startDevServer("crawl");
  });
  after(async () => {
    if (server !== undefined) await server.close();
  });

  it("crawls every page reachable from the known routes and none of them 404s", async () => {
    // A well-formed signature that is not on any chain: the route must render
    // its "not verified" report (200), never an exception page.
    const receiptSignature = bs58.encode(Buffer.alloc(64, 7));
    assert.isTrue(
      isTransactionSignature(receiptSignature),
      "the seed signature is well-formed (64 bytes base58)",
    );

    const queue = ["/", "/agreement/new", "/agent", "/verify", `/verify/${receiptSignature}`];
    const seen = new Set<string>();
    const broken: string[] = [];

    while (queue.length > 0) {
      const path = queue.shift() as string;
      if (seen.has(path)) continue;
      seen.add(path);

      const response = await fetch(server.origin + path, { redirect: "follow" });
      if (response.status !== 200) {
        broken.push(`${path} -> HTTP ${response.status}`);
        continue;
      }

      const html = await response.text();
      for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
        if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
          continue;
        }
        let target: string | null = null;
        if (href.startsWith("/")) target = href;
        else if (href.startsWith(server.origin)) target = href.slice(server.origin.length) || "/";
        if (target === null) continue; // external: out of scope
        const clean = target.split("#")[0];
        if (clean !== "" && !seen.has(clean)) queue.push(clean);
      }
    }

    assert.deepEqual(broken, [], `links that did not return 200:\n${broken.join("\n")}`);
    for (const seed of ["/", "/agreement/new", "/agent", "/verify"]) {
      assert.isTrue(seen.has(seed), `${seed} was crawled`);
    }
    assert.isAtLeast(seen.size, 6, "the crawl explored beyond the five seeds");
  });
});
