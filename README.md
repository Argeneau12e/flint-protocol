# Flint

**FRS-1 payment agreements on Solana.** An escrowed, expiring payment agreement
with a deterministic settlement path and an on-chain verifiable receipt.

Solana Pay moves money, a Solana Action triggers a transaction, x402 lets a
machine pay for one HTTP call. None of them answer: *what is owed, under what
terms, to whom, and how do both sides prove it happened?* FRS-1 is that missing
layer — one schema, one state machine, two audiences (a human paying a
freelancer through a Blink, and an agent paying for a priced endpoint through
x402 under a deterministic spend policy).

**Status: Phase 0 of 5.** Repository scaffold, tooling, devnet configuration and
the FRS-1 types in Rust and TypeScript. No custody logic exists yet — see
"What works today" below before assuming anything runs.

## The Flint Boundary (what v1 does and does not do)

Guaranteed in v1: fixed amount, fixed asset, explicit recipient, an explicit
payer once funded, expiry, real escrow, exactly one mechanically enforced
condition (payer-signed manual confirmation), a deterministic agent spend
policy, and a verifiable receipt per settlement.

Deliberately **not** in v1: partial settlement, arbitrated or subjective
disputes, oracle-attested or real-world conditions, multi-party escrow,
milestones, recurring payments, cross-chain settlement. These are protocol
boundaries, not unfinished features — and the "no" rows are what make the "yes"
rows trustworthy.

Two consequences worth stating plainly:

- `disputedFlag` is advisory. It never moves custody, never blocks release and
  never blocks refund after expiry. Only a payer confirmation or `expiresAt`
  passing changes custody.
- A funded, unexpired agreement has no exit path even if both sides want out.
  It sits until a release confirmation or expiry. A mutual early-release
  instruction is a fair roadmap item, not a v1 task.

A receipt proves that a specific state transition happened, for a specific
amount and asset, signed by the address the program required. It does **not**
prove the real-world condition was met. Nothing in this repo should imply
otherwise.

## Structure

```
flint/
├── programs/flint-escrow/          # the Anchor escrow program (Phase 1)
│   ├── src/state.rs                # FRS-1 agreement account — Section 4.1
│   ├── src/instructions/           # create/fund/release/refund/cancel/flag_dispute
│   ├── src/instructions.rs         # instruction module root
│   ├── src/errors.rs
│   ├── src/lib.rs                  # program id (no #[program] entrypoint yet)
│   └── tests/flint-escrow.ts       # Section 5 threat-model tests (Phase 1)
├── app/                            # Next.js + TypeScript app
│   ├── app/                        # routes (App Router): api/, pay/[id]/, verify/[tx]/ — later phases
│   ├── lib/frs1-types.ts           # canonical FRS-1 TypeScript types — Section 4.1
│   ├── lib/solana.ts               # devnet cluster configuration
│   └── components/
├── Anchor.toml                     # cluster = devnet
├── Cargo.toml                      # Rust workspace
└── package.json                    # root package: Anchor/mocha tests
```

## What works today (Phase 0)

- The app boots and renders the FRS-1 schema, status machine and boundary from
  `app/lib/frs1-types.ts` — a boot check, not a demo.
- The Rust FRS-1 types in `programs/flint-escrow/src/state.rs` compile.
- Devnet is configured (cluster, wallet, program id).

**Not built yet:** all six escrow instructions, all seven threat-model tests
(0 of 7), wallet connect, funding/release/refund flows, the verification page
and the x402 agent flow.

## Setup

Prerequisites: Node 22+, and for the program a Rust toolchain plus the Solana
CLI and Anchor CLI.

On this machine the program toolchain lives in **WSL Ubuntu** (rust 1.89.0,
solana-cli 3.1.10, Anchor 1.1.2 pinned) and the Next.js app runs natively on
Windows. Anchor 1.1.2 was chosen because it is already installed locally; the
Rust dependencies in `programs/flint-escrow/Cargo.toml` are pinned to match it.

```bash
# app (Windows or any shell with Node)
cd app
npm install
npm run dev          # http://localhost:3000
npm run typecheck

# program (WSL)
cd /mnt/c/Users/LENOVO/Desktop/Flint
cargo check -p flint-escrow          # Phase 0 bar: types compile
```

Devnet configuration already applied: RPC `https://api.devnet.solana.com`,
keypair `~/.config/solana/id.json`, program id
`ziZiaCVcDaenoUP7jHdEPk4R2XJ8zeY5UbMPKFuqZxE`.

The program id is backed by a keypair at
`target/deploy/flint_escrow-keypair.json` — note the workspace root, not the
crate directory: Anchor resolves program keypairs at the root `target/deploy/`,
because that is where the workspace's Anchor.toml lives. `target/` is
gitignored, so the keypair is machine-local; if it is ever lost or regenerated,
run `anchor keys sync` to bring `declare_id!` and `Anchor.toml` back in line
rather than editing them by hand.

Root-level test dependencies (`npm install` at the repo root) are needed from
Phase 1 onward, when the threat-model tests exist. The test file lives at
`programs/flint-escrow/tests/flint-escrow.ts` — Section 10's structure — so
`Anchor.toml`'s test script glob points there explicitly; Anchor's default
`tests/**/*.ts` would only see a root-level directory.

**Devnet only.** Nothing in this repository may reference a mainnet key or
endpoint, and the program will not be deployed anywhere else until all seven
threat-model tests pass and a human has reviewed it.

## Where the rules live

The build is governed by `FLINT_BUILD_CONTEXT.md` (v3, locked): the Boundary
(Section 3), the protocol spec (Section 4), the threat model (Section 5) and the
phase plan (Section 11). If code here ever disagrees with it, the document is
the source of truth and the disagreement is a bug to raise, not a decision to
make silently.

## Prior attempt (disclosure)

TODO(AUTHOR): this must state honestly that an earlier Flint build exists, that
it was never submitted, that nothing in this repository is copy-pasted from it,
and that it is referenced only for brand continuity (the FRS-1 name). The text
belongs to the human who owns that history — it is deliberately not invented
here.
