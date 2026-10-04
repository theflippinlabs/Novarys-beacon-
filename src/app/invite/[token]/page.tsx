import type { Metadata } from "next";
import { SubmitButton } from "@/components/ui/submit-button";
import Link from "next/link";
import { acceptInvitationAction } from "@/app/actions/invite";
import { Field, Flash } from "@/components/ui";
import { AuthFrame } from "@/components/shell/auth-frame";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import { pageRateLimited } from "@/lib/http";
import { invitationByToken } from "@/services/invitations";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Accept invitation"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/**
 * Invitation landing page. The invitee either sets their own password (new
 * account) or signs in with an existing Beacon account. The page never says
 * which of the two applies to the invited address.
 */
export default async function InvitePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const sp = await searchParams;
  const { t } = await getI18n();
  const limited = await pageRateLimited("invite-page", 60, 900);
  const found = limited ? null : await invitationByToken(token);
  if (!found) {
    return (
      <AuthFrame subtitle={t("Accept invitation")}>
        <p role="alert" className="rounded-xl border border-crit/50 px-4 py-3 text-sm text-crit">
          {limited ? t("Too many requests. Try again in a minute.") : t("This invitation is invalid or has expired. Ask an administrator for a new one.")}
        </p>
        <Link href="/login" className="mt-6 inline-block text-sm text-blue-bright underline">
          {t("Go to sign in")}
        </Link>
      </AuthFrame>
    );
  }
  const signin = sp.mode === "signin";
  const { invitation, orgName } = found;
  return (
    <AuthFrame subtitle={t("You are invited to join {org} as {role}.", { org: orgName, role: enumLabel(t, invitation.role).toLowerCase() })}>
      <Flash searchParams={sp} />
      <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl border border-line p-1 text-center text-xs" role="tablist" aria-label={t("Account")}>
        <Link role="tab" aria-selected={!signin} href={`/invite/${token}`} className={`rounded-lg px-2 py-2 ${!signin ? "bg-blue/15 text-platinum" : "text-muted hover:text-chrome"}`}>
          {t("New to Beacon")}
        </Link>
        <Link role="tab" aria-selected={signin} href={`/invite/${token}?mode=signin`} className={`rounded-lg px-2 py-2 ${signin ? "bg-blue/15 text-platinum" : "text-muted hover:text-chrome"}`}>
          {t("I already have an account")}
        </Link>
      </div>
      <form action={acceptInvitationAction} className="flex flex-col gap-4">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="mode" value={signin ? "signin" : "create"} />
        <Field label={t("Email")}>
          <input name="email" type="email" value={invitation.email} readOnly autoComplete="username" />
        </Field>
        {signin ? (
          <Field label={t("Password")}>
            <input name="password" type="password" autoComplete="current-password" required />
          </Field>
        ) : (
          <>
            <Field label={t("Your name")}>
              <input name="name" autoComplete="name" required maxLength={120} />
            </Field>
            <Field label={t("Choose a password")} hint={t("At least 12 characters, mixing letters with digits or symbols.")}>
              <input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} />
            </Field>
            <Field label={t("Confirm the password")}>
              <input name="confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={256} />
            </Field>
          </>
        )}
        <div className="pt-2">
          <SubmitButton>{signin ? t("Sign in and accept →") : t("Create my account and accept →")}</SubmitButton>
        </div>
      </form>
    </AuthFrame>
  );
}
