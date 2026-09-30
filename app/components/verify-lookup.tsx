/**
 * The signature lookup form behind `/verify` (Phase 5a).
 *
 * Validates on submit only — an untouched empty field has nothing to complain
 * about — and never navigates on a malformed value: the error explains the
 * exact shape expected, so the fix is obvious instead of a 404 waiting at the
 * end of the route.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SIGNATURE_SHAPE_HINT, isTransactionSignature } from "@/lib/signature";

export function VerifyLookupForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flint-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const tx = value.trim();
        if (!isTransactionSignature(tx)) {
          setError(`That does not look like a transaction signature. ${SIGNATURE_SHAPE_HINT}`);
          return;
        }
        setError(null);
        router.push(`/verify/${encodeURIComponent(tx)}`);
      }}
    >
      <div className="flint-field">
        <label htmlFor="tx-signature" className="flint-label">
          Transaction signature
        </label>
        <p className="flint-hint" id="tx-signature-hint">
          {SIGNATURE_SHAPE_HINT}
        </p>
        <input
          id="tx-signature"
          name="tx"
          className="flint-input flint-num"
          value={value}
          inputMode="text"
          spellCheck={false}
          autoComplete="off"
          maxLength={128}
          placeholder="5jwQ…"
          onChange={(event) => {
            setValue(event.target.value);
            if (error !== null) setError(null);
          }}
          aria-describedby="tx-signature-hint"
          aria-invalid={error !== null}
        />
      </div>
      {error === null ? null : (
        <p role="alert" className="flint-error-text">
          {error}
        </p>
      )}
      <div>
        <button type="submit" className="flint-button flint-primary">
          Verify this receipt
        </button>
      </div>
    </form>
  );
}
