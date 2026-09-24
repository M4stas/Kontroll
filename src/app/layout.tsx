import type { Metadata } from "next";
import type { ReactNode } from "react";

import { APP_NAME } from "@/config/app";
import { RegisterWorker } from "@/features/offline/register-worker";

import "./globals.css";

export const metadata: Metadata = {
  title: APP_NAME,
};

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="et">
      <body><RegisterWorker />{children}</body>
    </html>
  );
}
