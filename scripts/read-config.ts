// File: scripts/read-config.ts
import { readFileSync } from "node:fs";
import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";

async function main(): Promise<void> {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idl = JSON.parse(readFileSync("target/idl/flint_escrow.json", "utf8"));
  const program = new anchor.Program(idl as never, provider);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  const config = await (program.account as any).config.fetch(configPda);

  console.log(`config address ${configPda.toBase58()}`);
  for (const [key, value] of Object.entries(config)) {
    console.log(key.padEnd(22), String(value));
  }
}

main().catch((error: unknown) => {
  console.error(`read-config failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});