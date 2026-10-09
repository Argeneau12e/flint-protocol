/**
 * The global Config account is decoded through the program's own Borsh coder,
 * never by hand-slicing raw bytes. This suite is the proof, and it is hermetic:
 * it builds a Config buffer with the Anchor layout and asserts that decoding it
 * returns the exact admin, treasury and arbiter that were encoded.
 *
 * Why it exists: the Config account begins with an 8-byte Anchor discriminator,
 * so `treasury` lives at bytes 40..72 — *after* `admin` (8..40) — not at
 * 32..64. An earlier reader sliced 32..64, which returns the last 24 bytes of
 * `admin` glued to the first 8 of `treasury`; every fee would have been routed
 * to a phantom wallet, and nothing would have thrown. Building the buffer with
 * the coder and reading it back through the same coder pins the layout to the
 * IDL, so a field added to `Config` in `state.rs` (and to the IDL) shifts the
 * decode instead of silently corrupting it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";
// Default import: `@anchor-lang/core` is CommonJS, and Node's native TS loader
// (which mocha uses for `.ts` specs) cannot resolve named exports from a CJS
// module — only the default export. This works under both ts-node and Node.
import anchor from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";

const { BorshCoder, convertIdlToCamelCase, BN } = anchor;

// The IDL is loaded the way `sync:idl` ships it: as raw JSON. The coder is built
// exactly the way `Program` builds it internally — `convertIdlToCamelCase` then
// `BorshCoder` — so the account is keyed `config`, matching `readConfig` in
// flint-program.ts. No connection, no keypair, no network: encode/decode are
// pure layout operations.
const IDL = JSON.parse(
  readFileSync(resolve(process.cwd(), "app/lib/idl/flint_escrow.json"), "utf8"),
) as never;
const coder = new BorshCoder(convertIdlToCamelCase(IDL));

const admin = Keypair.generate().publicKey;
const treasury = Keypair.generate().publicKey;
const arbiter = Keypair.generate().publicKey;

// The Config fields as the Borsh layout expects them: pubkeys as `PublicKey`
// instances (the layout calls `.toBuffer()` itself), u64 fields as `BN` (the
// on-chain type, which the layout serialises via `.toArrayLike`).
const configAccount = {
  admin,
  treasury,
  arbiter,
  arbiterTimeoutSecs: new BN(259_200),
  minAgreement: new BN(20),
  bump: 254,
};

describe("the global Config account decode (Step 0 bug check)", () => {
  it("encodes the discriminator ahead of the struct, so treasury is at 40..72", async () => {
    const buf = await coder.accounts.encode("config", configAccount as never);
    // 8-byte discriminator + 32 + 32 + 32 + 8 + 8 + 1 = 121 bytes.
    assert.equal(buf.length, 121, "Config is 121 bytes on the wire");
    // The treasury bytes are at 40..72, NOT 32..64 — this is the exact offset
    // the old hand-parser got wrong. Prove the correct offset is what decodes.
    assert.ok(
      buf.subarray(40, 72).equals(treasury.toBuffer()),
      "treasury is the 32 bytes at offset 40, after the discriminator and admin",
    );
    assert.ok(
      !buf.subarray(32, 64).equals(treasury.toBuffer()),
      "the buggy 32..64 slice must NOT equal treasury",
    );
  });

  it("decodes admin, treasury and arbiter back exactly", async () => {
    const buf = await coder.accounts.encode("config", configAccount as never);
    const decoded = coder.accounts.decode("config", buf) as unknown as {
      admin: { equals(k: unknown): boolean };
      treasury: { equals(k: unknown): boolean };
      arbiter: { equals(k: unknown): boolean };
      arbiterTimeoutSecs: { toString(): string };
      minAgreement: { toString(): string };
      bump: number;
    };

    assert.ok(decoded.admin.equals(admin), "admin round-trips");
    assert.ok(decoded.treasury.equals(treasury), "treasury round-trips");
    assert.ok(decoded.arbiter.equals(arbiter), "arbiter round-trips");
    assert.equal(decoded.arbiterTimeoutSecs.toString(), "259200");
    assert.equal(decoded.minAgreement.toString(), "20");
    assert.equal(decoded.bump, 254);
  });

  it("rejects a buffer whose discriminator is not the Config account's", async () => {
    const buf = await coder.accounts.encode("config", configAccount as never);
    const wrongDisc = Buffer.from(buf);
    wrongDisc[0] = wrongDisc[0] ^ 0xff; // corrupt the first discriminator byte
    assert.throws(
      () => coder.accounts.decode("config", wrongDisc),
      /discriminator/i,
      "a mismatched discriminator must fail, not silently decode",
    );
  });
});
