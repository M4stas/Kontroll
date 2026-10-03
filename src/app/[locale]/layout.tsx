import { NextIntlClientProvider } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import type { Locale } from "@/features/listing/messages";
import "./globals.css";

export const metadata = {
  title: "Kontroll",
  description: "Auto24 listing information for your next viewing.",
};

export default async function LocaleRootLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (locale !== "et" && locale !== "en") notFound();
  const language: Locale = locale;
  setRequestLocale(language);
  const messages = (await import(`../../../messages/${language}.json`)).default;

  return (
    <html lang={language}>
      <body><NextIntlClientProvider locale={language} messages={messages} timeZone="Europe/Tallinn">{children}</NextIntlClientProvider></body>
    </html>
  );
}
