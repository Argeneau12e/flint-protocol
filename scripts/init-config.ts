/**
 * Initialises the protocol's global Config account on devnet.
 *
 * Run once after the escrow program is deployed, signed by the **upgrade
 * authority** — the program itself accepts nobody else, and the account can only
 * be initialised once, so this is genuinely a one-time step.
 *
 *   node --loader ts-node/esm scripts/init-config.ts \
 *     --treasury <TREASURY_PUBKEY> --arbiter <ARBITER_PUBKEY>
 *
 * Defaults: treasury and arbiter come from the environment
 * (NEXT_PUBLIC_TREASURY / NEXT_PUBLIC_ARBITER), the arbiter timeout from
 * `--arbiter-timeout` (default 72h in seconds) and the minimum agreement from
 * `--min-agreement` (default 20 whole tokens).
 *
 * The upgrade authority's keypair is read from `ANCHOR_WALLET` exactly as
 * `anchor deploy` reads it, so this script and the deploy that preceded it agree
 * on who "the upgrade authority" is. That key is never written anywhere by this
 * script: it is read, used to sign one transaction, and discarded.
 */
import { readFileSync } from "node:fs";
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";

const IDL_PATH = "target/idl/flint_escrow.json";
const CONFIG_SEED = Buffer.from("config");
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
/**
 * The upgradeable loader. `init_config` requires the signer to be this program's
 * upgrade authority, so the script has to resolve the ProgramData account itself
 * and pass it — the program will not look it up from a trusted source on the
 * caller's behalf.
 */
const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

/**
 * Serialized discriminant of `UpgradeableLoaderState::ProgramData`.
 *
 * The enum declares `Uninitialized`, `Buffer`, `Program`, `ProgramData`, and
 * Borsh writes the variant index, so ProgramData is **3**. Solana Foundation's
 * IDL tooling hardcodes the same value. Getting this wrong makes every real
 * ProgramData account look like something else, which is why it is named here
 * rather than inlined at the comparison.
 */
const PROGRAM_DATA_DISCRIMINANT = 3;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(label: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${label} is required: pass --${label.toLowerCase()} or set it in the environment.`,
    );
  }
  return value;
}

/** The keypair `anchor deploy` would use, so the signer matches the authority. */
function upgradeAuthorityKeypair(): Keypair {
  const configured = process.env.ANCHOR_WALLET;
  if (configured === undefined) {
    throw new Error(
      "ANCHOR_WALLET is not set. Point it at the upgrade authority keypair, or " +
        "run with ANCHOR_WALLET set the way your deploy used it.",
    );
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(configured, "utf8"))),
  );
}

/**
 * The authority a ProgramData account names, or `null` when it names none.
 *
 * Mirrors the layout the program parses: a u32 LE discriminant, a u64 LE slot,
 * then an option tag followed by the address when set. The discriminant of
 * `UpgradeableLoaderState::ProgramData` is **3**, not 2 — the enum declares
 * `Uninitialized`, `Buffer`, `Program`, `ProgramData`, and Borsh writes the
 * variant index. `2` is `Program`, which only points at this account.
 *
 * Kept here only to produce a legible error before signing; the program
 * re-derives and re-checks all of it, so a mistake in this function cannot make
 * an unauthorised init succeed.
 */
async function readUpgradeAuthority(
  connection: anchor.AnchorProvider["connection"],
  programData: PublicKey,
): Promise<PublicKey | null> {
  const info = await connection.getAccountInfo(programData);
  if (info === null) {
    throw new Error(`no ProgramData account at ${programData.toBase58()}`);
  }
  const discriminant = info.data.readUInt32LE(0);
  if (discriminant !== PROGRAM_DATA_DISCRIMINANT) {
    throw new Error(
      `${programData.toBase58()} is not a ProgramData account (discriminant ${discriminant})`,
    );
  }
  if (info.data[12] === 0) return null;
  return new PublicKey(info.data.subarray(13, 45));
}

async function main(): Promise<void> {
  const treasury = new PublicKey(
    required("TREASURY", arg("treasury") ?? process.env.NEXT_PUBLIC_TREASURY),
  );
  const arbiter = new PublicKey(
    required("ARBITER", arg("arbiter") ?? process.env.NEXT_PUBLIC_ARBITER),
  );
  const arbiterTimeout = new BN(arg("arbiter-timeout") ?? "259200"); // 72h
  const minAgreement = new BN(arg("min-agreement") ?? "20"); // whole tokens

  const authority = upgradeAuthorityKeypair();
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  // The program id lives in the IDL's own `address`, written by the build that
  // produced it — so this cannot be pointed at the wrong program by accident.
  const program = new anchor.Program(idl as never, provider);

  const [configPda] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    program.programId,
  );
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE,
  );

  // Read back the authority this program was deployed with, and refuse early if
  // it is not the signer. The program would reject it anyway; failing here says
  // *why*, instead of surfacing a bare NotUpgradeAuthority from the RPC.
  const declared = await readUpgradeAuthority(provider.connection, programDataPda);
  if (declared === null) {
    throw new Error(
      `${programDataPda.toBase58()} holds no upgrade authority, so the Config ` +
        "cannot be initialised. Deploy with an authority and try again.",
    );
  }
  if (!declared.equals(authority.publicKey)) {
    throw new Error(
      `the upgrade authority of ${program.programId.toBase58()} is ` +
        `${declared.toBase58()}, but ANCHOR_WALLET is ${authority.publicKey.toBase58()}. ` +
        "init_config requires the signer to be the upgrade authority.",
    );
  }

  const existing = await provider.connection.getAccountInfo(configPda);
  if (existing !== null) {
    throw new Error(
      `Config already exists at ${configPda.toBase58()}. It is set once; to change the ` +
        "treasury or arbiter afterwards, use setConfigRoles rather than re-running this.",
    );
  }

  console.log(`program      ${program.programId.toBase58()}`);
  console.log(`config       ${configPda.toBase58()}`);
  console.log(`admin        ${authority.publicKey.toBase58()}`);
  console.log(`treasury     ${treasury.toBase58()}`);
  console.log(`arbiter      ${arbiter.toBase58()}`);
  console.log(`arbiter wait ${arbiterTimeout.toString()}s`);
  console.log(`minimum      ${minAgreement.toString()} whole tokens`);

  const signature = await program.methods
    .initConfig(treasury, arbiter, arbiterTimeout, minAgreement)
    .accountsPartial({
      admin: authority.publicKey,
      config: configPda,
      programData: programDataPda,
      program: program.programId,
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers([authority])
    .rpc();

  console.log(`\ninitialised: ${signature}`);
}

main().catch((error: unknown) => {
  console.error(`init-config failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});