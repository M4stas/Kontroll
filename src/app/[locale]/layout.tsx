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

  return (
    <html lang={language}>
      <body>{children}</body>
    </html>
  );
}
