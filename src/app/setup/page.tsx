import type { Metadata } from "next";
import { SubmitButton } from "@/components/ui/submit-button";
import { redirect } from "next/navigation";
import { setupAction } from "@/app/actions/auth";
import { Field, Flash } from "@/components/ui";
import { hasAnyUser } from "@/lib/auth/service";
import { AuthFrame } from "@/components/shell/auth-frame";
import { getI18n, getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Set up") };
}

export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (await hasAnyUser()) redirect("/login");
  const sp = await searchParams;
  const { t } = await getI18n();
  return (
    <AuthFrame subtitle={t("First run: create your organisation and owner account. This page disappears once an account exists.")}>
      <Flash searchParams={sp} />
      <form action={setupAction} className="flex flex-col gap-4">
        {process.env.BEACON_SETUP_TOKEN && (
          <Field label={t("Setup token")} hint={t("One-time token from the deployment environment (BEACON_SETUP_TOKEN).")}>
            <input name="setupToken" type="password" required autoComplete="off" defaultValue={typeof sp.token === "string" ? sp.token : ""} />
          </Field>
        )}
        <Field label={t("Organisation")}>
          <input name="orgName" required defaultValue="Novarys" maxLength={80} />
        </Field>
        <Field label={t("Your name")}>
          <input name="name" required maxLength={120} />
        </Field>
        <Field label={t("Email")}>
          <input name="email" type="email" required autoComplete="username" />
        </Field>
        <Field label={t("Password")} hint={t("At least 12 characters, mixing letters with digits or symbols.")}>
          <input name="password" type="password" required minLength={12} autoComplete="new-password" />
        </Field>
        <div className="pt-2">
          <SubmitButton>{t("Create workspace →")}</SubmitButton>
        </div>
      </form>
    </AuthFrame>
  );
}
