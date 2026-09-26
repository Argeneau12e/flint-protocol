/**
 * `/actions.json` — the Actions registry entry for this origin (Section 7.1.2).
 *
 * The spec has clients fetch this file from the domain root before unfurling a
 * URL, so it has to be a real route rather than a file sitting in `app/` (which
 * App Router does not serve — the earlier `app/app/actions.json` was never
 * reachable, and nothing in the UI referenced the path it mapped anyway).
 *
 * `rules` maps the two URLs a person can actually hold onto: the agreement
 * page (`/agreement/<id>?recipient=…`, which the card links to and which lives
 * in the browser bar) and the Blink/API URL itself (`/api/actions/flint/<id>?…`,
 * the string the create form hands over). The reference client fetches this
 * registry and maps *every* pasted URL through it — no matching rule means
 * `null` and no unfurl — so an empty registry would make the page link fail to
 * render in a way that looks like our bug. Patterns are pathname-only (not
 * absolute URLs) so they match on any origin: localhost, a tunnel, or a domain.
 */

import { actionsHeaders, actionsPreflight } from "../../lib/actions";

export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify(
      {
        $schema: "https://unpkg.com/@solana/actions-spec/schema/dialog.json",
        rules: [
          // Pasted agreement page -> that agreement's Blink API URL.
          { pathPattern: "/agreement/**", apiPath: "/api/actions/flint/**" },
          // Pasted Blink URL -> itself, so a client that always maps first
          // still lands on the same endpoint.
          { pathPattern: "/api/actions/flint/**", apiPath: "/api/actions/flint/**" },
        ],
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
