import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";
import { I18nProvider } from "@/i18n/client";
import { getLocale, getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    metadataBase: new URL(process.env.BEACON_BASE_URL ?? "http://localhost:3000"),
    title: { default: "Novarys Beacon", template: "%s | Beacon" },
    description: t("Build once. Be found everywhere. The distribution and discovery engine of the Novarys ecosystem."),
    robots: { index: false, follow: false },
    appleWebApp: { capable: true, title: "Beacon", statusBarStyle: "black-translucent" },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#04060c",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen">
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
