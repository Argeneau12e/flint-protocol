import type { NextConfig } from "next";

/**
 * Flint app configuration.
 *
 * Devnet-only build (FLINT_BUILD_CONTEXT.md Sections 6.3 and 12) — nothing here
 * may reference a mainnet endpoint or key.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
