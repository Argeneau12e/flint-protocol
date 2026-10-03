import { assetDisplay } from "@/lib/display";

/**
 * An asset's display label, its deployment badge, and the full explanation.
 *
 * Small on purpose: every place that would have rendered a raw symbol renders
 * this instead. The badge is textual ("devnet"), never colour alone, and the
 * tooltip carries the whole sentence for a hover — or, via `title`, for a
 * screen reader.
 */
export function AssetLabel({ symbol }: { symbol: string }) {
  const asset = assetDisplay(symbol);
  return (
    <span title={asset.tooltip ?? undefined}>
      {asset.label}
      {asset.badge === null ? null : (
        <span className="flint-badge">{asset.badge}</span>
      )}
    </span>
  );
}
