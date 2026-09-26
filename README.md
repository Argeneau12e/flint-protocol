# Flint

**FRS-1 payment agreements on Solana.** An escrowed, expiring payment agreement
with a deterministic settlement path and an on-chain verifiable receipt.

Solana Pay moves money, a Solana Action triggers a transaction, x402 lets a
machine pay for one HTTP call. None of them answer: *what is owed, under what
terms, to whom, and how do both sides prove it happened?* FRS-1 is that missing
layer — one schema, one state machine, two audiences (a human paying a
freelancer through a Blink, and an agent paying for a priced endpoint through
x402 under a deterministic spend policy).

**Status: Phases 0–4 complete.** The escrow program is implemented and green
(`anchor test`, 21/21, including one named test per Section 5 threat-model row).
Both flows work end to end on devnet: a recipient creates an agreement and shares it
as a Solana Blink, a payer funds it and releases it (or, past expiry, anyone can
refund it to the payer), and a priced endpoint answers `402` with an FRS-1 agreement
that a deterministic policy engine settles through the *same* escrow program. Every
receipt is recomputed from chain by the same verification page, whichever flow
produced it. `npm run test:agent` is green: 35/35.

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
│   ├── src/lib.rs                  # program id + #[program] entrypoint
│   └── tests/flint-escrow.ts       # Section 5 threat-model tests
├── app/                            # Next.js + TypeScript app
│   ├── app/api/x402/route.ts      # the priced endpoint: 402 + FRS-1, or serve
│   ├── app/api/agent/run/route.ts # runs the test agent on demand (POST)
│   ├── app/verify/[tx]/page.tsx   # public receipt verification, from chain
│   ├── app/agent/page.tsx         # agent harness + decision log (refusals shown)
│   ├── lib/frs1-types.ts          # canonical FRS-1 TypeScript types — Section 4.1
│   ├── lib/frs1-chain.ts          # account -> FRS-1 object (the one reader)
│   ├── lib/flint-program.ts       # program client: the only module that builds txs
│   ├── lib/policy-engine.ts       # deterministic pay/no-pay rules (no LLM)
│   ├── lib/decision-log.ts        # append-only JSONL log of every decision
│   ├── lib/verify.ts              # recomputes a receipt from chain (row 7)
│   ├── lib/x402.ts                # the x402 wire format
│   ├── lib/agent.ts               # the test agent
│   ├── lib/solana.ts              # devnet cluster configuration
│   └── components/
├── scripts/provision-devnet.mjs  # wallets, devnet test mint, app/.env.local
├── scripts/sync-idl.mjs           # copies the generated IDL into app/lib/idl
├── tests/agent/                   # Phase 2 suites: policy (hermetic) + devnet
├── Anchor.toml                     # cluster = devnet
├── Cargo.toml                      # Rust workspace
└── package.json                    # root package: Anchor/mocha tests
```

## What works today

- **The escrow program** implements all six instructions — `create`, `fund`,
  `release`, `refund`, `cancel`, `flag_dispute` — enforcing Section 4.2's state
  machine and Section 4.6's constraints. `anchor test` is green: 21 tests against a
  local validator, one named test per Section 5 threat-model row, each constructing
  the attack and asserting the specific program rejection.
- **The x402 responder** (`GET /api/x402`) answers `402` with the x402 envelope and
  the FRS-1 agreement inside it. The agreement is proposed *on chain* at that
  moment: the recipient wallet signs `create`, exactly as a person does when sharing
  a Blink (Section 4.5). The retry carries `X-PAYMENT`; the claim is recomputed from
  chain before anything is served.
- **The policy engine** decides pay/no-pay with no model anywhere: amount, recipient
  allowlist, asset allowlist, status, expiry, TTL, condition type, spend cap,
  session budget, and envelope/agreement agreement. It is pure and total, and its
  tests run with no chain and no network.
- **The test agent** (`/agent`) fetches, decides, and either pays through the same
  escrow program — funding, then settling with `release` to produce the receipt — or
  refuses. Refusals are logged with their full check-by-check evaluation and shown
  on the page; the three demo scenarios (pay, over cap, unknown recipient) are in the
  form.
- **The human flow** (`/agreement/new`, `/agreement/<id>`, and the Actions endpoint
  `/api/actions/flint/<id>`) is the same state machine from the other side: a
  recipient signs `create` and shares the result as a Blink, a payer funds it from
  any Actions client, the payer releases it, and once it is expired and still
  funded, anyone can crank the refund to the stored payer.
- **Verification** (`/verify/<signature>`) recomputes a receipt from chain: it
  re-derives the agreement's PDA from the account's own fields, confirms the account
  status, and checks the transaction's *token balance deltas* — the escrow was
  debited exactly the agreed amount, and the account that gained it is owned by the
  stored counterparty. The identical code path serves agent-settled and
  human-settled agreements; there is no branch that asks who paid.
- `npm run test:agent` is green: 35 tests — 15 hermetic policy tests, 6 devnet
  x402 end-to-end tests (402 validity, pay-and-settle, refuse over cap, refuse
  unknown recipient, agent/human verification parity, forged-receipt rejection),
  3 devnet human-flow tests (create → fund via the Blink's POST → release;
  expire → permissionless refund; malformed links), and 11 throttle tests (address
  keying, the window, configuration, and the refusal a caller actually sees).

**Not built yet:** a listing or dashboard of live agreements, and anything that
touches mainnet — this build is devnet-only, deliberately (Section 12).

### Why there is no facilitator

Section 6.2 names Kora as an example of reusing facilitator tooling, not a
requirement. There is no public devnet Kora (or any SVM) facilitator to call, and
standing one up means running another service — out of scope for this build. So the
*x402 envelope* is real (`402`, `accepts[]`, `X-PAYMENT`) while *settlement* is FRS-1:
the agent signs and submits its own `fund` transaction to the same escrow program the
human flow uses, and verification recomputes from chain rather than trusting a
facilitator's word. The facilitator slot is a documented seam in `lib/x402.ts`, not
a stub that pretends to work.

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
cargo check -p flint-escrow          # quick type check
anchor test                          # build + local validator + the 21 tests
anchor deploy --provider.cluster devnet
```

## The agent flow (Phase 2)

The devnet fixture is created by a script, not by hand. It is idempotent — re-running
it tops up rather than recreating, so wallets keep their history:

```bash
# One-time per machine: two devnet wallets, a devnet test mint, and app/.env.local
FLINT_DEPLOYER_KEYPAIR='\\wsl.localhost\Ubuntu\home\<you>\.config\solana\id.json' \
  node scripts/provision-devnet.mjs

npm run test:policy        # hermetic: policy engine only, no chain, no network
npm run test:agent         # devnet end to end (402, pay, settle, refuse, verify)
npm run typecheck          # program tests + app lib + API routes
```

`app/.env.local` (gitignored) holds the program id, both keypair paths, the asset
mint, the price and the decision-log path. The keypairs live in `app/.keys/`, also
gitignored. After changing the program, run `npm run sync:idl` in `app/` to copy the
regenerated IDL into `app/lib/idl/`.

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

Root-level test dependencies (`npm install` at the repo root, already applied)
back the threat-model tests. The test file lives at
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

An earlier repository, [github.com/Argeneau12e/flint](https://github.com/Argeneau12e/flint),
holds a **first Flint prototype built for the Frontier hackathon**. It was never
submitted, and it is **not** the foundation of this build.

This repository is a from-scratch rewrite, not a continuation: a different
architecture (an on-chain escrow program at
`ziZiaCVcDaenoUP7jHdEPk4R2XJ8zeY5UbMPKFuqZxE` on devnet, a Blink-based human flow,
an x402 agent flow), with no code copied from the old repository. The old repo is
referenced for continuity of the name and the idea only — where this README, the
code, or `FLINT_BUILD_CONTEXT.md` describe how Flint works, this repository is the
only source of truth.

