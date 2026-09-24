//! `fund` — the first funder deposits the full amount (`Pending` → `Funded`).
//!
//! PHASE 0 STUB: specification only, no handler. Phase 1 must implement:
//!
//! - Signer: the funder. Whichever address calls this first becomes
//!   `payer_address`, permanently — open model, first funder wins (Section 4.2).
//!   The instruction must therefore be callable by any signer, and must bind
//!   the signer to the stored field atomically with the deposit.
//! - Requires `status == Pending`; a second call must fail the state check
//!   (row 4).
//! - Transfer: exactly `amount` of `asset` from the funder's token account into
//!   the escrow token account stored at creation. No partial funding, no
//!   topping up: the agreement is funded in full or not at all (row 5).
//! - The mint must be the stored `asset`, and the destination must be the
//!   stored `escrow_address` — never an instruction-supplied account taken on
//!   trust (rows 2, 5).
//! - Writes: `payer_address` (once, to the signer) and `status = Funded`.
//!   Nothing else. Terms stay exactly as created (row 6).
//!
//! Open question to settle before implementing (flagged, not guessed): whether
//! funding an already-expired agreement is rejected. See `create.rs`.
