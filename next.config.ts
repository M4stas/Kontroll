import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  async redirects() {
    return [{ source: "/", destination: "/et", permanent: false }];
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
