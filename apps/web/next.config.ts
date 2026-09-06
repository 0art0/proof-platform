import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The CLI subprocess loses captured stdout in this repository's managed
  // Node environment. The compiler API performs the same build-time check.
  experimental: {
    useTypeScriptCli: false,
  },
};

export default nextConfig;
