import type { NextConfig } from "next";
import { resolve } from "node:path";

/**
 * Flint app configuration.
 *
 * Devnet-only build (FLINT_BUILD_CONTEXT.md Sections 6.3 and 12) — nothing here
 * may reference a mainnet endpoint or key.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The repo root owns the lockfile; pointing turbopack at it keeps the
  // workspace warning quiet without changing what gets built.
  turbopack: {
    root: resolve(__dirname, ".."),
  },
};

export default nextConfig;
