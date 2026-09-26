/**
 * `/actions.json` — the Actions registry entry for this origin (Section 7.1.2).
 *
 * The spec has clients fetch this file from the domain root before unfurling a
 * URL, so it has to be a real route rather than a file sitting in `app/` (which
 * App Router does not serve — the earlier `app/app/actions.json` was never
 * reachable, and nothing in the UI referenced the path it mapped anyway).
 *
 * `rules` is deliberately **empty**, and that is the honest value here: a rule
 * exists to translate a human path (say `/flint/<id>`) into an action API URL, but
 * Flint's shareable link *is* the API URL — `/api/actions/flint/<id>?recipient=…` —
 * so there is no path left to translate. Inventing a rule for a page that does not
 * exist would make a pasted link fail to unfurl in a way that looks like our bug.
 */

import { actionsHeaders, actionsPreflight } from "../../lib/actions";

export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify(
      {
        $schema: "https://unpkg.com/@solana/actions-spec/schema/dialog.json",
        rules: [],
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", ...actionsHeaders() },
    },
  );
}

/** A registry is fetched cross-origin too, so it answers preflight as well. */
export async function OPTIONS(): Promise<Response> {
  return actionsPreflight();
}
