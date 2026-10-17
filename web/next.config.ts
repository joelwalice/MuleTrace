import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false, // the floating dev badge covers the mobile tab bar
  distDir: process.env.NEXT_DIST_DIR || ".next", // test builds use their own folder, never the running dev server's
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
