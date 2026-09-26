# FLINT — Build Context & Execution Reference
**Status: v3, locked.** This file is the single source of truth for building Flint.
It survived two rounds of technical review before any code was written. Do not
silently deviate from anything marked **LOCKED** — if something here seems wrong
once you're in the code, stop and flag it back rather than reinterpreting it.

---

## 0. How to use this document (read this first)

1. Read this entire file before writing any code, every session, even if you
   read it before — context windows get compacted and details get lost.
2. Before starting work on a phase, restate back (briefly) what you understand
   the Boundary (Section 3) and the relevant Threat Model rows (Section 5) to
   require. If you can't, re-read Sections 3–5.
3. This file is organized so the parts that constrain *code* (Sections 3–8)
   come before the parts that explain *why* (Sections 1–2, 9). If you're
   short on context budget, Sections 3–8 are non-negotiable; Sections 1–2 and
   9 are motivation you can skim.
4. A companion PDF (`Flint-Master-Plan.pdf`) has the full pitch/business
   narrative. You do not need it to write correct code — everything
   code-relevant is duplicated here. Only reach for the PDF if you need the
   *why* behind a decision that isn't explained here.
5. One phase at a time. Do not start the next phase until the human tells you
   to — stop at the end of each phase's deliverables and report back.
6. Every claim in Section 5 (Threat Model) must correspond to a test that
   actually tries to violate the invariant. "The happy path works" is never
   the definition of done for the escrow program.

---

## 1. What Flint is (thesis)

Solana Pay moves money. Solana Actions trigger a transaction. x402 lets a
machine pay for one HTTP call. None of them answer: *what is owed, under what
terms, to whom, and how do both sides prove it happened?* That missing layer —
a structured payment **agreement** with a fixed amount, an expiry, a
condition, escrow, and a verifiable receipt — is what Flint builds.

Two counterparties, one protocol, one chain:
- **Human flow**: a freelancer gets paid via an escrow-backed Flint agreement,
  shared as a Solana Blink, released when the client confirms delivery.
- **Agent flow**: an AI agent hits a priced endpoint, receives a Flint
  agreement as an HTTP 402 response, pays it on Solana via x402 under a
  deterministic spend policy, gets a verifiable receipt.

Same schema (FRS-1). Same state machine. Same guarantees. Two audiences.
Building this well on **one chain** beats building it thinly on two.

---

## 2. Locked decisions — do not revisit without flagging to the human

- **Solana only.** No Base/EVM implementation this build. FRS-1 is written to
  be chain-agnostic at the protocol layer so a second chain is a future
  *adapter*, not a rewrite — but no adapter code gets written now.
- **Both demo flows ship** (human/escrow AND agent/x402) — cutting to escrow-only
  would blunt the actual thesis. Don't drop the agent flow to save time; cut
  something else first (see Section 8).
- **FRS-1 is the protocol name.** Kept from the earlier (unsubmitted) Flint
  build for brand continuity. Don't rename it.
- **Vocabulary: "agreement," not "invoice."** An FRS-1 object is a payment
  agreement. Reserve "invoice" for describing it informally to end users if
  needed, but code, types, and docs say "agreement."
- **Old Flint repo is prior art, not a foundation.** Nothing gets copy-pasted
  from it. Fresh repo, fresh code. Its README/history gets referenced only for
  the honest prior-attempt disclosure text.
- **No visual design system yet.** See Section 9. Build clean, working,
  accessible UX with placeholder styling. Do not invest time in a color
  palette, logo, animation, or brand identity — that's a separate,
  human-led track running in parallel.

---

## 3. The Flint Boundary — non-goals (hard constraints)

> Flint v1 does not attempt to solve every form of programmable money. It
> defines a narrow, enforceable payment agreement primitive: a payer commits a
> fixed asset and amount to a named recipient under explicit terms, with a
> deterministic settlement path and an on-chain verifiable receipt. Flint does
> not arbitrate subjective disputes, evaluate arbitrary real-world conditions,
> support partial settlement, or provide generalized cross-chain settlement in
> v1. These are deliberate protocol boundaries, not unfinished features.

| Capability | FRS-1 v1 |
|---|---|
| Fixed amount | **Yes** |
| Fixed asset | **Yes** |
| Explicit payer | **Yes** |
| Explicit recipient | **Yes** |
| Expiry | **Yes** |
| Funding (escrow) | **Yes** |
| Conditional release, narrowly defined | **Yes** |
| Deterministic agent policy | **Yes** |
| Verifiable receipt | **Yes** |
| Partial settlement | No |
| Arbitrated disputes | No |
| Oracle-dependent conditions | No |
| Multi-party escrow | No |
| Recurring payments | No |
| Complex milestone systems | No |
| Cross-chain settlement | No |

**If a task seems to require a "No" row, stop and flag it rather than building
a workaround.** The "No" rows are what make the "Yes" rows trustworthy.

---

## 4. FRS-1 Protocol Specification

### 4.1 Schema

```
id                 uuid-v4
payerAddress       the funding wallet — set at pending→funded, null before that
recipientAddress   the wallet the agreement pays out to — set at creation
title              string
amount             number, fixed at creation, immutable once funded
asset              SPL token mint (Pubkey) — e.g. USDC's mint
escrowAddress      the escrow's token account (ATA), not the agreement PDA — see 4.5
memo               string
expiresAt          unix timestamp
status             pending | funded | released | refunded | cancelled
condition          { type, description } — see 4.3
disputedFlag       boolean, does not change custody — see 4.2
disputedAt         optional timestamp, set/cleared alongside disputedFlag
handle             optional human-readable handle
agentPolicy        optional: { spendCap, allowlist } — for autonomous payers
receiptProof       settlement (release/refund) tx signature — see 4.4
```

### 4.2 Status state machine

**Corrected after Phase-0 planning review — this supersedes any earlier
version.** The recipient creates (proposes) an agreement; the payer is
whoever funds it first. `payerAddress` does not exist until funding, so no
"payer" authority exists on a pending agreement — see 4.5 for the full
authority model.

| Transition | Trigger | Who can trigger it |
|---|---|---|
| pending → funded | Someone deposits the stated `amount` into the escrow ATA — that address becomes `payerAddress`, permanently | Whoever funds it (first funder wins; this is what sets the payer) |
| pending → cancelled | Withdrawn before funding — terminal, no funds moved | Recipient only (no payer exists yet) |
| funded → released | Payer signs a confirmation that the condition is met | Payer only |
| funded → refunded | `expiresAt` has passed with no confirmation — permissionlessly claimable | Anyone can call it, but funds always go to the stored `payerAddress`, never to the caller |
| funded → funded (disputedFlag=true / false) | Recipient sets or clears the flag before expiry | Recipient only, either direction |

Rules that follow directly from this table (enforce all of them):
- Terms (`amount`, `recipientAddress`, `asset`, `condition`) are **immutable
  once funded**. No instruction may write to these fields on a funded PDA.
- **No partial settlement.** An agreement pays its full `amount` or nothing.
- **Once funded, the payer cannot unilaterally reclaim funds before expiry.**
  This is the rule that makes it escrow rather than a delayed transfer.
  `disputedFlag` never moves funds by itself — only a payer confirmation or
  `expiresAt` passing changes custody.
- `released` and `refunded` are terminal. Nothing transitions out of them.
- A known, accepted v1 limitation: if an agreement is funded, not yet
  expired, and both sides want to walk away, there is no instruction for
  that — it sits funded until either a release confirmation or expiry. This
  is a Boundary consequence (Section 3), not a bug. A mutual early-release
  path is a fair roadmap item, not a v1 task.

### 4.3 What "condition" means in v1

A condition object carries a `type` and a human-readable `description`. v1
ships **exactly one** mechanically enforced type:

- `manual-confirmation` — release happens only when the payer signs a release
  instruction. Full stop. This is the only type the program checks.

`oracle-attested` (a trusted third party or milestone-verification service
signs off instead of the payer) is a named value in the schema for future
use, but **is not implemented in v1**. If asked to build oracle verification,
milestone scoring, or any automated condition-checking — that's out of scope
(Section 3). A condition `type` the program can check is the whole point; a
free-text string alone is not a verification mechanism, and no free-text
condition should ever gate an on-chain transition.

### 4.4 What the receipt proves — and what it doesn't

`receiptProof` (a transaction signature) proves, independently and publicly
verifiably, that a specific state transition (funded / released / refunded)
occurred, for a specific amount and asset, authorized by the specific signer
the program required. That's a cryptographic fact anyone can check against
the chain directly — not a claim Flint's own database makes about itself.

It does **not** prove the underlying real-world condition was true (e.g.
"the work was actually delivered"). That's an attestation by the payer, not a
cryptographic proof of a physical-world fact. Never build UI copy or docs
that imply otherwise.

### 4.5 Authority model & PDA derivation (locked, post-Phase-0-planning)

- **Recipient creates.** The recipient signs the `create` instruction and
  sets `recipientAddress` (self), `amount`, `asset`, `condition`, `expiresAt`,
  `memo`/`title`. `payerAddress` is not set at creation — this models a real
  invoice/payment-request: the recipient defines terms and shares a link
  (Blink or 402 response); whoever funds it becomes bound by those terms.
  This is deliberately the same shape for both flagship flows: the
  freelancer (recipient) shares a Blink in the human flow; the priced
  endpoint (recipient) issues the 402 payload in the agent flow. Neither
  needs to know the payer's identity in advance.
- **PDA seeds are recipient-bound**: `[b"agreement", recipient.key(),
  uuid_bytes]`. The recipient is the only party whose authority matters at
  creation, so seeds are bound to them, not to a payer that doesn't exist
  yet.
- **`escrowAddress` is the escrow's SPL token account (ATA)** — a separate
  account from the agreement PDA. The agreement PDA is the state/authority
  account (all the FRS-1 fields above); the ATA is where the actual tokens
  sit, with the agreement PDA (or a dedicated escrow-authority PDA derived
  from it) as its authority.
- **SPL-token-only custody in v1.** No native SOL escrow. `asset` stores the
  mint `Pubkey` directly (authoritative); a human-readable symbol like
  "USDC" is a display-only lookup in the app layer, never stored on-chain.
- **Time source is always the on-chain Clock sysvar**, never an
  instruction-supplied timestamp. Non-negotiable — this is what Threat Model
  row 3 (Section 5) actually depends on.
- **`amount` is `u64` base units on-chain, always.** Never a float, anywhere
  in the program. On the TypeScript boundary, expose `amount` as a decimal
  string in base units (JS `number` loses precision above 2^53) — UI-layer
  decimals are for display only, computed from the string, never round-tripped
  through a float.

### 4.6 Additional constraints resolved during Phase 0

- **Expiry validation, both ends.** `create` rejects any `expiresAt` that is
  not strictly in the future. `fund` separately rejects funding a `pending`
  agreement whose `expiresAt` has already passed — time can elapse between
  create and fund, so both checks are required. Without this, a released
  agreement could become permanently unpayable (Section 5, row 3 requires
  `now < expiresAt` to release) while still passing a naive funding check.
- **`flag_dispute` requires `status == Funded`.** Rejected on `pending`
  (nothing to dispute) and on `released`/`refunded`/`cancelled` (already
  terminal). No expiry check — the flag must remain settable/clearable past
  expiry, since it is advisory-only and must never block the permissionless
  refund path (Section 4.2's liveness guarantee).
- **`cancel` closes the account**, returning rent to the recipient. Safe
  because a cancelled-while-`pending` agreement never held funds or produced
  a receipt. **`release` and `refund` do not close their accounts** — the
  verification page reads state directly from the account (4.4, 6.2), and a
  closed account has nothing left to read.
- **Field length bounds** (account layout — changing these after Phase 1
  means a redeploy): title 128 bytes, memo 512, handle 64, condition
  description 256, agent policy allowlist 16 entries, receiptProof 96 bytes.

### 4.7 Judgment calls confirmed during Phase 1 (locked)

- **`oracle-attested` is rejected at `create`, not deferred to `release`.**
  Matches 4.6's own principle — never allow an agreement to exist that can
  never resolve.
- **`cancel` closes both the agreement PDA and the empty escrow ATA**, not
  just the PDA. The ATA is created at `create` time (ready to receive funds
  later); since `cancel` is pending-only, the ATA is always empty when this
  runs, so closing both is safe and prevents stranded rent.
- **`receiptProof` is never written on-chain.** A program cannot read its
  own transaction's signature during execution — this is a Solana execution
  model constraint, not a gap. It's populated at the app/client layer
  (captured at submission time, or looked up from the account's transaction
  history) and matches the settlement transaction per 4.4's
  verify-by-recomputing-from-the-account model.

---

## 5. Threat Model — every row needs a test

| # | Threat | Security invariant | Enforcement |
|---|---|---|---|
| 1 | Unauthorized release | Only the defined release authority can transition funds | Release instruction requires the stored `payerAddress` as a signer; program rejects otherwise |
| 2 | Account substitution | Every critical account is checked against stored agreement state | Program validates recipient/escrow accounts against the PDA's stored addresses, never instruction-supplied accounts |
| 3 | Expiry bypass | Expired agreements cannot enter a settlement transition | Release instruction checks `now < expiresAt`; fails after expiry — only refund remains valid |
| 4 | Replay | A funding/settlement authorization cannot be consumed twice | PDA marks itself released/refunded on first settlement; a repeat attempt fails the state check |
| 5 | Wrong asset/amount | Settlement must match the agreement's immutable asset + amount | Program checks the transfer amount and mint against the values stored at funding |
| 6 | Unauthorized mutation | Funded agreement terms cannot be silently changed | No instruction exists that can write to a funded PDA's term fields |
| 7 | Fake/duplicate receipt | A receipt references an actual on-chain state transition | Verification recomputes status from the account directly; a receipt is only valid if it matches the program's own settlement instruction |

**Deliberately not covered**: anything assuming an oracle/arbiter role
(a "malicious verifier" approving a fake milestone, for instance) — v1 has no
such role (Section 3). Don't build a test for a threat model row that doesn't
exist yet.

**Definition of done for the escrow program**: all 7 rows have a test that
(a) sets up the attack, (b) asserts the program rejects it, and (c) is named
so the mapping to this table is obvious (e.g. `test_rejects_unauthorized_release`,
`test_rejects_expired_release`, `test_rejects_replay_settlement`, etc.).

---

## 6. Architecture

### 6.1 Protocol vs. adapter

| Layer | Role | v1 status |
|---|---|---|
| FRS-1 (protocol) | Chain-agnostic agreement semantics — schema, state machine, condition types | Specified (this doc) |
| Solana adapter | Reference implementation — Anchor escrow program, Blinks, x402-on-Solana settlement | **This is what you're building** |
| Future adapters (Base, others) | Same FRS-1 semantics, a different settlement layer | Not built — keep the escrow logic and the FRS-1 type definitions cleanly separated from Solana-specific plumbing so a future adapter doesn't require touching the protocol layer |

### 6.2 Solana adapter components

| Component | Implementation |
|---|---|
| Settlement | Anchor program — escrow PDA with `create`, `fund`, `release`, `refund`, `cancel`, `flag_dispute` instructions, enforcing Section 4.2's state machine exactly |
| Human payment UX | Solana Actions + Blinks, Phantom-first wallet adapter |
| Agent settlement | x402 responder on Solana — genuine x402 envelope (402, `x402Version`, `accepts[]`, `X-PAYMENT`/`X-PAYMENT-RESPONSE`); settlement is direct through the Phase 1 escrow program, no facilitator — see 6.4 |
| Agent policy layer | Deterministic policy engine: spend cap + allowlist check, decision log. **No LLM call in the pay/no-pay decision path** — this must be plain deterministic code, testable without a model in the loop |
| Verification | Public page that recomputes status by reading the on-chain account directly — never from cached API/UI state |

### 6.3 Phase 2 decisions (locked)

- **No facilitator.** Checked before building: no usable Kora repo, no
  public Solana devnet x402 facilitator exists, and self-hosting one fails
  the disk budget. The x402 envelope (402 response, headers, retry flow) is
  genuine; settlement bypasses a facilitator entirely and goes straight
  through the Phase 1 escrow program, the same as the human flow.
- **Verify from token balance deltas, never from top-level instruction
  parsing.** The escrow program's transfer happens via CPI, so it never
  appears in a transaction's top-level instruction list — only in inner
  instructions, whose encoding varies by how the transaction was fetched.
  Correct verification checks that the escrow's token balance decreased by
  exactly the agreed amount and the stored counterparty's balance increased
  by it — the state change itself, not an encoding-dependent proxy for it.
  This applies to any future settlement-verification code, not just the
  agent flow.
- **UUIDs must be created v4 from the start** (not generated then
  reformatted) — a re-derived PDA from a reformatted id computes a different
  address than the one actually stored on-chain.
- **A public 402 endpoint mints a new on-chain pending agreement per
  unauthenticated request** (~0.0105 SOL rent from the service wallet each
  time). Fine on devnet for a demo; a real spam/rate-limit concern before
  this ever sees mainnet traffic. **Add a lightweight per-IP/time-window
  throttle on the 402 route in Phase 4** so the demo wallet can't be drained
  by repeated hits during judging — not a v1 protocol requirement, just
  demo-safety hardening.

### 6.4 Stack

- **Program**: Rust / Anchor
- **App**: Next.js + TypeScript
- **State/cache**: Upstash Redis (fast to ship; not the source of truth for
  fund custody — the chain is)
- **Wallet**: Solana wallet-adapter, Phantom-first
- **Network**: Solana devnet for all development and testing; nothing touches
  mainnet until every Section 5 test is green and a human has reviewed the
  escrow program

---

## 7. The two flagship demo scenarios (acceptance criteria)

### 7.1 Human / escrow — done when:
1. A recipient (the freelancer) can create an agreement (title, amount,
   asset, expiry, condition = `manual-confirmation`) and get back a
   shareable Blink. `payerAddress` is not set yet (Section 4.5).
2. Opening the Blink in a Solana wallet lets the client fund it — that
   wallet becomes `payerAddress`, funds move into the escrow ATA, status →
   `funded`.
3. The payer can sign a release confirmation — funds move to the recipient,
   status → `released`, a `receiptProof` is recorded.
4. If expiry passes unconfirmed, anyone can trigger the refund path — funds
   return to the payer, status → `refunded`.
5. The verification page for that agreement shows accurate, chain-derived
   status at every stage above.

### 7.2 Agent / x402 — done when:
1. A priced endpoint returns HTTP 402 with a valid FRS-1 agreement object.
2. A test agent's policy engine evaluates the agreement against a spend cap
   and an allowlist, and makes a pass/fail decision **without calling an
   LLM**.
3. On pass, the agent pays via x402, settlement happens on Solana through the
   same escrow program as 7.1, and a `receiptProof` is recorded.
4. On fail (over spend cap, or recipient not allowlisted), the agent does not
   pay, and this is logged/visible, not silent.
5. The verification page works identically for an agent-settled agreement as
   for a human-settled one — same page, same logic.

Both scenarios must be demoable end-to-end on devnet before Phase 4 is
considered complete.

---

## 8. Scope — in vs. roadmap

**In scope (must be flawless):**
- FRS-1 core object + full state machine (create / fund / release / refund / cancel / flag-dispute)
- All 7 threat-model invariants, each with a passing test
- Blinks payment UX + wallet connect + PDA release (human flow)
- x402 responder on Solana + deterministic policy engine (agent flow)
- Public verification page, reads directly from chain
- Both demo scenarios in Section 7, working end-to-end

**Roadmap only — do not build, do not stub out half-versions of these:**
- A second chain adapter (Base/EVM)
- `oracle-attested` condition type, partial settlement
- On-chain dispute arbitration
- Split payments, recurring/subscription billing
- PEPPOL/UBL XML export
- Flint.ID handles, QR identity pages, embed widget, invoice templates
- Full autonomous "scan every pending agreement" agent mode
- Webhook dashboard, analytics dashboard, wallet dashboard UI

If you find yourself writing code for anything in the roadmap list, stop —
that's scope creep, not thoroughness.

---

## 9. UX standard — without a visual design system

Visual identity (color palette, typography, logo, motion design, iconography,
brand voice) is a **separate, human-led track** running in parallel and is
deliberately not part of this build yet. That does not mean the UX is
low-priority — it means the UX must be *good on structure and behavior*,
wearing placeholder/neutral styling that's trivial to restyle later.

Concretely:
- Use a neutral, unstyled or minimally-styled component approach (plain
  Tailwind utility classes or an unstyled component primitive set) — no
  hardcoded brand colors, no custom fonts, no decorative flourishes.
- Keep all styling in swappable, centralized places (Tailwind config /
  CSS variables), never inline ad hoc styles scattered through components —
  this is what makes the later design pass fast instead of a rewrite.
- Mark every place a future design pass will touch with a visible comment,
  e.g. `{/* TODO-DESIGN: logo slot */}`, `{/* TODO-DESIGN: empty state illustration */}`.
- Every async action (create, fund, release, refund) has a visible loading
  state, a clear success state, and a clear, specific error state — never a
  silent failure or an infinite spinner.
- Every form validates inputs and explains *why* something is invalid, not
  just that it is.
- No dead ends: every screen has an obvious next action or a way back.
- Keyboard-navigable, reasonable color contrast even in an unstyled state,
  semantic HTML (real `<button>`s and `<label>`s, not styled `<div>`s).
- Mobile-responsive at a basic layout level — this doesn't need design polish,
  it needs to not break.
- Wallet interactions (connect, sign, confirm) always show what's happening
  and what the user is being asked to approve, in plain language.

This is the bar: a design-literate person should be able to look at the raw
build and say "this works cleanly, it just needs a coat of paint" — not "this
needs to be restructured before it can look good."

---

## 10. Proposed repo structure

```
flint/
├── programs/
│   └── flint-escrow/
│       ├── src/
│       │   ├── lib.rs
│       │   ├── state.rs            # FRS-1 account struct (Section 4.1)
│       │   ├── instructions/
│       │   │   ├── create.rs
│       │   │   ├── fund.rs
│       │   │   ├── release.rs
│       │   │   ├── refund.rs
│       │   │   ├── cancel.rs
│       │   │   └── flag_dispute.rs
│       │   └── errors.rs
│       └── tests/
│           └── flint-escrow.ts     # one test per Section 5 row, minimum
├── app/
│   ├── app/
│   │   ├── api/
│   │   │   ├── frs1/               # FRS-1 CRUD API surface
│   │   │   └── x402/               # x402 responder endpoint(s)
│   │   ├── pay/[id]/               # human payment / Blink landing page
│   │   └── verify/[tx]/            # verification page
│   ├── lib/
│   │   ├── frs1-types.ts           # canonical FRS-1 TypeScript types (Section 4.1)
│   │   ├── solana.ts
│   │   └── policy-engine.ts        # deterministic agent policy logic (Section 6.2)
│   └── components/                 # minimal, undesigned components
├── FLINT_BUILD_CONTEXT.md          # this file
├── Anchor.toml
├── package.json
└── README.md                       # includes the honest prior-attempt disclosure
```

---

## 11. Build phases

Work through these **one at a time**. Stop and report back at the end of
each — do not self-advance to the next phase.

- **Phase 0 — Bootstrap.** Repo scaffold, tooling, devnet config, FRS-1 types
  in both Rust and TypeScript matching Section 4.1 exactly. No business logic.
- **Phase 1 — Escrow program.** All instructions from Section 6.2, all 7
  Section 5 tests passing. This is the highest-stakes phase; expect a review
  checkpoint before moving on.
- **Phase 2 — Agent / x402 flow.** Responder, policy engine, wired to the
  Phase 1 program. Section 7.2 acceptance criteria met.
- **Phase 3 — Human flow UX.** Blinks flow, verification page, per Section 9's
  UX standard. Section 7.1 acceptance criteria met.
- **Phase 4 — Integration & hardening.** Both demos working end-to-end on
  devnet, full Section 5 test pass, bug bash.

---

## 12. Working agreement for the coding agent

- Re-read this file at the start of every session.
- Never silently build something in the Roadmap list (Section 8) or the "No"
  column (Section 3) — flag it back instead.
- Security-critical code (anything in `programs/flint-escrow`) gets extra
  scrutiny: after writing or changing an instruction, explicitly re-check it
  against every relevant Section 5 row before considering it done.
- If a decision in this file seems wrong once you're in the actual code, say
  so and why — don't quietly work around it.
- Commit at the end of each phase with a message that references the phase
  and what's now true (e.g. `Phase 1: escrow program, all 7 threat-model
  tests passing`).
- Devnet only. Nothing here should ever reference a mainnet key or touch
  mainnet.