import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Extra hosts allowed to load the dev server, such as a Tailscale name. Set per machine in .env.local.
const extraDevOrigins = (process.env.DEV_ALLOWED_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean);

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfjs-dist"],
  allowedDevOrigins: ["localhost", "127.0.0.1", ...extraDevOrigins],
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
