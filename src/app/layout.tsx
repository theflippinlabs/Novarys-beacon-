import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.BEACON_BASE_URL ?? "http://localhost:3000"),
  title: { default: "Novarys Beacon", template: "%s — Beacon" },
  description: "Build once. Be found everywhere. The distribution and discovery engine of the Novarys ecosystem.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
