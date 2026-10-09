/**
 * Status timeline (Task 3): created, funded, delivered, disputed, settled
 * derived from chain fields. Side-column companion on the payment page.
 */

"use client";

import type { Frs1Agreement } from "@/lib/frs1-types";

function formatTime(at: number): string {
  return new Date(at * 1000).toISOString().replace("T", " ").slice(0, 16);
}

export function StatusTimeline({ agreement }: { agreement: Frs1Agreement }) {
  const settled =
    agreement.status === "released" ||
    agreement.status === "refunded" ||
    agreement.status === "split";
  const entries = [
    { label: "Created", at: null as number | null, done: true },
    {
      label: "Funded",
      at: null as number | null,
      done: agreement.status !== "pending" && agreement.status !== "cancelled",
    },
    { label: "Delivered", at: agreement.claimedAt, done: agreement.claimedAt !== null },
    { label: "Disputed", at: agreement.disputedAt, done: agreement.disputedAt !== null },
    { label: "Settled", at: null as number | null, done: settled },
  ];
  return (
    <ol className="flint-timeline" aria-label="Agreement timeline">
      {entries.map((entry) => (
        <li key={entry.label} data-done={entry.done} className="flint-timeline-row">
          <span aria-hidden="true" className="flint-timeline-dot" />
          <span>
            {entry.label}
            {entry.at !== null ? (
              <span className="flint-muted"> — {formatTime(entry.at)}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
