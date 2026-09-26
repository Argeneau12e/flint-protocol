/**
 * Shared UI pieces for the human flow (Phase 3).
 *
 * Extracted because the same three things appear on both the create page and the
 * agreement page, and because they are exactly the elements Section 9 constrains:
 * real `<button>`s and real status regions, no hardcoded colour, and a visible
 * state for every async action.
 *
 * None of this is a design system — that is a separate, human-led track. These are
 * the structural pieces a design pass will restyle, not paint over.
 */

"use client";

import type { ReactNode } from "react";
import { useFlintWallet } from "@/lib/wallet";

/** Truncates a base58 address for display, keeping both ends recognisable. */
export function shortAddress(address: string | null): string {
  if (address === null) return "";
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Connect / disconnect.
 *
 * Names the wallet it will prompt with, because "Connect" alone leaves a person
 * unable to tell what is about to appear on their screen.
 */
export function ConnectButton() {
  const { address, connected, connecting, connect, disconnect, label } = useFlintWallet();

  if (!connected) {
    return (
      <span className="flint-connect">
        <button
          type="button"
          className="flint-button"
          disabled={connecting}
          onClick={() => {
            // Selection is a promise to open a wallet; a rejected one is a dead
            // end unless it is said out loud, so it is captured as text.
            void connect().catch((cause: unknown) => {
              window.alert(
                cause instanceof Error
                  ? `Could not connect: ${cause.message}`
                  : "Could not connect to a wallet.",
              );
            });
          }}
        >
          {connecting ? "Connecting…" : `Connect wallet${label === null ? "" : ` (${label})`}`}
        </button>
      </span>
    );
  }

  return (
    <span className="flint-connect">
      <span className="flint-muted">
        Connected: <code title={address ?? ""}>{shortAddress(address)}</code>
      </span>
      <button type="button" className="flint-button" onClick={() => void disconnect()}>
        Disconnect
      </button>
    </span>
  );
}

/**
 * The one place an async action reports itself.
 *
 * A live region with `role="status"` so a screen reader announces a state change
 * that has no visual focus target — a person waiting on a wallet prompt would
 * otherwise get silence. Errors are `role="alert"`, which is assertive: an error
 * is the one thing on the page that should interrupt.
 *
 * Always renders, even when there is nothing to say. An element that appears and
 * disappears shifts the layout under the person's cursor, which is a small way
 * of making a page feel unreliable.
 */
export function ActionFeedback({
  busy,
  message,
  error,
  success,
  signatureUrl,
}: {
  busy: boolean;
  message: string | null;
  error: string | null;
  success: string | null;
  signatureUrl?: string | null;
}) {
  return (
    <div className="flint-feedback" aria-live="polite">
      {busy ? (
        <p role="status" className="flint-note">
          {message ?? "Working…"}
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="flint-note flint-error">
          {error}
        </p>
      )}
      {success === null ? null : (
        <p role="status" className="flint-note flint-success">
          {success}
          {signatureUrl === undefined || signatureUrl === null ? null : (
            <>
              {" "}
              <a href={signatureUrl}>View the transaction</a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** A labelled form row. Real `<label for>`, so clicking the text focuses the input. */
export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flint-field">
      <label htmlFor={id} className="flint-label">
        {label}
      </label>
      {hint === undefined ? null : (
        <p className="flint-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {children}
    </div>
  );
}

/** A read-only key/value row for the terms summary. */
export function Term({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flint-term">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}
