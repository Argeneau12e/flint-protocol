//! `release` — the payer confirms the condition is met (`Funded` → `Released`).
//!
//! PHASE 0 STUB: specification only, no handler. Phase 1 must implement:
//!
//! - Signer: the **stored** `payer_address` only, and nothing else. Any other
//!   signer — the recipient included — must be rejected (row 1). If
//!   `payer_address` is `None` (still pending) the instruction must fail.
//! - Requires `status == Funded`. A repeat call after settlement must fail the
//!   state check (row 4), and `Released` is terminal (Section 4.2).
//! - Requires `now < expires_at`, where `now` comes from the Clock sysvar and
//!   nowhere else (rows 3, and Section 4.5).
//! - Requires `condition.condition_type == ManualConfirmation`. `OracleAttested`
//!   must be rejected, not treated as satisfied (Section 4.3) — and no
//!   free-text `description` may ever influence this check.
//! - Transfer: the full `amount` of the stored `asset`, from the stored escrow
//!   token account to the stored `recipient_address`'s token account. The mint
//!   and amount actually transferred must equal what was stored at funding
//!   (row 5); the destination ATA must be validated against stored state rather
//!   than trusted from the instruction (row 2).
//! - Writes: `status = Released` and `receipt_proof = <this settlement
//!   signature>` (Section 4.4). Nothing else (row 6).
//! - Must not consult `disputed_flag`: the flag is advisory and never blocks
//!   release (Section 4.2).
