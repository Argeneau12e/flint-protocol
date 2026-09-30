/**
 * Client half of the human flow: the wallet, and signing (Phase 3).
 *
 * "use client" is load-bearing here. This module talks to a browser wallet and
 * must never be pulled into a server component or a route handler — `lib/keys.ts`
 * is the server-side counterpart, and the split between them is the whole reason
 * a devnet keypair can never reach the browser bundle.
 *
 * Two things it provides, and both are load-bearing for the UX standard:
 *
 *   1. `signAndSend` — the *only* place a Flint transaction is signed and
 *      submitted, so every action (create, fund, release, refund) reports the
 *      same states in the same order. Note what it does **not** do: build the
 *      transaction. The server builds it from stored on-chain state and returns
 *      it unsigned; the wallet signs. A browser that constructed its own
 *      transaction could construct one the program would then have to reject, and
 *      that failure would surface as a wallet error rather than as an explanation.
 *   2. `useTransactionAction` — the loading / success / error state machine every
 *      async action is required to have (Section 9). Real stages in plain
 *      language ("waiting for you to approve in your wallet"), never an infinite
 *      spinner: a rejected signature, an expired blockhash and a failed
 *      simulation are three different messages to a person, so they are three
 *      different states here.
 */

"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { COMMITMENT, RPC_URL } from "./solana";

/** A connection built from the same devnet-only config as the server (Section 6.3). */
export function getBrowserConnection(): Connection {
  return new Connection(RPC_URL, COMMITMENT);
}

/**
 * A wallet the user declined, disconnected, or that is not installed.
 *
 * Distinguished from a *transaction* failure on purpose: the remedy is entirely
 * different (get a wallet, approve the prompt) and lumping them together is how
 * UIs end up telling someone to "try again" when retrying cannot possibly help.
 */
export class WalletError extends Error {
  constructor(
    message: string,
    readonly kind: "not_connected" | "rejected" | "unavailable" | "send_failed",
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/**
 * Everything a failure carries, flattened into one searchable string.
 *
 * Real wallets disagree about where the actual reason lives: the top-level
 * `message` can be empty while `error.error` (Phantom) or a nested `cause`
 * holds the real text, and some errors carry nothing but a `name`. Searching
 * all of them is what makes the classification below honest.
 */
function failureHaystack(cause: unknown): string {
  const parts: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object" || depth > 2) return;
    const record = value as Record<string, unknown>;
    for (const key of ["name", "message", "cause", "error"]) {
      const part = record[key];
      if (typeof part === "string") {
        parts.push(part);
      } else if (part instanceof Error) {
        if (part.name !== "") parts.push(part.name);
        if (part.message !== "") parts.push(part.message);
        visit(part, depth + 1);
      } else {
        visit(part, depth + 1);
      }
    }
  };
  visit(cause, 0);
  if (typeof cause === "string") parts.push(cause);
  return parts.join(" ").toLowerCase();
}

/**
 * A specific, human message for any wallet failure — **never an empty string**.
 *
 * This exists to make the Phase 5a bug impossible: a banner rendering
 * "Wallet problem:" with nothing after it. The cases a person can act on come
 * first and get their own text (declined / locked / not installed); then the
 * failure's own message; then a nested `error.error` (Phantom hides reasons
 * there); then the error's name; and only when literally nothing is known does
 * a fixed fallback stand in — which is still a full sentence.
 */
export function describeWalletFailure(cause: unknown): string {
  const haystack = failureHaystack(cause);
  const named = (cause as { name?: unknown } | null)?.name;
  const name = typeof named === "string" && named !== "" && named !== "Error" ? named : "";

  if (/(user )?(reject|declin|denied|cancel)/.test(haystack)) {
    return "You declined the request in your wallet, so nothing was signed and no money moved.";
  }
  if (/(locked|unlock|password|blocked)/.test(haystack)) {
    return "Your wallet is locked. Unlock it in the wallet's app or extension, then try again.";
  }
  if (/(not (yet )?installed|no (solana )?wallet|not found|not available|not ready|install)/.test(haystack)) {
    return "No Solana wallet is available in this browser. Install Phantom, or open this page inside a wallet's in-app browser.";
  }
  const message = (cause as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.trim() !== "") return message.trim();
  const nested = (cause as { error?: { message?: unknown } } | null)?.error?.message;
  if (typeof nested === "string" && nested.trim() !== "") return nested.trim();
  if (name !== "") return `The wallet reported an error with no message (${name}).`;
  return "The wallet reported an error with no message. Open the browser console for the full details.";
}

/**
 * Logs the failure in full — name, message, nested `cause` / `error`, and the
 * raw object — so the banner above can stay short without losing anything a
 * developer needs. Console only: nothing here is ever echoed back to the UI.
 */
export function logWalletFailure(cause: unknown): void {
  const record = cause as
    | { name?: unknown; message?: unknown; cause?: unknown; error?: unknown }
    | null;
  console.error("[flint] wallet failure", {
    name: typeof record?.name === "string" ? record.name : undefined,
    message: typeof record?.message === "string" ? record.message : undefined,
    cause: record?.cause,
    error: record?.error,
    raw: cause,
  });
}

/** Wallet-adapter's own errors, flattened to the cases a person can act on. */
function asWalletError(cause: unknown): WalletError {
  // Classify on the *full* haystack (name + message + nested error), but build
  // the message through the one function that can never return "" — an error
  // with an empty message used to be able to reach the UI verbatim.
  const haystack = failureHaystack(cause);
  const message = describeWalletFailure(cause);
  if (/(user )?(reject|declin|denied|cancel)/.test(haystack)) {
    return new WalletError(message, "rejected");
  }
  if (/(not (yet )?installed|no (solana )?wallet|not found|not available|not ready|install)/.test(haystack)) {
    return new WalletError(message, "unavailable");
  }
  if (/(blockhash|expired)/.test(haystack)) {
    return new WalletError(
      "The transaction's blockhash expired before it landed — devnet was slow. Nothing moved; try again.",
      "send_failed",
    );
  }
  return new WalletError(message, "send_failed");
}

/**
 * The banner state shared by the provider and every connect control (Phase 5a).
 *
 * The provider owns the banner; the connect button and the provider's own
 * `onError` both report through this context, so exactly one place turns a
 * wallet failure into something visible — and `report` always logs the full
 * error before a message is surfaced.
 */
export interface WalletIssue {
  message: string;
}

export interface WalletIssueApi {
  issue: WalletIssue | null;
  report: (cause: unknown) => void;
  clear: () => void;
}

export const WalletIssueContext = createContext<WalletIssueApi>({
  issue: null,
  report: (cause: unknown) => logWalletFailure(cause),
  clear: () => {},
});

export function useWalletIssue(): WalletIssueApi {
  return useContext(WalletIssueContext);
}

/**
 * Signs an unsigned base64 transaction with the connected wallet, submits it,
 * and waits for confirmation.
 *
 * `requireAllSignatures: false` on the way out because the wallet has just
 * signed and the transaction carries exactly one fee payer. Waiting for
 * confirmation rather than returning the signature optimistically is what lets
 * the caller show a success state that means "the chain accepted this" instead
 * of "we sent something".
 *
 * `onStage`, when given, is called just before the send and just before the
 * confirmation wait. Those are two different waits with two different failure
 * modes, and a person watching a screen cannot tell them apart from the outside
 * — so the caller is given the chance to say which one is happening.
 */
export async function signAndSend(
  connection: Connection,
  wallet: {
    publicKey: PublicKey | null;
    // Optional in the adapter's own type, hence the guard: an adapter that cannot
    // sign is a real possibility, and it must read as an error, not a crash.
    signTransaction:
      | (<T extends Transaction>(transaction: T) => Promise<T>)
      | undefined;
  },
  base64Transaction: string,
  onStage?: (stage: "submitting" | "confirming") => void,
): Promise<string> {
  if (wallet.publicKey === null) {
    throw new WalletError("Connect a wallet first.", "not_connected");
  }
  if (typeof wallet.signTransaction !== "function") {
    throw new WalletError(
      "This connected wallet cannot sign transactions. Reconnect a wallet that supports signing, such as Phantom.",
      "unavailable",
    );
  }

  let signed: Transaction;
  try {
    const unsigned = Transaction.from(Buffer.from(base64Transaction, "base64"));
    signed = await wallet.signTransaction(unsigned);
  } catch (cause) {
    throw asWalletError(cause);
  }

  const raw = signed.serialize({ requireAllSignatures: false, verifySignatures: false });
  let signature: string;
  onStage?.("submitting");
  try {
    signature = await connection.sendRawTransaction(raw, { skipPreflight: false });
  } catch (cause) {
    throw asWalletError(cause);
  }

  // The node took it; from here the wait belongs to the chain, and the screen has
  // to say so before the confirmation round-trips start.
  onStage?.("confirming");
  try {
    // Re-read the blockhash after signing: this is what makes the confirmation
    // check the *same* blockhash the transaction was built against, so a
    // transaction that lands late is not reported as confirmed against a
    // blockhash nobody sent.
    const blockhash = signed.recentBlockhash;
    if (typeof blockhash !== "string") {
      throw new WalletError(
        "The signed transaction carried no blockhash, so it could not be confirmed. Nothing moved; build it again.",
        "send_failed",
      );
    }
    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed",
    );
  } catch (cause) {
    if (cause instanceof WalletError) throw cause;
    throw asWalletError(cause);
  }
  return signature;
}

/** Wallet state, in the shape the components want. */
export function useFlintWallet() {
  const { publicKey, connected, connecting, connect, disconnect, wallet, wallets, select } =
    useWallet();
  const { report } = useWalletIssue();

  /**
   * Wallets this browser can actually connect to right now.
   *
   * The list comes from Wallet Standard auto-detection — the provider passes no
   * explicit adapters — so it reflects what is genuinely installed in this
   * browser and never assumes Phantom. Only `Installed`/`Loadable` wallets are
   * offered, matching what the adapter's own `connect()` will accept.
   */
  const available = wallets
    .filter(
      (entry) =>
        entry.readyState === WalletReadyState.Installed ||
        entry.readyState === WalletReadyState.Loadable,
    )
    .map((entry) => entry.adapter.name as string);

  /**
   * Select-then-connect, spanning a render **on purpose**: the context only
   * resolves the selected wallet on the next render, so calling `connect()`
   * in the same tick would throw `WalletNotSelectedError`. The pending name
   * bridges the two steps; every failure lands in the shared banner with a
   * specific message rather than an empty one.
   */
  const [pendingName, setPendingName] = useState<string | null>(null);
  const connectByName = useCallback(
    (name: string) => {
      setPendingName(name);
      // The context brands names as `WalletName`; every caller passes a name
      // taken from that same context's list, so the cast is sound.
      select(name as WalletName);
    },
    [select],
  );
  useEffect(() => {
    if (pendingName === null) return;
    if (wallet === null || wallet.adapter.name !== pendingName) return;
    setPendingName(null);
    void connect().catch((cause: unknown) => report(cause));
  }, [pendingName, wallet, connect, report]);

  return {
    /** Base58 address, or `null` when disconnected. */
    address: publicKey?.toBase58() ?? null,
    connected,
    connecting,
    connect,
    disconnect,
    /** Select a wallet by name, then connect to it across the next render. */
    connectByName,
    /** Names of connectable wallets detected in this browser (may be empty). */
    available,
    /** e.g. "Phantom" — shown so nobody approves a prompt without knowing from whom. */
    label: wallet?.adapter?.name ?? null,
  };
}

/** Where an action is. `idle` is the only state with no message to show. */
export type ActionStage =
  | "idle"
  | "preparing"
  | "awaiting_signature"
  | "submitting"
  | "confirming"
  | "success"
  | "error";

export interface ActionState {
  stage: ActionStage;
  signature: string | null;
  error: string | null;
}

/** Plain-language description of what the person is being asked to approve. */
const STAGE_TEXT: Partial<Record<ActionStage, string>> = {
  preparing: "Reading the agreement from Solana…",
  awaiting_signature: "Approve the request in your wallet to continue.",
  submitting: "Sending the transaction to Solana…",
  confirming: "Waiting for Solana devnet to confirm it…",
  success: "Done. The transaction is confirmed on chain.",
};

/**
 * The loading / success / error state machine, shared by every async action.
 *
 * `run` takes a function that returns the unsigned base64 transaction — the
 * caller fetches it from our own API, so the stages bracket exactly the two
 * things that can take time and both of which a person needs to see.
 *
 * `success` is reached only after confirmation, and `onSuccess` runs from inside
 * it, so refreshing the page (status is always re-read from chain, per Section
 * 6.2) cannot race the state that announced the result.
 */
export function useTransactionAction(onSuccess?: (signature: string) => void) {
  const wallet = useWallet();
  const connection = getBrowserConnection();
  const [state, setState] = useState<ActionState>({
    stage: "idle",
    signature: null,
    error: null,
  });

  const reset = useCallback(() => {
    setState({ stage: "idle", signature: null, error: null });
  }, []);

  const run = useCallback(
    async (build: () => Promise<string>) => {
      setState({ stage: "preparing", signature: null, error: null });
      try {
        const base64 = await build();

        setState({ stage: "awaiting_signature", signature: null, error: null });
        let signature: string;
        try {
          signature = await signAndSend(connection, wallet, base64, (stage) => {
            // Publish which half of the wait we are in. The state machine has
            // always advertised `submitting` and `confirming` but never entered
            // them, so the screen sat on "Approve the request in your wallet" for
            // the whole send-and-confirm — tens of seconds in which the app was
            // doing something the person could not see, and could not distinguish
            // from having given up (Section 9).
            setState({ stage, signature: null, error: null });
          });
        } catch (cause) {
          // A declined signature is not an error worth shouting about, and it
          // must not be reported as a failed transaction — nothing was sent.
          if (cause instanceof WalletError && cause.kind === "rejected") {
            setState({ stage: "idle", signature: null, error: cause.message });
            return null;
          }
          throw cause;
        }

        setState({ stage: "success", signature, error: null });
        onSuccess?.(signature);
        return signature;
      } catch (cause) {
        setState({
          stage: "error",
          signature: null,
          // Never `cause.message` verbatim: a wallet error with an empty
          // message would render a blank failure state (Phase 5a).
          error: describeWalletFailure(cause),
        });
        return null;
      }
    },
    [connection, wallet, onSuccess],
  );

  return {
    ...state,
    /** `true` while an action is in flight — the basis for every disabled state. */
    busy:
      state.stage !== "idle" && state.stage !== "success" && state.stage !== "error",
    /** What to show the person right now, or `null` when there is nothing to say. */
    message: STAGE_TEXT[state.stage] ?? null,
    run,
    reset,
  };
}
