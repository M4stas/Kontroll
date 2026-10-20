import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfjs-dist"],
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  async headers() {
    return [{ source: "/sw.js", headers: [
      { key: "Cache-Control", value: "no-cache" },
      { key: "Service-Worker-Allowed", value: "/" },
    ] }];
  },
  async redirects() {
    return [{ source: "/", destination: "/et", permanent: false }];
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
