/**
 * The x402 wire protocol, as used by this build (Sections 6.1, 6.2).
 *
 * Scope note, stated plainly because it is a real decision and not an oversight:
 * **Flint does not use an x402 facilitator.** A facilitator verifies and settles
 * a payment for the resource server; there is no public devnet one for Solana, and
 * standing one up means running another service (Section 8 keeps self-hosted
 * infrastructure out of this build).
 *
 * So the *envelope* is x402's — `402 Payment Required`, an `accepts[]` array, and
 * the `X-PAYMENT` header on the retry — because that is what an agent negotiates
 * against, while the *settlement* is FRS-1: an escrow agreement funded through the
 * same program the human flow uses. Verification recomputes the agreement from the
 * chain (Section 6.2; threat-model row 7), which beats trusting a facilitator's
 * word about a payment.
 *
 * The facilitator slot is a documented seam: if a Solana facilitator appears, it
 * can be added without changing the wire format or the escrow flow.
 */

/** x402 protocol version this responder speaks. */
export const X402_VERSION = 1;

/** The `error` value in a 402 body, per x402. */
export const X402_ERROR_PAYMENT_REQUIRED = "payment_required";

/** The payment scheme: what is required of a payer is funding an FRS-1 agreement. */
export const X402_SCHEME = "flint-escrow-v1";

/** The network identifier for devnet. */
export const X402_NETWORK = "solana-devnet";

/** Headers: the payer announces payment on the retry; the responder answers. */
export const X_PAYMENT_HEADER = "x-payment";
export const X_PAYMENT_RESPONSE_HEADER = "x-payment-response";

/** The `accepts[]` entry of a 402 body. */
export interface X402PaymentRequirement {
  scheme: string;
  network: string;
  /** Base units, as a decimal string (Section 4.5: never a JS number). */
  maxAmountRequired: string;
  asset: { address: string; decimals?: number };
  /** The recipient wallet that will be paid. */
  payTo: string;
  resource: string;
  description: string;
  mimeType: string;
  /** How long the payer has to settle before the agreement expires. */
  maxTimeoutSeconds: number;
  /**
   * x402's extension point, and where the FRS-1 agreement object lives. The agent
   * reads the agreement from here; nothing else in the envelope is needed to pay.
   */
  extra: {
    protocol: "FRS-1";
    agreementPda: string;
    agreement: Frs1AgreementLike;
  };
}

/** Structural copy of `Frs1Agreement` — see `frs1-types` for the full type. */
type Frs1AgreementLike = import("./frs1-types").Frs1Agreement;

/** The 402 body. */
export interface X402PaymentRequiredBody {
  x402Version: number;
  error: string;
  accepts: X402PaymentRequirement[];
}

/** Builds the 402 body for a proposed agreement. */
export function buildPaymentRequired(options: {
  agreement: Frs1AgreementLike;
  agreementPda: string;
  resource: string;
  description: string;
  decimals?: number;
  /**
   * Chain time, from the Clock sysvar. The envelope's `maxTimeoutSeconds` is
   * derived from it rather than from the host clock, so the timeout a payer
   * reads is the timeout the program will honour (Section 4.5).
   */
  nowSeconds: number;
}): X402PaymentRequiredBody {
  const { agreement } = options;
  return {
    x402Version: X402_VERSION,
    error: X402_ERROR_PAYMENT_REQUIRED,
    accepts: [
      {
        scheme: X402_SCHEME,
        network: X402_NETWORK,
        maxAmountRequired: agreement.amount,
        asset: {
          address: agreement.asset,
          ...(options.decimals === undefined ? {} : { decimals: options.decimals }),
        },
        payTo: agreement.recipientAddress,
        resource: options.resource,
        description: options.description,
        mimeType: "application/json",
        maxTimeoutSeconds: Math.max(0, agreement.expiresAt - options.nowSeconds),
        extra: {
          protocol: "FRS-1",
          agreementPda: options.agreementPda,
          agreement,
        },
      },
    ],
  };
}

/**
 * What a payer puts in the `X-PAYMENT` header.
 *
 * The payload is *claims about* transactions, not proof: the responder re-derives
 * every one of them from the chain before serving anything (row 7). A payer that
 * invents a signature here gets a 402 back and a logged reason.
 */
export interface XPaymentPayload {
  agreementPda: string;
  /** The `fund` transaction: the payment itself. */
  fundingTx: string;
  /** The `release`/`refund` transaction, when the payer also settled. */
  settlementTx?: string;
}

/** Encodes a payload for the `X-PAYMENT` header (base64 JSON, per x402). */
export function encodeXPayment(payload: XPaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export type XPaymentDecode =
  | { ok: true; payload: XPaymentPayload }
  | { ok: false; error: string };

/**
 * Decodes an `X-PAYMENT` header, returning a structured failure instead of
 * throwing: a malformed header is a normal client error to answer with a 402 and
 * a reason, not a 500.
 */
export function decodeXPayment(header: string | null | undefined): XPaymentDecode {
  if (!header) {
    return { ok: false, error: `Missing ${X_PAYMENT_HEADER} header` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, error: `${X_PAYMENT_HEADER} is not base64-encoded JSON` };
  }
  const candidate = parsed as Partial<XPaymentPayload> | null;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.agreementPda !== "string" ||
    typeof candidate.fundingTx !== "string"
  ) {
    return {
      ok: false,
      error: `${X_PAYMENT_HEADER} must carry { agreementPda, fundingTx }`,
    };
  }
  if (candidate.settlementTx !== undefined && typeof candidate.settlementTx !== "string") {
    return { ok: false, error: `${X_PAYMENT_HEADER}.settlementTx must be a string` };
  }
  return { ok: true, payload: candidate as XPaymentPayload };
}
