/**
 * The mock Wallet Standard wallet, shared by the browser suites.
 *
 * Extracted from `wallet.test.ts` so the payer-flow suite can register the
 * same wallet without importing a test file — which would drag that suite's
 * `describe` blocks along with it. Everything here is injected into the page
 * before any application script runs, using the exact
 * `wallet-standard:register-wallet` / `wallet-standard:app-ready` handshake
 * the real `@wallet-standard/wallet` package uses, with a `mode` switch for
 * the failure cases and a `signTransaction` that forwards serialized
 * transactions to a Playwright binding (`__flintSignTx`), which signs with a
 * real keypair on the Node side.
 *
 * `__flintSignCalls` counts every wallet call the page has made — the
 * payer-flow suite reads it to prove nothing touched the wallet before the
 * confirm dialog was answered.
 */

/** What the init script receives: names, addresses, and public key bytes. */
export interface MockWalletSpec {
  name: string;
  address: string;
  pub: number[];
}

/**
 * Injected before any page script. Registers `specs` as Wallet Standard
 * wallets (mirroring `registerWallet` from `@wallet-standard/wallet`), with a
 * `mode` switch for the failure cases, and a `signTransaction` that forwards
 * serialized transactions to the Node-side binding. `globalThis` rather than
 * `window`: the browser's `globalThis` *is* the window, and this file also has
 * to typecheck in a Node lib.
 */
export function initMockWallets(specs: MockWalletSpec[]): void {
  const g = globalThis as unknown as Record<string, any>;
  let mode = "ok";
  g.__flintMockMode = (next: string) => {
    mode = next;
  };

  const icon =
    "data:image/svg+xml;base64," +
    btoa(
      "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>" +
        "<rect width='64' height='64' rx='14' fill='#111827'/>" +
        "<path d='M18 44 L46 18 L46 46 Z' fill='#fbbf24'/></svg>"
    );
  const CHAINS = ["solana:devnet", "solana:testnet", "solana:mainnet"];

  const wallets = specs.map((spec) => {
    const account = {
      address: spec.address,
      publicKey: new Uint8Array(spec.pub),
      label: spec.name,
      chains: CHAINS,
      features: ["solana:signTransaction"],
    };
    const listeners: Array<(event: unknown) => void> = [];
    const emit = (properties: Record<string, boolean>) => {
      // The `change` callback receives the *names of the properties that changed*,
      // not a snapshot — `StandardWalletAdapter` registers its handler directly as
      // this callback and then re-reads `wallet.accounts` itself. Sending a
      // `{ accounts: [...] }` snapshot instead makes the adapter read an empty
      // `wallet.accounts` and treat it as a spontaneous disconnect.
      for (const listener of [...listeners]) {
        try {
          listener(properties);
        } catch {
          // A misbehaving app listener must not break the mock.
        }
      }
    };
    const connect = async () => {
      if (mode === "reject") throw new Error("User rejected the request.");
      if (mode === "reject-empty") throw new Error("");
      if (mode === "locked") {
        const error = new Error("Unlock your wallet first.");
        error.name = "WalletLockedError";
        throw error;
      }
      // The adapter reads `wallet.accounts` itself once `connect` resolves; the
      // return value is advisory. Not mutating the wallet here was what made
      // every connect throw `WalletAccountError` — whose message is empty, i.e.
      // exactly the blank banner this phase is about.
      wallet.accounts = [account];
      emit({ accounts: true });
      return { accounts: wallet.accounts };
    };
    const disconnect = async () => {
      wallet.accounts = [];
      emit({ accounts: true });
      return {};
    };
    const features: Record<string, unknown> = {
      "standard:events": {
        on: (event: string, callback: (event: unknown) => void) => {
          if (event === "change") listeners.push(callback);
          return () => {
            const index = listeners.indexOf(callback);
            if (index >= 0) listeners.splice(index, 1);
          };
        },
      },
      "standard:connect": { connect },
      "solana:connect": { connect },
      "standard:disconnect": { disconnect },
      "solana:disconnect": { disconnect },
      "solana:signTransaction": {
        signTransaction: async (input: { transaction: Uint8Array }) => {
          g.__flintSignCalls = (g.__flintSignCalls ?? 0) + 1;
          if (mode === "reject-sign") throw new Error("");
          if (mode === "hold-sign") {
            // Hand the test the trigger, then wait for it: this is the window in
            // which the app is waiting on a signature that does not exist yet —
            // the only dependable moment to ask whether the page has already
            // started claiming the agreement is on chain.
            await new Promise<void>((resolve) => {
              g.__flintReleaseSign = resolve;
            });
          }
          const signed = await g.__flintSignTx(Array.from(input.transaction));
          // An array, not a bare object. `solana:signTransaction` resolves to a
          // list of outputs, and `StandardWalletAdapter` reads
          // `signedTransactions[0].signedTransaction` — returning the object
          // directly makes index 0 undefined, so the failure surfaces as a
          // TypeError about 'signedTransaction' rather than anything that looks
          // like a wallet-shaped answer. Real wallets always return a list.
          return [{ signedTransaction: new Uint8Array(signed) }];
        },
        // Load-bearing, and easy to forget: `StandardWalletAdapter`'s constructor
        // reads this field unconditionally and passes it to `arraysEqual`, which
        // dereferences `.length` on it. A mock that omits it throws *inside React's
        // render*, unmounting the whole provider tree — which looks nothing like a
        // mock defect and everything like "the app detects no wallet at all".
        // Real wallets (Phantom included) always declare it.
        supportedTransactionVersions: ["legacy", "v0"],
      },
    };
    const wallet = {
      version: "1.0.0",
      name: spec.name,
      icon,
      chains: CHAINS,
      // Mutable, because the wallet object is itself the source of truth: the
      // adapter reads `wallet.accounts[0]` after connect, and again on every
      // change event. A fresh array each time is what a real wallet does.
      accounts: [] as (typeof account)[],
      features,
    };
    return wallet;
  });

  // The handshake, exactly as registerWallet() implements it: dispatch now for
  // an app already listening, and listen for app-ready in case it loads later.
  const callback = (api: { register: (wallet: unknown) => void }) => {
    for (const wallet of wallets) {
      try {
        api.register(wallet);
      } catch (error) {
        console.error("mock wallet registration failed", error);
      }
    }
  };
  try {
    g.dispatchEvent(
      new CustomEvent("wallet-standard:register-wallet", { detail: callback })
    );
  } catch (error) {
    console.error("mock register-wallet dispatch failed", error);
  }
  try {
    g.addEventListener(
      "wallet-standard:app-ready",
      (event: { detail: unknown }) =>
        callback(event.detail as { register: (wallet: unknown) => void })
    );
  } catch (error) {
    console.error("mock app-ready listener failed", error);
  }
}
