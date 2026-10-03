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

import { useEffect, useState, type ReactNode } from "react";
import { useFlintWallet, useWalletIssue } from "@/lib/wallet";

/** Truncates a base58 address for display, keeping both ends recognisable. */
export function shortAddress(address: string | null): string {
  if (address === null) return "";
  return address.length <= 12
    ? address
    : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Connect / disconnect, with a picker when several wallets are installed.
 *
 * The names come from Wallet Standard detection (never an assumed Phantom),
 * and a failure at any point lands in the provider's banner via
 * `useWalletIssue` — which guarantees a specific, non-empty message per case
 * (not installed / declined / locked / unknown) and logs the full error.
 */
export function ConnectButton() {
  const {
    address,
    connected,
    connecting,
    connectByName,
    disconnect,
    available: detected,
  } = useFlintWallet();
  const { report, clear } = useWalletIssue();
  const [picking, setPicking] = useState(false);

  /**
   * Detection cannot run during server rendering: the server HTML says plain
   * "Connect wallet", so the client's first — hydrating — render must say the
   * same. A browser with a wallet installed would otherwise disagree at the
   * very first frame (React #418, a text hydration mismatch) on every page
   * carrying this header. The detected names join the render from the effect
   * onward, which is also after the adapter's listeners have run.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const available = mounted ? detected : [];

  if (connected) {
    return (
      <span className="flint-connect">
        <span className="flint-muted">
          Connected: <code title={address ?? ""}>{shortAddress(address)}</code>
        </span>
        <button
          type="button"
          className="flint-button"
          onClick={() => void disconnect()}
        >
          Disconnect
        </button>
      </span>
    );
  }

  const attempt = (name: string) => {
    clear();
    setPicking(false);
    connectByName(name);
  };

  // No connectable wallet in this browser: saying so is the whole action.
  if (available.length === 0) {
    return (
      <span className="flint-connect">
        <button
          type="button"
          className="flint-button"
          onClick={() =>
            report(new Error("No Solana wallet was found in this browser."))
          }
        >
          Connect wallet
        </button>
      </span>
    );
  }

  // Several wallets installed: a picker, never a guess.
  if (available.length > 1 && picking) {
    return (
      <span className="flint-connect">
        <span role="group" aria-label="Choose a wallet to connect">
          {available.map((name) => (
            <button
              key={name}
              type="button"
              className="flint-button"
              disabled={connecting}
              onClick={() => attempt(name)}
            >
              {connecting ? "Connecting…" : name}
            </button>
          ))}
        </span>
        <button
          type="button"
          className="flint-button"
          onClick={() => setPicking(false)}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span className="flint-connect">
      <button
        type="button"
        className="flint-button"
        disabled={connecting}
        onClick={() => {
          if (available.length > 1) setPicking(true);
          else attempt(available[0]);
        }}
      >
        {connecting
          ? "Connecting…"
          : available.length > 1
          ? "Connect wallet"
          : `Connect wallet (${available[0]})`}
      </button>
    </span>
  );
}

/**
 * Who the page will sign with, without offering a second way to connect.
 *
 * `ConnectButton` belongs in the header and nowhere else: connection is a
 * property of the session, and a page that repeats the control asks the person to
 * decide which of two identical buttons to use — and gives a keyboard, a screen
 * reader, and any test that selects by role an ambiguous target. Where a page
 * needs to say *which* wallet its buttons will run in, it says that here instead.
 */
export function WalletStatus({ action }: { action: string }) {
  const { address, connected } = useFlintWallet();

  if (!connected) {
    return (
      <p className="flint-hint">
        Connect a wallet in the bar above — {action} signs with that wallet.
      </p>
    );
  }

  return (
    <p className="flint-muted">
      Signing as <code title={address ?? ""}>{shortAddress(address)}</code>
    </p>
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
export function Term({
  term,
  children,
}: {
  term: string;
  children: ReactNode;
}) {
  return (
    <div className="flint-term">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}
