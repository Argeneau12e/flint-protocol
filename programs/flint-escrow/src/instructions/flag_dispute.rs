//! `flag_dispute` — the recipient sets or clears the advisory dispute flag
//! (`Funded` → `Funded`).
//!
//! PHASE 0 STUB: specification only, no handler. Phase 1 must implement:
//!
//! - Signer: the **stored** `recipient_address` only, and the same authority in
//!   both directions — set and clear (Section 4.2).
//! - Moves no funds, ever. `disputed_flag` is advisory: it must not block
//!   `release`, must not block `refund` after expiry, and must not be consulted
//!   by either of them. A flag that could strand funds past expiry would be a
//!   liveness bug, and Section 4.2 rules that out.
//! - Writes only `disputed_flag` and `disputed_at` (set to the current Clock
//!   time when flagging, cleared back to `None` when unflagging). Row 6: no
//!   term field may be touched.
//! - Requires `status == Funded` and `now < expires_at` (the state machine
//!   allows flagging "before expiry" only).
//!
//! Open question to settle before implementing (flagged, not guessed): should
//! flagging an expired-but-still-funded agreement be rejected (strict reading
//! of 4.2) or allowed as a no-op-with-no-effect on custody? And may a **pending**
//! agreement be flagged, or is the flag funded-only?
