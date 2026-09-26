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

import { useCallback, useState } from "react";
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

/** Wallet-adapter's own errors, flattened to the cases a person can act on. */
function asWalletError(cause: unknown): WalletError {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const lower = raw.toLowerCase();
  if (
    lower.includes("reject") ||
    lower.includes("declin") ||
    lower.includes("denied") ||
    lower.includes("cancel")
  ) {
    return new WalletError(
      "You declined the request in your wallet, so nothing was signed and no money moved.",
      "rejected",
    );
  }
  if (lower.includes("not found") || lower.includes("no wallet") || lower.includes("install")) {
    return new WalletError(
      "No Solana wallet is available in this browser. Install Phantom, or open this page inside a wallet's in-app browser.",
      "unavailable",
    );
  }
  if (lower.includes("blockhash") || lower.includes("expired")) {
    return new WalletError(
      "The transaction's blockhash expired before it landed — devnet was slow. Nothing moved; try again.",
      "send_failed",
    );
  }
  return new WalletError(raw, "send_failed");
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
  try {
    signature = await connection.sendRawTransaction(raw, { skipPreflight: false });
  } catch (cause) {
    throw asWalletError(cause);
  }

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
  const { publicKey, connected, connecting, connect, disconnect, wallet } = useWallet();
  return {
    /** Base58 address, or `null` when disconnected. */
    address: publicKey?.toBase58() ?? null,
    connected,
    connecting,
    connect,
    disconnect,
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
          signature = await signAndSend(connection, wallet, base64);
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
          error: cause instanceof Error ? cause.message : String(cause),
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
