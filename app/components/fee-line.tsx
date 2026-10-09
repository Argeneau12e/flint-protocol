/**
 * Fee lines for the payment pages (Task 3), part 2.
 *
 * The fee line (fee, and what the recipient receives) comes from
 * `lib/fees.ts`. Tooltips explain both terms; amounts render through the same
 * formatter as the rest of the page.
 */

"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { feeForShare, feeBaseUnits } from "@/lib/fees";
import { formatBaseUnits } from "@/lib/display";

export function FeeLine({
  amountBaseUnits,
  feeBaseUnitsRaw,
  decimals,
  symbol,
}: {
  amountBaseUnits: string;
  feeBaseUnitsRaw: string;
  decimals: number;
  symbol: string;
}) {
  const feeDisplay = formatBaseUnits(feeBaseUnitsRaw, decimals);
  let netDisplay: string;
  try {
    const net = BigInt(amountBaseUnits) - BigInt(feeBaseUnitsRaw);
    netDisplay = formatBaseUnits(net.toString(), decimals);
  } catch {
    netDisplay = "—";
  }
  return (
    <p className="flint-muted" style={{ fontSize: "var(--flint-text-sm)" }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span style={{ textDecoration: "underline dotted" }}>
            Fee {feeDisplay} {symbol}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          The protocol fee is taken from the recipient payout, so the payer
          always pays exactly the agreed amount.
        </TooltipContent>
      </Tooltip>
      {" — recipient receives "}
      <span style={{ fontFamily: "var(--flint-font-mono)" }}>
        {netDisplay} {symbol}
      </span>
    </p>
  );
}

/** The fee line for a 50/50 split: fee follows the recipient share. */
export function SplitFeeLine({
  feeBaseUnitsRaw,
  decimals,
  symbol,
}: {
  feeBaseUnitsRaw: string;
  decimals: number;
  symbol: string;
}) {
  let shareFee = "—";
  try {
    shareFee = formatBaseUnits(
      feeForShare(BigInt(feeBaseUnitsRaw), 5000).toString(),
      decimals,
    );
  } catch {
    shareFee = "—";
  }
  return (
    <span className="flint-muted" style={{ fontSize: "var(--flint-text-sm)" }}>
      Fee on the recipient half: {shareFee} {symbol} (refunds are never charged).
    </span>
  );
}

export function feeBaseUnitsOrNull(
  amountBaseUnits: string,
  decimals: number,
): string | null {
  try {
    return feeBaseUnits(BigInt(amountBaseUnits), decimals).toString();
  } catch {
    return null;
  }
}
