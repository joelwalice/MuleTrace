import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false, // the floating dev badge covers the mobile tab bar
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
