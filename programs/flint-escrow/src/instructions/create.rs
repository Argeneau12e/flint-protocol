//! `create` — the recipient proposes an FRS-1 agreement (no state → `Pending`).
//!
//! PHASE 0 STUB: specification only, no handler. Phase 1 must implement:
//!
//! - Signer: the `recipient` **only** (Section 4.5). There is no payer yet, so
//!   no payer authority can be required or accepted here.
//! - PDA: `[AGREEMENT_SEED, recipient.key().as_ref(), id_bytes]`, where
//!   `id_bytes` is the 16 bytes of the uuid-v4. Recipient-bound (Section 4.5).
//! - Accounts: agreement PDA (init), recipient (signer), escrow token account
//!   (init, authority = the agreement PDA — Section 4.5), mint, recipient's
//!   owner account if needed for ATA derivation, token program, system program.
//! - Writes: `id`, `recipient_address`, `title`, `amount`, `asset`,
//!   `escrow_address`, `memo`, `expires_at`, `condition`, `handle`,
//!   `agent_policy`; `status = Pending`; `payer_address = None`;
//!   `disputed_flag = false`; `disputed_at = None`; `receipt_proof = None`.
//! - Must never write `payer_address` — funding owns that field, and it is set
//!   exactly once (Section 4.2).
//!
//! Rows this instruction must not weaken: 5 (the amount/asset stored here are
//! the immutable reference every later check compares against) and 6 (terms
//! cannot be rewritten once funded).
//!
//! Open question to settle before implementing (flagged, not guessed): may an
//! agreement be created with `expires_at` in the past, and — the case that
//! actually matters — may an *expired* pending agreement be funded? If it can,
//! `release` is impossible from the start (row 3), so the recipient could never
//! be paid. Section 4.2 does not say.
