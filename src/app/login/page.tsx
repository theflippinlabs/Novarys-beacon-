import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { loginAction } from "@/app/actions/auth";
import { Button, Field, Flash } from "@/components/ui";
import { getAuthContext } from "@/lib/auth/session";
import { hasAnyUser } from "@/lib/auth/service";
import { AuthFrame } from "@/components/shell/auth-frame";
import { getI18n, getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Sign in") };
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (await getAuthContext()) redirect("/");
  if (!(await hasAnyUser())) redirect("/setup");
  const sp = await searchParams;
  const { t } = await getI18n();
  return (
    <AuthFrame subtitle={t("Sign in to the control tower.")}>
      <Flash searchParams={sp} />
      <form action={loginAction} className="flex flex-col gap-4">
        <Field label={t("Email")}>
          <input name="email" type="email" autoComplete="username" required />
        </Field>
        <Field label={t("Password")}>
          <input name="password" type="password" autoComplete="current-password" required />
        </Field>
        <div className="flex flex-wrap items-center gap-4 pt-2">
          <Button variant="gold">{t("Sign in →")}</Button>
          <Link href="/recover" className="eyebrow hover:text-chrome">
            {t("Forgot your password?")}
          </Link>
        </div>
      </form>
    </AuthFrame>
  );
}
