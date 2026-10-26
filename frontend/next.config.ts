import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The end-to-end suite builds into its own directory so it never collides with a running dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  agentRules: false,
  experimental: {
    // Default is 30s. Coach replies can take minutes; keep this above the
    // API's overall Anthropic cap (default 15 min) so the proxy never drops first.
    proxyTimeout: Number(process.env.FRONTEND_PROXY_TIMEOUT_MS) || 960_000,
  },
  async rewrites() {
    const apiUrl =
      process.env.API_SERVICE_URL ||
      (process.env.NODE_ENV === "production"
        ? "http://api:5001"
        : "http://localhost:5002");

    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
