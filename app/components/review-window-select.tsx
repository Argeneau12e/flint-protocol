// File: app/components/review-window-select.tsx
"use client";

import { useId } from "react";

export interface ReviewWindowPreset {
  seconds: number;
  label: string;
}

const HINTS: Record<number, string> = {
  [6 * 3600]: "Fast turnaround",
  [12 * 3600]: "Same day",
  [24 * 3600]: "Recommended",
  [48 * 3600]: "Extra time",
};

export function ReviewWindowSelect({
  presets,
  value,
  onChange,
  disabled = false,
}: {
  presets: ReadonlyArray<ReviewWindowPreset>;
  value: number;
  onChange: (seconds: number) => void;
  disabled?: boolean;
}) {
  const name = useId();
  const selected = presets.find((preset) => preset.seconds === value);

  return (
    <div className="rw">
      <div role="radiogroup" aria-label="Review window" className="rw-grid">
        {presets.map((preset) => {
          const checked = preset.seconds === value;
          const id = `${name}-${preset.seconds}`;
          return (
            <label
              key={preset.seconds}
              htmlFor={id}
              className={`rw-card${checked ? " rw-card-on" : ""}${disabled ? " rw-card-off" : ""}`}
            >
              <input
                id={id}
                type="radio"
                name={name}
                className="rw-input"
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(preset.seconds)}
              />
              <span className="rw-title">{preset.label}</span>
              <span className="rw-hint">{HINTS[preset.seconds] ?? ""}</span>
              {checked ? (
                <svg
                  className="rw-check"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : null}
            </label>
          );
        })}
      </div>
      <p className="rw-note" aria-live="polite">
        {selected
          ? `After you mark the work delivered, the payer has ${selected.label} to review it or open a dispute. If they do neither, the funds are released to you automatically.`
          : ""}
      </p>
    </div>
  );
}