/**
 * The browser smoke test (Phase 5a, item 5): the four entry pages must render
 * in a real browser with zero console errors originating from our own code.
 *
 * Suite-level tests drive handlers with keypairs and direct URLs; they cannot
 * see what a page does in a browser — hydration faults, client exceptions,
 * failed imports. Any `console.error` or uncaught page error fails the test
 * for the page it happened on. The one allowlisted line is a `favicon.ico`
 * probe: browsers request it regardless of the declared icon, and it says
 * nothing about our code.
 */

import { assert } from "chai";
import { chromium, type Browser } from "playwright";
import { startDevServer, type DevServer } from "./dev-server";

const ENTRY_PAGES = ["/", "/agreement/new", "/agent", "/verify"] as const;

function isOurError(text: string): boolean {
  if (text.includes("favicon.ico")) return false;
  return true;
}

describe("web: browser smoke — entry pages render clean (Phase 5a)", function () {
  this.timeout(420_000);

  let server: DevServer;
  let browser: Browser;

  before(async () => {
    server = await startDevServer("smoke");
    browser = await chromium.launch();
  });
  after(async () => {
    if (browser !== undefined) await browser.close();
    if (server !== undefined) await server.close();
  });

  for (const path of ENTRY_PAGES) {
    it(`${path} loads (200, has an h1) with no console errors from our code`, async () => {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      try {
        const response = await page.goto(server.origin + path, {
          waitUntil: "load",
          timeout: 60_000,
        });
        assert.isNotNull(response, `${path} navigated`);
        assert.equal(response?.status(), 200, `${path} responded 200`);
        await page.waitForSelector("h1", { timeout: 30_000 });
        // A beat for async client effects (wallet detection, hydration) to fail
        // loudly if they are going to — a race-free-ish settle window.
        await page.waitForTimeout(2_000);
        const own = errors.filter(isOurError);
        assert.deepEqual(own, [], `${path} console errors:\n${own.join("\n")}`);
      } finally {
        await page.close();
      }
    });
  }
});
