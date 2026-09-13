import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["et", "en"],
  defaultLocale: "et",
  localePrefix: "always",
});
