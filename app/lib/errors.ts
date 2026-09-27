/**
 * A safe description of an *unexpected* internal failure, for a public response.
 *
 * Route handlers need to distinguish two kinds of failure. A **caller's** mistake —
 * a missing field, an unparseable address, a settlement that is not allowed yet —
 * has an explanation written for the person who sent it, and returning that text is
 * the whole point. An **internal** failure is different: the message was written for
 * a developer reading a log, and it routinely names things the caller has no business
 * knowing.
 *
 * The concrete case that motivated this: `lib/keys.ts` reports a keypair it cannot
 * read by absolute path, so a configuration fault inside a request handler would
 * have answered an anonymous caller with the server's directory layout. Library
 * errors can carry the same kind of detail for the same reason.
 *
 * So: callers keep their explanations; internal failures get a generic sentence plus
 * a correlation-free hint, and the detail goes to the server log where it belongs.
 * Nothing is logged here — the handler that catches the error already logs it, and
 * duplicating it would mean two copies of the same text to keep in sync.
 */

/** Logged alongside the generic response so the real cause is still recoverable. */
export function logInternalFailure(context: string, cause: unknown): void {
  console.error(
    `[flint] ${context} failed: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`,
  );
}

/**
 * The body of a 500. Deliberately says what the caller can act on (retry, or report
 * it) and nothing about the server's internals.
 */
export function internalFailureMessage(): string {
  return "Flint hit an unexpected problem handling this request and could not finish it. Nothing was changed on chain. This is a bug in the app, not in your request — please try again, and tell us if it keeps happening.";
}
