/**
 * Flint escrow tests.
 *
 * PHASE 0: this file deliberately contains no assertions.
 *
 * FLINT_BUILD_CONTEXT.md Section 5 defines the bar: one test per threat-model
 * row, each of which (a) sets up the attack, (b) asserts the program rejects it,
 * and (c) is named so the mapping to the table is obvious. None of those tests
 * can exist before Phase 1 implements the instructions, and a "happy path
 * works" test is explicitly not an acceptable substitute — so no placeholder
 * test is written here that could later be mistaken for coverage.
 *
 * The seven tests, to be written in Phase 1:
 *
 *   1. test_rejects_unauthorized_release       — row 1, unauthorized release
 *   2. test_rejects_account_substitution       — row 2, substituted accounts
 *   3. test_rejects_expired_release            — row 3, expiry bypass
 *   4. test_rejects_replay_settlement          — row 4, replay
 *   5. test_rejects_wrong_asset_or_amount      — row 5, wrong asset/amount
 *   6. test_rejects_mutation_of_funded_terms   — row 6, unauthorized mutation
 *   7. test_rejects_fake_or_duplicate_receipt  — row 7, fake/duplicate receipt
 *
 * Deliberately not covered: anything assuming an oracle or arbiter role — v1 has
 * no such role (Sections 3 and 5), so there is no such row to test.
 *
 * Runner: mocha via ts-mocha, per Anchor.toml `[scripts] test` (Section 10).
 */

export {};
