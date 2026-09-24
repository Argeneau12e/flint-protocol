//! `cancel` — the recipient withdraws before funding (`Pending` → `Cancelled`).
//!
//! PHASE 0 STUB: specification only, no handler. Phase 1 must implement:
//!
//! - Signer: the **stored** `recipient_address` only. Not the payer — there is
//!   no payer on a pending agreement, and none can be inferred (Section 4.2).
//! - Requires `status == Pending`. It must fail once funded: `cancel` is not an
//!   alias for `refund`, and it is not a payer escape hatch.
//! - Moves no funds. Nothing is escrowed while pending, so there is nothing to
//!   return — and no transfer instruction may appear in this handler.
//! - `Cancelled` is terminal: nothing transitions out of it.
//!
//! Consequence the spec owns explicitly (Section 4.2): a funded, unexpired
//! agreement has no exit path even if both sides want out. That is a Boundary
//! consequence, not a bug, and a mutual early-release instruction is a roadmap
//! item — deliberately not implemented here.
