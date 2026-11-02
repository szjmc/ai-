import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["*.e2b.app"],
  experimental: {
    proxyClientMaxBodySize: "60mb",
    serverActions: {
      bodySizeLimit: "60mb",
    },
  },
};

export default nextConfig;
