import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lint runs separately via `npm run lint`; keeps builds independent of lint config details.
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Native/compiled packages used by the server-side builder run from node_modules directly
  // (never through webpack): esbuild/postcss/tailwindcss are system build tooling, not app code.
  serverExternalPackages: ["esbuild", "postcss", "autoprefixer", "tailwindcss"],
};

export default nextConfig;
