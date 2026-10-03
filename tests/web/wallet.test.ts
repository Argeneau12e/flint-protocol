/**
 * Real-browser wallet proof (Phase 5a, item 1).
 *
 * The suites before this one drove the code with keypairs and direct URLs, so
 * they could not see the bug a human hit: "Connect wallet" produced a banner
 * with nothing after the colon. Phantom cannot be driven from here either —
 * so this registers a **mock Wallet Standard wallet** in the page before any
 * application script runs, using the exact `wallet-standard:register-wallet` /
 * `wallet-standard:app-ready` handshake the real `@wallet-standard/wallet`
 * package uses, and then proves each acceptance criterion against the real
 * app, the real wallet-adapter, and real devnet:
 *
 *   1. detection (no Phantom assumed), connect, and the address on screen;
 *   2. disconnect back to the connect button;
 *   3. a declined connect → a *specific* message, plus the full error logged;
 *   4. an **empty-message** wallet error → a non-empty banner (the exact bug);
 *   5. a locked wallet → a locked-specific message;
 *   6. sign: a real create transaction, signed through the mock, confirmed on
 *      devnet, with the success state and explorer link;
 *   7. several wallets installed → a picker, never an assumed wallet;
 *   8. no wallet installed → the not-installed message.
 *
 * The mock never holds secret key material: it forwards `signTransaction` to a
 * Playwright binding (`__flintSignTx`), which signs with a real keypair on the
 * Node side — so the signature the app submits is a genuine ed25519 signature.
 */

import { assert } from "chai";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { loadKeypair } from "../../app/lib/keys";
import { readConfig } from "../../app/lib/config";
import { getConnection } from "../../app/lib/solana";
import { startDevServer, type DevServer } from "./dev-server";
import { initMockWallets, type MockWalletSpec } from "./mock-wallet";

const CREATE_PAGE = "/agreement/new";
const WALLET_NAME = "Flint Test Wallet";
const SECOND_WALLET_NAME = "Flint Second Wallet";

describe("web: wallet connect in a real browser (Phase 5a)", function () {
  this.timeout(600_000);

  let server: DevServer;
  let browser: Browser;

  /** The mock's real signing keypair — funded once, used by the sign test. */
  let signer: Keypair;

  /** Shared first-context state, walked by the ordered tests below. */
  let context: BrowserContext;
  let page: Page;
  let walletFailureLogs: string[];

  /** The current `role="alert"` banner text, or null when there is none. */
  async function bannerText(target: Page): Promise<string | null> {
    const alert = target.locator('p[role="alert"]');
    if ((await alert.count()) === 0) return null;
    return (await alert.first().textContent()) ?? null;
  }

  /** The banner's message with the "Wallet problem:" prefix removed. */
  function detailOf(banner: string | null): string {
    assert.isString(banner, "a banner is on screen");
    return (banner as string).replace("Wallet problem:", "").trim();
  }

  /**
   * Start watching for a phrase now, find out later whether it ever appeared.
   *
   * `waitFor` answers "is it there *now*", which is the wrong question for a
   * transient status line — the answer has to be "did it appear at any point
   * between then and now", so the wait is issued before the action and left
   * running. `attached` rather than `visible` because a line React adds and
   * removes inside one task is still a line the app showed, and this never
   * rejects: a stage that never appeared is an assertion failure, not an
   * unhandled rejection.
   */
  function watchFor(page: Page, text: string): Promise<boolean> {
    return page
      .getByText(text)
      .first()
      .waitFor({ state: "attached", timeout: 240_000 })
      .then(() => true)
      .catch((error: unknown) => {
        // A watch that misses while a later identical waitFor succeeds can only
        // have errored out early (a destroyed context, a closed target) — so a
        // miss reports why instead of collapsing to a bare false, which is the
        // difference between "the app never said it" and "the browser broke the
        // question".
        console.log(
          `watchFor missed "${text}": ${
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error)
          }`
        );
        return false;
      });
  }

  /** Whether the "it exists on chain now" panel — heading and all — is on screen. */
  function createdPanelShown(page: Page): Promise<boolean> {
    return page
      .getByRole("heading", { name: "The agreement is on chain" })
      .first()
      .isVisible();
  }

  /**
   * Wait for the success text, and on timeout report what the page *did* say.
   *
   * A bare `waitFor` timeout cannot distinguish "stuck awaiting signature" from
   * "sent but never confirmed" from "raised an alert" — and those three stages
   * are precisely what the state machine exists to separate. So the failure
   * carries the live feedback region, the alert banner, and the wallet logs.
   */
  async function expectText(
    page: Page,
    text: string,
    timeout: number
  ): Promise<void> {
    try {
      await page.getByText(text).first().waitFor({ timeout });
    } catch (cause) {
      const feedback = await page
        .locator(".flint-feedback")
        .first()
        .textContent()
        .catch(() => "<none>");
      const alert = await bannerText(page);
      throw new Error(
        `timed out after ${timeout}ms waiting for "${text}". ` +
          `feedback region said ${JSON.stringify(
            feedback
          )}; alert banner ${JSON.stringify(alert)}; ` +
          `last wallet logs ${JSON.stringify(
            (walletFailureLogs ?? []).slice(-4)
          )}`,
        { cause }
      );
    }
  }

  before(async () => {
    server = await startDevServer("wallet");
    browser = await chromium.launch();

    // The sign test creates a real agreement: the mock's address is the
    // recipient, so it pays the rent. The service wallet funds it — the same
    // pattern the human-flow suite uses for its fresh keypairs.
    signer = Keypair.generate();
    const config = readConfig();
    const connection = getConnection();
    const service = loadKeypair(config.serviceKeypairPath, "service");
    const funding = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: service.keypair.publicKey,
        toPubkey: signer.publicKey,
        lamports: Math.ceil(0.02 * LAMPORTS_PER_SOL),
      })
    );
    const signature = await connection.sendTransaction(funding, [
      service.keypair,
    ]);
    await connection.confirmTransaction(signature, "confirmed");
  });

  after(async () => {
    if (browser !== undefined) await browser.close();
    if (server !== undefined) await server.close();
  });

  it("detects the Wallet Standard wallet (no Phantom assumed), connects, shows the address", async () => {
    context = await browser.newContext();
    // Node-side signing for the mock: real ed25519 signatures, no key material
    // ever exposed to the page.
    await context.exposeFunction("__flintSignTx", async (bytes: number[]) => {
      const transaction = Transaction.from(Buffer.from(bytes));
      transaction.partialSign(signer);
      return Array.from(
        transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        })
      );
    });
    await context.addInitScript(initMockWallets, [
      {
        name: WALLET_NAME,
        address: signer.publicKey.toBase58(),
        pub: Array.from(signer.publicKey.toBytes()),
      },
    ] satisfies MockWalletSpec[]);

    page = await context.newPage();
    walletFailureLogs = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        message.text().includes("[flint] wallet failure")
      ) {
        walletFailureLogs.push(message.text());
      }
    });

    await page.goto(server.origin + CREATE_PAGE, {
      waitUntil: "load",
      timeout: 60_000,
    });

    // Detection has happened when the connect button names the detected wallet
    // — proof the list came from Wallet Standard, not a hardcoded adapter.
    await page.waitForFunction(
      (name) =>
        Array.from(document.querySelectorAll("button")).some((button) =>
          (button.textContent ?? "").includes(name)
        ),
      WALLET_NAME,
      { timeout: 30_000 }
    );
    await page
      .getByRole("button", {
        name: new RegExp(`Connect wallet \\(${WALLET_NAME}\\)`),
      })
      .click();
    await page
      .getByText("Connected:", { exact: false })
      .first()
      .waitFor({ timeout: 30_000 });

    const address = signer.publicKey.toBase58();
    const body = (await page.textContent("body")) ?? "";
    assert.include(
      body,
      `${address.slice(0, 4)}…${address.slice(-4)}`,
      "the address is shown"
    );
    assert.isNull(
      await bannerText(page),
      "no wallet-problem banner after a clean connect"
    );
    assert.deepEqual(
      walletFailureLogs,
      [],
      "nothing was logged as a wallet failure"
    );
  });

  it("disconnects back to the connect button", async () => {
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page
      .getByRole("button", {
        name: new RegExp(`Connect wallet \\(${WALLET_NAME}\\)`),
      })
      .waitFor({ timeout: 30_000 });
    assert.isNull(await bannerText(page), "disconnecting is not an error");
  });

  it("a declined connect gets the specific 'declined' message and a full console log", async () => {
    await page.evaluate(() => (globalThis as any).__flintMockMode("reject"));
    await page
      .getByRole("button", {
        name: new RegExp(`Connect wallet \\(${WALLET_NAME}\\)`),
      })
      .click();
    await page.waitForFunction(
      () =>
        (
          (document.querySelector('p[role="alert"]')?.textContent ??
            "") as string
        ).includes("declined the request in your wallet"),
      undefined,
      { timeout: 15_000 }
    );
    const banner = await bannerText(page);
    assert.include(
      detailOf(banner),
      "declined the request in your wallet",
      "specific message"
    );
    assert.isAtLeast(
      walletFailureLogs.length,
      1,
      "the full error reached the console"
    );
    assert.include(walletFailureLogs.join("\n"), "[flint] wallet failure");
    await page.evaluate(() => (globalThis as any).__flintMockMode("ok"));
  });

  it("an empty-message wallet error still produces a non-empty, name-based message (the 5a bug)", async () => {
    await page.evaluate(() =>
      (globalThis as any).__flintMockMode("reject-empty")
    );
    await page
      .getByRole("button", {
        name: new RegExp(`Connect wallet \\(${WALLET_NAME}\\)`),
      })
      .click();
    await page.waitForFunction(
      () =>
        (
          (document.querySelector('p[role="alert"]')?.textContent ??
            "") as string
        ).includes("no message"),
      undefined,
      { timeout: 15_000 }
    );
    const detail = detailOf(await bannerText(page));
    assert.isAbove(
      detail.length,
      0,
      "the message after 'Wallet problem:' is not empty"
    );
    assert.include(
      detail,
      "no message",
      "the empty message is called out, not passed through"
    );
    assert.match(
      detail,
      /\((?:Wallet|Solana|Error)[^)]*\)|console/,
      "it falls back to the error's name (or the documented generic sentence)"
    );
    assert.isAtLeast(
      walletFailureLogs.length,
      1,
      "the full error reached the console"
    );
    await page.evaluate(() => (globalThis as any).__flintMockMode("ok"));
  });

  it("a locked wallet gets the locked-specific message", async () => {
    await page.evaluate(() => (globalThis as any).__flintMockMode("locked"));
    await page
      .getByRole("button", {
        name: new RegExp(`Connect wallet \\(${WALLET_NAME}\\)`),
      })
      .click();
    await page.waitForFunction(
      () =>
        (
          (document.querySelector('p[role="alert"]')?.textContent ??
            "") as string
        )
          .toLowerCase()
          .includes("locked"),
      undefined,
      { timeout: 15_000 }
    );
    const detail = detailOf(await bannerText(page));
    assert.include(detail.toLowerCase(), "locked", "the locked case says so");
    await page.evaluate(() => (globalThis as any).__flintMockMode("ok"));
  });

  it("signs a real create transaction through the mock wallet and confirms on devnet", async () => {
    await page
      .getByRole("button", {
        name: new RegExp(`Connect wallet \\(${WALLET_NAME}\\)`),
      })
      .click();
    await page
      .getByText("Connected:", { exact: false })
      .first()
      .waitFor({ timeout: 30_000 });

    /*
     * Start watching for each *transient* stage sentence *before* the click, and
     * read the verdicts afterwards.
     *
     * A stage sentence can be on screen for a single frame: `useTransactionAction`
     * steps awaiting signature → submitting → confirming with nothing but an await
     * between the states, so a test that awaits them one after another is always
     * looking for the wrong one — by the time it asks for "sending", that node is
     * already gone, and the failure reads as if the app never announced anything.
     * Watching concurrently and deciding later is the only way to see those two,
     * and seeing them is the point: it is what distinguishes an app that waited
     * for the chain from one that assumed the outcome (Section 9).
     *
     * The awaiting-signature stage is deliberately *not* watched. The wallet is
     * holding the signature, so that sentence cannot progress or disappear before
     * the release — the plain `waitFor` below proves it deterministically, and a
     * watch there would only add a window that unrelated slowness could expire.
     */
    const announced = {
      sending: watchFor(page, "Sending the transaction to Solana"),
      confirming: watchFor(page, "Waiting for Solana devnet to confirm"),
    };

    await page.evaluate(() => (globalThis as any).__flintMockMode("hold-sign"));
    await page.fill("#title", "Browser wallet sign test");
    await page.fill("#amount", "1");
    await page.click('button[type="submit"]');

    /*
     * The wallet now holds the signature hostage, which is the moment worth
     * testing at: everything the page says while the signature is outstanding has
     * to be about waiting, because nothing has been signed, sent or confirmed.
     * Without the hold this assertion would be a race the test happens to win.
     */
    await page
      .getByText("Approve the request in your wallet")
      .first()
      .waitFor({ timeout: 60_000 });
    await page.waitForFunction(
      () => typeof (globalThis as any).__flintReleaseSign === "function",
      undefined,
      { timeout: 30_000 }
    );
    assert.isFalse(
      await createdPanelShown(page),
      "the page claimed the agreement was on chain while the signature was still outstanding"
    );

    await page.evaluate(() => (globalThis as any).__flintReleaseSign());

    assert.isTrue(
      await announced.sending,
      "the app said it was sending the transaction once the signature arrived"
    );
    assert.isTrue(
      await announced.confirming,
      "the app waited for devnet to confirm the transaction instead of announcing success early"
    );

    // The created panel is this flow's success state: it renders from `onSuccess`,
    // which runs only once `confirmTransaction` has resolved. Reaching it *is* the
    // confirmation — and the hold above is what makes "only after confirmation"
    // mean something rather than being a timing accident.
    await expectText(page, "The agreement is on chain", 180_000);

    const body = (await page.textContent("body")) ?? "";
    assert.match(
      body,
      /Transaction\s+[1-9A-HJ-NP-Za-km-z]{32,}/,
      "the panel names the real signature it confirmed"
    );
    assert.isAtLeast(
      await page.locator('a[href*="explorer.solana.com/tx/"]').count(),
      1,
      "the success state links the confirmed signature"
    );
    assert.isNull(
      await bannerText(page),
      "a successful sign never raises the wallet banner"
    );
    await page.evaluate(() => (globalThis as any).__flintMockMode("ok"));
  });

  it("several wallets installed → a picker with both, and the chosen one connects", async () => {
    const second = Keypair.generate();
    const secondContext = await browser.newContext();
    await secondContext.addInitScript(initMockWallets, [
      {
        name: WALLET_NAME,
        address: signer.publicKey.toBase58(),
        pub: Array.from(signer.publicKey.toBytes()),
      },
      {
        name: SECOND_WALLET_NAME,
        address: second.publicKey.toBase58(),
        pub: Array.from(second.publicKey.toBytes()),
      },
    ] satisfies MockWalletSpec[]);
    const secondPage = await secondContext.newPage();
    try {
      await secondPage.goto(server.origin + CREATE_PAGE, {
        waitUntil: "load",
        timeout: 60_000,
      });
      // Detection is asynchronous: a click that beats it sees the no-wallet
      // message, so retry until the picker (rather than a guess) appears.
      let pickerShown = false;
      for (let attempt = 0; attempt < 6 && !pickerShown; attempt++) {
        await secondPage.waitForTimeout(1_000);
        await secondPage
          .getByRole("button", { name: /^Connect wallet$/ })
          .click();
        pickerShown = await secondPage
          .getByRole("button", { name: SECOND_WALLET_NAME })
          .isVisible()
          .catch(() => false);
      }
      assert.isTrue(pickerShown, "the picker lists the second wallet");
      await secondPage
        .getByRole("button", { name: WALLET_NAME })
        .waitFor({ timeout: 10_000 });
      // Choosing the *second* wallet proves neither name was assumed.
      await secondPage
        .getByRole("button", { name: SECOND_WALLET_NAME })
        .click();
      await secondPage
        .getByText("Connected:", { exact: false })
        .first()
        .waitFor({ timeout: 30_000 });
      const body = (await secondPage.textContent("body")) ?? "";
      const address = second.publicKey.toBase58();
      assert.include(body, `${address.slice(0, 4)}…${address.slice(-4)}`);
    } finally {
      await secondContext.close();
    }
  });

  it("no wallet installed → the specific not-installed message, never an empty banner", async () => {
    const bareContext = await browser.newContext();
    const barePage = await bareContext.newPage();
    try {
      await barePage.goto(server.origin + CREATE_PAGE, {
        waitUntil: "load",
        timeout: 60_000,
      });
      await barePage
        .getByRole("button", { name: "Connect wallet" })
        .first()
        .click();
      await barePage.waitForFunction(
        () =>
          (
            (document.querySelector('p[role="alert"]')?.textContent ??
              "") as string
          ).includes("No Solana wallet is available"),
        undefined,
        { timeout: 15_000 }
      );
      const detail = detailOf(await bannerText(barePage));
      assert.isAbove(
        detail.length,
        0,
        "the message after the colon is not empty"
      );
      assert.include(detail, "No Solana wallet is available in this browser");
      assert.include(detail, "Install Phantom", "it says what to do about it");
    } finally {
      await bareContext.close();
    }
  });
});
