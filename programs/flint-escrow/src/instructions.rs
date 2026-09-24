//! Instruction modules for the escrow program.
//!
//! PHASE 0: these are specification stubs. Each module documents exactly what
//! its instruction must do — authority, accounts, state transition and the
//! Section 5 rows it must be tested against — with no handler code. Phase 1
//! implements them together with the threat-model tests.
//!
//! Invariants that hold across every instruction (Section 4.2 / 4.5):
//! - terms (`amount`, `recipient_address`, `asset`, `condition`) are immutable
//!   once funded;
//! - time comes from the Clock sysvar, never from an instruction argument;
//! - `disputed_flag` never moves custody and never blocks refund after expiry;
//! - `released` and `refunded` are terminal.

pub mod cancel;
pub mod create;
pub mod flag_dispute;
pub mod fund;
pub mod refund;
pub mod release;
