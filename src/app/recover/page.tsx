import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { recoverAction } from "@/app/actions/auth";
import { Button, Field, Flash } from "@/components/ui";
import { getAuthContext } from "@/lib/auth/session";
import { AuthFrame } from "@/components/shell/auth-frame";
import { getI18n, getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Reset your password") };
}

/** Password recovery with a one-time code set by the operator on the server (BEACON_RECOVERY_TOKEN). */
export default async function RecoverPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (await getAuthContext()) redirect("/");
  const sp = await searchParams;
  const { t } = await getI18n();
  return (
    <AuthFrame subtitle={t("Reset your password with the recovery code your administrator gave you.")}>
      <Flash searchParams={sp} />
      <form action={recoverAction} className="flex flex-col gap-4">
        <Field label={t("Email")}>
          <input name="email" type="email" autoComplete="username" required />
        </Field>
        <Field label={t("Recovery code")}>
          <input name="token" type="text" autoComplete="one-time-code" autoCapitalize="off" spellCheck={false} required className="font-mono" />
        </Field>
        <Field label={t("New password")} hint={t("At least 12 characters, mixing letters with digits or symbols.")}>
          <input name="password" type="password" autoComplete="new-password" required minLength={12} />
        </Field>
        <Field label={t("Confirm the new password")}>
          <input name="confirm" type="password" autoComplete="new-password" required minLength={12} />
        </Field>
        <div className="flex flex-wrap items-center gap-4 pt-2">
          <Button variant="gold">{t("Set the new password →")}</Button>
          <Link href="/login" className="eyebrow hover:text-chrome">
            {t("← Back to sign in")}
          </Link>
        </div>
      </form>
    </AuthFrame>
  );
}
