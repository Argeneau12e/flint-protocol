/**
 * Provisions the devnet fixture the flows need, and writes app/.env.local plus
 * tests/.env.test (Phase 5a).
 *
 * Idempotent: re-running it tops up rather than recreating, so wallets keep their
 * history and their agreements stay valid.
 *
 * What it creates, and why each piece is needed:
 *   - a **service** keypair — the recipient. The x402 responder signs `create`
 *     with it (Section 4.5), so it needs SOL for rent on every proposal;
 *   - an **agent** keypair — the payer. It needs SOL for fees and rent, plus
 *     tokens to pay with;
 *   - a **test SPL mint** (TST, 6 decimals) minted by the service wallet, with a
 *     balance for the agent — pinned in `tests/.env.test` so the automated
 *     suites always spend the throwaway asset, never the demo one;
 *   - the **demo asset**: Circle's devnet USDC in `app/.env.local`. This script
 *     creates the token accounts (rent only) but can never mint USDC — Circle is
 *     the mint authority — so it reports any shortfall and points at Circle's
 *     faucet instead of pretending to fund it;
 *   - both env files with **absolute** paths, so the same values work whether the
 *     app runs from `app/` (Next.js) or the tests run from the repo root.
 *
 * SOL top-up needs the deployer keypair. Pass it explicitly:
 *   FLINT_DEPLOYER_KEYPAIR=\\wsl.localhost\Ubuntu\home\you\.config\solana\id.json \
 *     node scripts/provision-devnet.mjs
 * Without it the script still runs; it just reports unfunded wallets instead of
 * funding them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keysDir = resolve(repoRoot, "app", ".keys");
const envPath = resolve(repoRoot, "app", ".env.local");
const testEnvPath = resolve(repoRoot, "tests", ".env.test");
const RPC = "https://api.devnet.solana.com";
const MINT_DECIMALS = 6;
/** Circle's devnet USDC — the demo asset (confirmed on Circle's docs, 6 decimals). */
const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
/** Circle's public faucet page: devnet USDC, 20 per address per 2 hours. */
const USDC_FAUCET_URL = "https://developers.circle.com/wallets/developer-console-faucet";
/** Tokens for the agent: enough for many runs, all of them test tokens. */
const AGENT_TOKEN_GRANT = 1_000_000_000n; // 1000.000000 at 6 decimals
/** Below this a wallet cannot keep paying fees plus rent, so it gets topped up. */
const MIN_SOL_LAMPORTS = 1_000_000_000; // 1 SOL
/**
 * How much to add when topping up.
 *
 * Generous on purpose: the responder spends rent on *every* proposal, and a full
 * test run makes several. A wallet that runs dry mid-suite turns a protocol result
 * into a confusing infrastructure error, so the buffer is deliberately large.
 */
const TOP_UP_LAMPORTS = 2_000_000_000; // 2 SOL

/** Reads a `.env.local`-style file into a plain object. */
function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function writeEnvFile(path, entries) {
  writeFileSync(
    path,
    `${Object.entries(entries)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "utf8",
  );
}

function loadOrCreateKeypair(path, label) {
  if (existsSync(path)) {
    const keypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
    );
    console.log(`${label} keypair: ${keypair.publicKey.toBase58()} (existing)`);
    return keypair;
  }
  mkdirSync(dirname(path), { recursive: true });
  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), "utf8");
  console.log(`${label} keypair: ${keypair.publicKey.toBase58()} (created)`);
  return keypair;
}

async function topUpIfNeeded(connection, label, wallet, deployer) {
  const balance = await connection.getBalance(wallet.publicKey);
  if (balance >= MIN_SOL_LAMPORTS) {
    console.log(`  ${label}: ${(balance / 1e9).toFixed(3)} SOL — enough`);
    return;
  }
  if (deployer === null) {
    console.warn(
      `  ${label}: NEEDS SOL (${(balance / 1e9).toFixed(3)}). Re-run with ` +
        `FLINT_DEPLOYER_KEYPAIR set, or fund ${wallet.publicKey.toBase58()} from the faucet.`,
    );
    return;
  }
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: deployer.publicKey,
      toPubkey: wallet.publicKey,
      lamports: TOP_UP_LAMPORTS,
    }),
  );
  const signature = await connection.sendTransaction(transaction, [deployer]);
  await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
  const after = await connection.getBalance(wallet.publicKey);
  console.log(`  ${label}: topped up -> ${(after / 1e9).toFixed(3)} SOL (${signature})`);
}

async function main() {
  const env = { ...readEnvFile(envPath), ...process.env };
  const connection = new Connection(RPC, "confirmed");

  let deployer = null;
  if (env.FLINT_DEPLOYER_KEYPAIR) {
    deployer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(env.FLINT_DEPLOYER_KEYPAIR, "utf8"))),
    );
    console.log(`Deployer keypair: ${deployer.publicKey.toBase58()}`);
  } else {
    console.log("No FLINT_DEPLOYER_KEYPAIR set: unfunded wallets will not be topped up.");
  }

  console.log("\n1. Wallets");
  const service = loadOrCreateKeypair(resolve(keysDir, "service.json"), "service (recipient)");
  const agent = loadOrCreateKeypair(resolve(keysDir, "agent.json"), "agent   (payer)   ");
  await topUpIfNeeded(connection, "service", service, deployer);
  await topUpIfNeeded(connection, "agent  ", agent, deployer);

  // ---- the *test* mint (automated suites only; TST stays out of the demo) ----
  console.log("\n2. Test mint (automated tests only)");
  const testEnv = readEnvFile(testEnvPath);
  let testMint;
  if (testEnv.FLINT_ASSET_MINT) {
    testMint = new PublicKey(testEnv.FLINT_ASSET_MINT);
    console.log(`Pinned in tests/.env.test: ${testMint.toBase58()}`);
  } else if (env.FLINT_ASSET_MINT && env.FLINT_ASSET_MINT !== USDC_DEVNET_MINT) {
    // A legacy .env.local pointed at an older throwaway mint: adopt it rather
    // than minting a second test asset.
    testMint = new PublicKey(env.FLINT_ASSET_MINT);
    console.log(`Adopted from the existing .env.local: ${testMint.toBase58()}`);
  } else {
    testMint = await createMint(connection, service, service.publicKey, null, MINT_DECIMALS);
    console.log(`Created devnet test mint: ${testMint.toBase58()} (${MINT_DECIMALS} decimals)`);
  }

  console.log("\n3. Test token accounts (the agent's TST balance)");
  const agentAta = await getOrCreateAssociatedTokenAccount(
    connection,
    agent,
    testMint,
    agent.publicKey,
  );
  const held = (await getAccount(connection, agentAta.address)).amount;
  if (held < AGENT_TOKEN_GRANT) {
    // The service wallet holds the mint authority, so it can top the agent up
    // without any third party being involved.
    await mintTo(connection, service, testMint, agentAta.address, service, AGENT_TOKEN_GRANT);
    console.log(`  minted ${AGENT_TOKEN_GRANT} base units to the agent`);
  } else {
    console.log(`  agent already holds ${held} base units`);
  }
  // The recipient side of a *test*-mint agreement: `release` pays out to the
  // service wallet's TST account, so it has to exist before any suite settles.
  const serviceAta = await getOrCreateAssociatedTokenAccount(
    connection,
    service,
    testMint,
    service.publicKey,
  );
  console.log(`  agent   ATA: ${agentAta.address.toBase58()}`);
  console.log(`  service ATA: ${serviceAta.address.toBase58()}`);

  // ---- the demo asset: Circle's devnet USDC --------------------------------
  // This script can create token accounts but can never mint USDC — Circle is
  // the only mint authority. So it creates both demo accounts (rent only) and
  // reports the agent's balance against what the demos will spend, pointing at
  // Circle's faucet for any shortfall rather than pretending to fund it.
  console.log("\n4. Demo asset (Circle devnet USDC)");
  const demoMint = process.env.FLINT_ASSET_MINT ?? USDC_DEVNET_MINT;
  const demoSymbol =
    process.env.FLINT_ASSET_SYMBOL ?? (demoMint === USDC_DEVNET_MINT ? "USDC" : "TST");
  console.log(`  mint: ${demoMint} (${demoSymbol})`);
  const demoMintKey = new PublicKey(demoMint);
  const agentDemoAta = await getOrCreateAssociatedTokenAccount(
    connection,
    service,
    demoMintKey,
    agent.publicKey,
  );
  const serviceDemoAta = await getOrCreateAssociatedTokenAccount(
    connection,
    service,
    demoMintKey,
    service.publicKey,
  );
  const demoHeld = (await getAccount(connection, agentDemoAta.address)).amount;
  const price = BigInt(env.FLINT_PRICE_BASE_UNITS ?? "1000000");
  const demoWhole = demoHeld / 10n ** BigInt(MINT_DECIMALS);
  console.log(`  agent demo balance: ${demoHeld} base units (${demoWhole} ${demoSymbol})`);
  if (demoHeld < price * 10n) {
    console.log(`  SHORTFALL — fund the agent from Circle's faucet: ${USDC_FAUCET_URL}`);
    console.log(`    address: ${agent.publicKey.toBase58()} (20 USDC per address per 2 hours)`);
  }
  console.log(`  agent   demo ATA: ${agentDemoAta.address.toBase58()}`);
  console.log(`  service demo ATA: ${serviceDemoAta.address.toBase58()}`);

  console.log("\n5. app/.env.local and tests/.env.test");
  // Start from the *file*, never from `process.env`: spreading the whole
  // process environment here is what once turned .env.local into a 69-line
  // shell dump with unrelated secrets in it (Phase 5a).
  const fileEnv = readEnvFile(envPath);
  const entries = {
    ...fileEnv,
    FLINT_PROGRAM_ID: fileEnv.FLINT_PROGRAM_ID ?? "ziZiaCVcDaenoUP7jHdEPk4R2XJ8zeY5UbMPKFuqZxE",
    FLINT_SERVICE_KEYPAIR: resolve(keysDir, "service.json"),
    FLINT_AGENT_KEYPAIR: resolve(keysDir, "agent.json"),
    FLINT_ASSET_MINT: demoMint,
    FLINT_ASSET_SYMBOL: demoSymbol,
    FLINT_PRICE_BASE_UNITS:
      fileEnv.FLINT_PRICE_BASE_UNITS ?? env.FLINT_PRICE_BASE_UNITS ?? "1000000",
    FLINT_AGREEMENT_TTL_SECONDS:
      fileEnv.FLINT_AGREEMENT_TTL_SECONDS ?? env.FLINT_AGREEMENT_TTL_SECONDS ?? "900",
    FLINT_DECISION_LOG:
      fileEnv.FLINT_DECISION_LOG ?? resolve(repoRoot, "app", ".data", "decisions.jsonl"),
  };
  // The deployer path is a machine-local secret location, not app configuration.
  delete entries.FLINT_DEPLOYER_KEYPAIR;
  writeEnvFile(envPath, entries);
  console.log(`  wrote ${envPath} (demo asset: ${demoSymbol} ${demoMint})`);

  writeEnvFile(testEnvPath, {
    FLINT_ASSET_MINT: testMint.toBase58(),
    FLINT_ASSET_SYMBOL: "TST",
  });
  console.log(`  wrote ${testEnvPath} (test asset: TST ${testMint.toBase58()})`);
  console.log(
    "\nDone. Run the app with `npm run dev` in app/, or the tests with `npm run test:agent`." +
      "\nDemo payer wallets still need USDC from Circle's faucet (section 4 above).",
  );
}

main().catch((error) => {
  console.error("Provisioning failed:", error.message);
  process.exit(1);
});
