//! `refund` — after expiry, anyone may crank; funds return to the payer
//! (`Funded` → `Refunded`).
//!
//! PHASE 0 STUB: specification only, no handler. Phase 1 must implement:
//!
//! - Signer: none beyond a fee payer. This is a permissionless crank, so it
//!   must not require the payer's signature (Section 4.2) — and it must not
//!   credit the caller either: funds always go to the **stored**
//!   `payer_address` (rows 1, 2).
//! - Requires `status == Funded`; a repeat call after settlement must fail the
//!   state check (row 4). `Refunded` is terminal.
//! - Requires `now >= expires_at`, Clock sysvar only (row 3 — this is the only
//!   valid transition once expired).
//! - Transfer: the full `amount` of the stored `asset` from the escrow token
//!   account back to the stored payer's token account (row 5). No partial
//!   refunds.
//! - Writes: `status = Refunded` and `receipt_proof = <this settlement
//!   signature>`. Nothing else (row 6).
//! - Must not consult `disputed_flag`: a flag that could block this would let
//!   funds be stranded past expiry, which Section 4.2 rules out explicitly.
