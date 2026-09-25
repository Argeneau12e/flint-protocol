/**
 * Chain time (Section 4.5).
 *
 * The program reads expiry from the Clock sysvar and never from an argument. The
 * app must do the same when it decides whether an agreement is still live: a host
 * clock can be wrong, skewed, or (in a container) hours off, and an agent that
 * trusts it would happily pay for an agreement the program would refuse to
 * release — or refuse one it could have paid.
 *
 * One function, one source, used by the agent, the responder and the tests.
 */

import { Connection, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

/** Current unix seconds, read from the Clock sysvar. */
export async function chainNowSeconds(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (info === null) {
    throw new Error("Clock sysvar unavailable — refusing to guess the time.");
  }
  return Number(info.data.readBigInt64LE(32));
}
