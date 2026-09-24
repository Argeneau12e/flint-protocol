//! Program error namespace.
//!
//! PHASE 0 STUB. Phase 1 replaces this with the real set — one variant per
//! Section 5 invariant the program enforces (unauthorized release, account
//! substitution, expiry bypass, replay, wrong asset/amount, unauthorized
//! mutation, invalid receipt), plus the Section 4.2 state-machine rejections.
//!
//! Nothing is wired to these yet, because no instruction logic exists yet.

use anchor_lang::prelude::*;

#[error_code]
pub enum FlintError {
    /// Placeholder so the error namespace compiles in Phase 0.
    /// No instruction in this build body-less state returns it.
    #[msg("Phase 0: no instruction logic is implemented yet.")]
    NotImplemented,
}
