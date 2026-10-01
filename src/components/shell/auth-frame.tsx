import Image from "next/image";
import { LocaleToggle } from "@/components/shell/locale-toggle";
import { getT } from "@/i18n/server";

export async function AuthFrame({ children, subtitle }: { children: React.ReactNode; subtitle: string }) {
  const t = await getT();
  return (
    <main className="grid min-h-screen grid-cols-1 lg:grid-cols-[1.1fr_1fr]">
      <section className="grid-bg relative hidden flex-col justify-between border-r border-line p-12 lg:flex">
        <div className="eyebrow text-gold">Novarys / Beacon</div>
        <Image src="/brand/beacon-logo.webp" alt="Novarys Beacon" width={1200} height={675} priority className="h-auto w-full max-w-lg" />
        <div>
          <div className="mb-6 h-px w-24 bg-gradient-to-r from-blue-bright via-gold to-transparent" />
          <h1 className="max-w-md text-5xl font-semibold leading-[1.05] tracking-tight">
            {t("Build once.")}
            <br />
            <span className="text-chrome">{t("Be found everywhere.")}</span>
          </h1>
          <p className="mt-6 max-w-md text-sm text-muted">{t("Distribution, discovery and growth infrastructure for the Novarys ecosystem. Measured, factual, accountable.")}</p>
        </div>
        <div className="eyebrow">{t("Discovery · Measurement · Distribution · Autopilot")}</div>
      </section>
      <section className="relative flex items-center justify-center px-6 pb-6 pt-16">
        <LocaleToggle className="absolute right-4 top-4 sm:right-6 sm:top-6" />
        <div className="w-full max-w-sm">
          <Image src="/brand/beacon-logo.webp" alt="Novarys Beacon" width={1200} height={675} priority className="mb-6 h-auto w-64 lg:hidden" />
          <h2 className="mb-1 text-xl font-semibold">Beacon</h2>
          <p className="mb-8 text-sm text-chrome">{subtitle}</p>
          {children}
        </div>
      </section>
    </main>
  );
}
