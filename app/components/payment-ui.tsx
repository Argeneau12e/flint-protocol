/**
 * Shared payment-request UI pieces (Task 3), part 1.
 *
 * Presentational only: a status pill per FLINT_DESIGN.md Section 3, a
 * middle-truncated mono value with a copy button, and a live countdown with
 * aria-live. All state comes from `useAgreement` via props.
 */

"use client";

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { DerivedAgreementState } from "@/lib/agreement-state";

const STATUS_STYLE: Record<DerivedAgreementState, { dot: string; label: string }> = {
  awaiting_payment: { dot: "var(--text-muted)", label: "Awaiting payment" },
  funded: { dot: "var(--peach)", label: "Funded" },
  delivered_in_review: { dot: "var(--accent)", label: "Delivered, in review" },
  disputed: { dot: "var(--danger)", label: "Disputed" },
  released: { dot: "var(--success)", label: "Released" },
  refunded: { dot: "var(--info)", label: "Refunded" },
  expired: { dot: "var(--text-faint)", label: "Expired" },
  cancelled: { dot: "var(--text-faint)", label: "Cancelled" },
};

export function StatusPill({ state }: { state: DerivedAgreementState }) {
  const style = STATUS_STYLE[state];
  return (
    <span
      role="status"
      aria-live="polite"
      className="flint-status-pill"
      data-state={state}
    >
      <span
        aria-hidden="true"
        className="flint-status-dot"
        style={{ backgroundColor: style.dot }}
      />
      {style.label}
    </span>
  );
}

/** Middle-truncated mono value with a copy button. */
export function MonoValue({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const short =
    value.length <= 16 ? value : `${value.slice(0, 6)}...${value.slice(-6)}`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <code
        title={value}
        aria-label={`${label}: ${value}`}
        style={{ fontFamily: "var(--flint-font-mono)", fontSize: "0.85em" }}
      >
        {short}
      </code>
      <button
        type="button"
        className="flint-copy-btn"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(value)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => setCopied(false));
        }}
      >
        {copied ? <CheckIcon strokeWidth={1.5} size={14} /> : <CopyIcon strokeWidth={1.5} size={14} />}
      </button>
      <span role="status" className="flint-hint" style={{ fontSize: 12 }}>
        {copied ? "Copied." : ""}
      </span>
    </span>
  );
}

function partsUntil(target: number, now: number): string {
  const left = Math.max(0, target - now);
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  const seconds = left % 60;
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Live countdown to a unix timestamp, announced politely. */
export function Countdown({
  target,
  prefix,
}: {
  target: number;
  prefix: string;
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const ended = now >= target;
  return (
    <span
      role="timer"
      aria-live="polite"
      style={{ fontFamily: "var(--flint-font-mono)", fontVariantNumeric: "tabular-nums" }}
    >
      {ended ? `${prefix} reached` : `${prefix} ${partsUntil(target, now)}`}
    </span>
  );
}
