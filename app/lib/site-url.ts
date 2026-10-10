/**
 * The site's absolute origin for metadata and link-preview images.
 *
 * NEXT_PUBLIC_SITE_URL when set (production: set after the first deploy, then
 * redeploy); the platform-provided VERCEL_URL otherwise; empty when neither
 * exists (local builds). Empty is honest, not a fallback domain.
 */

/** Absolute origin with protocol, or "" when it cannot be known. */
export function siteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured !== undefined && configured !== "") {
    return configured.replace(/\/+$/, "");
  }
  const vercel = process.env.VERCEL_URL;
  if (vercel !== undefined && vercel !== "") {
    return `https://${vercel.replace(/\/+$/, "")}`;
  }
  return "";
}

/** The host part of the origin, or null when the origin is unknown. */
export function siteHost(): string | null {
  const origin = siteOrigin();
  if (origin === "") return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}
