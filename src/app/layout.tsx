import type { Metadata } from "next";
import type { ReactNode } from "react";

import { APP_NAME } from "@/config/app";

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
      <body>{children}</body>
    </html>
  );
}
