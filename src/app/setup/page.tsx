import { redirect } from "next/navigation";
import { setupAction } from "@/app/actions/auth";
import { Button, Field, Flash } from "@/components/ui";
import { hasAnyUser } from "@/lib/auth/service";
import { AuthFrame } from "@/components/shell/auth-frame";

export const metadata = { title: "Set up" };

export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (await hasAnyUser()) redirect("/login");
  const sp = await searchParams;
  return (
    <AuthFrame subtitle="First run: create your organisation and owner account. This page disappears once an account exists.">
      <Flash searchParams={sp} />
      <form action={setupAction} className="flex flex-col gap-4">
        <Field label="Organisation">
          <input name="orgName" required defaultValue="Novarys" maxLength={80} />
        </Field>
        <Field label="Your name">
          <input name="name" required maxLength={120} />
        </Field>
        <Field label="Email">
          <input name="email" type="email" required autoComplete="username" />
        </Field>
        <Field label="Password" hint="At least 12 characters, mixing letters with digits or symbols.">
          <input name="password" type="password" required minLength={12} autoComplete="new-password" />
        </Field>
        <div className="pt-2">
          <Button variant="gold">Create workspace →</Button>
        </div>
      </form>
    </AuthFrame>
  );
}
