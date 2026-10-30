import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    proxyClientMaxBodySize: "60mb",
    serverActions: {
      bodySizeLimit: "60mb",
    },
  },
};

export default nextConfig;
