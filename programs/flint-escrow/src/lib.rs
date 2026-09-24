//! Flint escrow program — the reference Solana adapter for FRS-1.
//!
//! Scope is set by FLINT_BUILD_CONTEXT.md: one escrow PDA per agreement, six
//! instructions, and the Section 4.2 state machine enforced exactly. This
//! program is devnet-only until every Section 5 threat-model test is green and
//! a human has reviewed it (Section 6.3).
//!
//! PHASE 0 SCOPE: module wiring, the program id, and the FRS-1 state types.
//! There is no `#[program]` entrypoint and no instruction handler yet — Phase 1
//! adds both, together with the tests that prove each invariant, so that no
//! half-implemented custody path ever exists in this tree.

pub mod errors;
pub mod instructions;
pub mod state;

pub use state::*;

use anchor_lang::prelude::*;

// Devnet program id. The matching keypair is at the workspace root,
// `target/deploy/flint_escrow-keypair.json` (gitignored): Anchor resolves
// program keypairs there, not inside the crate directory. If the keypair is
// lost or regenerated, run `anchor keys sync` rather than editing this by hand.
//
// (A doc comment is not used here: rustdoc does not document macro
// invocations, so `///` would warn as an unused doc comment.)
declare_id!("ziZiaCVcDaenoUP7jHdEPk4R2XJ8zeY5UbMPKFuqZxE");
