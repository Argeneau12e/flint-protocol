/**
 * The payer's screen, driven end to end in a real browser (Section 5a).
 *
 * The suites before this one proved the wallet machinery and the create form;
 * this one proves the screen someone actually opens from a shared link, against
 * the three claims `payment-request.tsx` makes about itself:
 *
 *   1. **The dialog is answered before anything is touched.** Clicking
 *      *Make payment* opens a confirmation; while it is open the wallet has
 *      been asked for nothing and not one transaction has been built, and
 *      cancelling leaves the request unchanged.
 *   2. **The loading states are real.** The mock's `hold-sign` mode withholds
 *      the signature, freezing the page in the *awaiting signature* stage —
 *      the one dependable moment to assert that the stage is on screen, the
 *      dialog is gone, the button is disabled, and no success is being
 *      claimed. Releasing the signature walks the page through sending and
 *      confirming on devnet.
 *   3. **Success comes from the chain, not the click.** The paid card appears
 *      only after devnet confirms, offers the receipt PNG and the explorer
 *      link, and is still there after a reload — because it renders from the
 *      agreement's status rather than from this tab's memory.
 *
 * The wallet is the shared mock from `mock-wallet.ts`: a real Wallet Standard
 * registration whose signatures are produced on the Node side, so no key
 * material ever reaches the page. The agreement is a real devnet account:
 * created through the same API the create page calls (the service wallet is
 * the recipient), with a fresh keypair funded in SOL and tokens as the payer.
 */

import { assert } from "chai";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import {
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
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

const WALLET_NAME = "Flint Payer Wallet";
/** The one agreement this suite pays for — created once, paid once, reloaded. */
const AMOUNT_DISPLAY = "20.0";

describe("web: payer flow — confirm dialog, signing stages, receipt (Section 5a)", function () {
  this.timeout(900_000);

  let server: DevServer;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  /** Fresh keypair playing the payer — the mock wallet's only identity. */
  let payer: Keypair;
  let agreementId: string;
  let recipientAddress: string;
  /** Console output from our own code; asserted empty by the last test. */
  let pageErrors: string[];
  /** How many transactions the page has asked our API to build. */
  let buildRequests: number;

  /**
   * The confirmation surface, whichever role it wears: Radix's AlertDialog
   * announces itself as `alertdialog`, and a switch back to a plain Dialog
   * should not silently break every locator in this suite.
   */
  function confirmDialog(target: Page) {
    return target.locator('[role="alertdialog"], [role="dialog"]');
  }

  /** How many times the page has asked the wallet for a signature. */
  async function signCalls(target: Page): Promise<number> {
    return await target.evaluate(() =>
      Number((globalThis as any).__flintSignCalls ?? 0)
    );
  }

  /** Starts a watch now, decides later — a stage can flash by in one frame. */
  function watchFor(target: Page, text: string): Promise<boolean> {
    return target
      .getByText(text)
      .first()
      .waitFor({ state: "attached", timeout: 240_000 })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Wait for a stage, and on timeout report what the page *did* say: a bare
   * timeout cannot tell "stuck awaiting signature" from "the endpoint refused"
   * from "the error line is showing", and those are exactly the differences
   * the stage machine exists to separate.
   */
  async function expectStage(
    shown: Promise<boolean>,
    label: string
  ): Promise<void> {
    if (await shown) return;
    const stages = await page
      .locator('[role="status"]')
      .allTextContents()
      .catch(() => []);
    const errors = await page
      .locator("p.flint-error-text")
      .allTextContents()
      .catch(() => []);
    throw new Error(
      `never saw ${label}. status lines: ${JSON.stringify(stages)}; ` +
        `error lines: ${JSON.stringify(errors)}; ` +
        `console: ${JSON.stringify(pageErrors.slice(-4))}`
    );
  }

  before(async () => {
    server = await startDevServer("payer");
    browser = await chromium.launch();

    const config = readConfig();
    const connection = getConnection();
    const service = loadKeypair(config.serviceKeypairPath, "service");

    // The payer: a fresh keypair, given SOL for fees and the tokens to pay with.
    payer = Keypair.generate();
    const sol = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: service.keypair.publicKey,
        toPubkey: payer.publicKey,
        lamports: Math.ceil(0.02 * LAMPORTS_PER_SOL),
      })
    );
    const solSignature = await connection.sendTransaction(sol, [
      service.keypair,
    ]);
    await connection.confirmTransaction(solSignature, "confirmed");

    const decimals = (await getMint(connection, config.assetMint)).decimals;
    assert.isAtLeast(decimals, 1, "the test mint has a fractional part");
    await getOrCreateAssociatedTokenAccount(
      connection,
      service.keypair,
      config.assetMint,
      payer.publicKey
    );
    const needed = BigInt(Math.round(1.5 * 10 ** decimals)); // the whole 1.5, exactly
    const mintSignature = await mintTo(
      connection,
      service.keypair,
      config.assetMint,
      getAssociatedTokenAddressSync(config.assetMint, payer.publicKey, true),
      service.keypair,
      needed
    );
    const mintLatest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction(
      { signature: mintSignature, ...mintLatest },
      "confirmed"
    );

    // The agreement, through the same API the create page calls. The service
    // wallet is the recipient — `create` is signed by the recipient alone
    // (Section 4.5) — and the uuid id means a rerun never collides.
    const createResponse = await fetch(`${server.origin}/api/agreements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipient: service.keypair.publicKey.toBase58(),
        title: "Landing page build, milestone 2",
        amount: AMOUNT_DISPLAY,
        memo: "Sign-off on the second milestone. Pay when you have seen it.",
        expiryMinutes: 60,
      }),
    });
    const createText = await createResponse.text();
    assert.equal(createResponse.status, 200, createText);
    const created = JSON.parse(createText) as {
      transaction: string;
      id: string;
      recipient: string;
    };
    const createTx = Transaction.from(
      Buffer.from(created.transaction, "base64")
    );
    createTx.partialSign(service.keypair);
    const createSignature = await connection.sendRawTransaction(
      createTx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      })
    );
    const createLatest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction(
      { signature: createSignature, ...createLatest },
      "confirmed"
    );
    agreementId = created.id;
    recipientAddress = created.recipient;
    buildRequests = 0;
    pageErrors = [];
  });

  after(async () => {
    if (browser !== undefined) await browser.close();
    if (server !== undefined) await server.close();
  });

  it("the confirm dialog is answered before the wallet or the build endpoint is touched", async () => {
    context = await browser.newContext();
    // Node-side signing for the mock: a real ed25519 signature from a keypair
    // that never exists inside the page.
    await context.exposeFunction("__flintSignTx", async (bytes: number[]) => {
      const transaction = Transaction.from(Buffer.from(bytes));
      transaction.partialSign(payer);
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
        address: payer.publicKey.toBase58(),
        pub: Array.from(payer.publicKey.toBytes()),
      },
    ] satisfies MockWalletSpec[]);
    page = await context.newPage();
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !message.text().includes("favicon.ico")
      ) {
        pageErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) =>
      pageErrors.push(`pageerror: ${error.message}`)
    );

    // Count what the page asks our API to build: the confirm action is the
    // only thing allowed to make this number move.
    await page.route("**/api/actions/**", async (route) => {
      buildRequests += 1;
      await route.continue();
    });

    await page.goto(
      `${server.origin}/agreement/${agreementId}?recipient=${recipientAddress}`,
      {
        waitUntil: "load",
        timeout: 60_000,
      }
    );

    // Detection is asynchronous: a click that beats it sees no wallet at all,
    // so wait until the connect button *names* the detected wallet.
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

    await page
      .getByRole("button", { name: "Make payment" })
      .waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Make payment" }).click();

    const dialog = confirmDialog(page);
    await dialog.waitFor({ timeout: 15_000 });
    const dialogText = (await dialog.textContent()) ?? "";
    assert.include(
      dialogText,
      "Your money goes into escrow",
      "the dialog states where the money goes"
    );
    assert.include(
      dialogText,
      AMOUNT_DISPLAY,
      "the dialog names the amount it asks for"
    );
    assert.include(
      dialogText,
      "comes back to you",
      "the dialog states the refund consequence"
    );

    assert.equal(
      await signCalls(page),
      0,
      "the wallet was not asked for anything while the dialog is open"
    );
    assert.equal(
      buildRequests,
      0,
      "no transaction was built while the dialog is open"
    );
    assert.equal(
      await page.getByText("Confirm in your wallet").count(),
      0,
      "no signing stage is announced before the dialog is answered"
    );

    // Cancelling leaves the request exactly as it was.
    await page.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached", timeout: 15_000 });
    assert.equal(
      await signCalls(page),
      0,
      "cancelling never reached the wallet"
    );
    assert.equal(
      await page.locator("p.flint-error-text").count(),
      0,
      "cancelling is not an error"
    );
    assert.isTrue(
      await page.getByRole("button", { name: "Make payment" }).isVisible(),
      "the request is unchanged after cancelling"
    );
  });

  it("holding the signature shows the loading stage; releasing it lands in the paid card", async () => {
    await page.evaluate(() => (globalThis as any).__flintMockMode("hold-sign"));

    // Watch before acting: each stage below can be on screen for a single
    // frame, so the verdicts are read afterwards, never awaited in sequence.
    const stages = {
      signing: watchFor(page, "Confirm in your wallet"),
      sending: watchFor(page, "Sending your payment to Solana"),
      confirming: watchFor(page, "Waiting for Solana devnet to confirm"),
    };

    await page.getByRole("button", { name: "Make payment" }).click();
    await confirmDialog(page).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Fund the escrow" }).click();

    // The signing window, with the signature withheld: the only dependable
    // moment to look at what the page says while the wallet is holding the
    // transaction — and the moment that proves it waits rather than assumes.
    await expectStage(stages.signing, "the awaiting-signature stage");
    await page.waitForFunction(
      () => Number((globalThis as any).__flintSignCalls ?? 0) >= 1,
      undefined,
      { timeout: 30_000 }
    );
    assert.equal(
      await signCalls(page),
      1,
      "exactly one wallet call, and only after the dialog was answered"
    );
    assert.isAtLeast(
      buildRequests,
      1,
      "the transaction was built only after the dialog was answered"
    );
    assert.equal(
      await confirmDialog(page).count(),
      0,
      "the dialog closed on confirm"
    );
    assert.equal(
      await page.getByText("Nothing has moved yet").count(),
      1,
      "the stage says the money has not moved"
    );
    assert.isTrue(
      await page.getByRole("button", { name: "Make payment" }).isDisabled(),
      "the pay button is disabled while the payment is in flight"
    );
    assert.equal(
      await page.getByText("held in escrow").count(),
      0,
      "no success is claimed while the signature is outstanding"
    );
    assert.equal(
      await page.getByRole("button", { name: "Download the receipt" }).count(),
      0,
      "no receipt is offered before the payment exists"
    );

    // Let the signature go: the rest of the state machine runs for real.
    await page.evaluate(() => (globalThis as any).__flintReleaseSign());
    await expectStage(stages.sending, "the submitting stage");
    await expectStage(stages.confirming, "the confirming stage");

    await page
      .getByText("held in escrow")
      .first()
      .waitFor({ timeout: 240_000 });
    await page.evaluate(() => (globalThis as any).__flintMockMode("ok"));

    assert.equal(
      await page.getByRole("button", { name: "Download the receipt" }).count(),
      1,
      "the paid card offers the receipt"
    );
    assert.isAtLeast(
      await page.locator('a[href*="explorer.solana.com/tx/"]').count(),
      1,
      "the paid card links the confirmed transaction"
    );
    assert.equal(
      await page.locator("p.flint-error-text").count(),
      0,
      "no error line after a clean payment"
    );
  });

  it("a reload shows the same paid card from chain, with technical details closed", async () => {
    await page.reload({ waitUntil: "load", timeout: 60_000 });
    await page
      .getByRole("button", { name: "Download the receipt" })
      .waitFor({ timeout: 60_000 });

    // Rendered from the agreement's status, not this tab's memory: nothing was
    // stored client-side between navigations except the signature itself.
    assert.isFalse(
      await page.getByText("Agreement account").first().isVisible(),
      "the technical disclosure stays closed until it is asked for"
    );

    await page.getByRole("button", { name: "Technical details" }).click();
    await page
      .getByText("Agreement account")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    const body = (await page.textContent("body")) ?? "";
    assert.include(
      body,
      recipientAddress,
      "the disclosure names the recipient address"
    );
    assert.include(body, "unix", "the raw expiry sits beside the human one");
  });

  it("the receipt downloads as a PNG file", async () => {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.getByRole("button", { name: "Download the receipt" }).click(),
    ]);
    assert.match(
      download.suggestedFilename(),
      /\.png$/,
      "the receipt is a PNG named after the agreement and its date"
    );
  });

  it("the whole flow ran with zero console errors from our own code", () => {
    assert.deepEqual(
      pageErrors,
      [],
      `console errors:\n${pageErrors.join("\n")}`
    );
  });
});

