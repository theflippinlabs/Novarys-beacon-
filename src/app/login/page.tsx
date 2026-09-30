import { redirect } from "next/navigation";
import { loginAction } from "@/app/actions/auth";
import { Button, Field, Flash } from "@/components/ui";
import { getAuthContext } from "@/lib/auth/session";
import { hasAnyUser } from "@/lib/auth/service";
import { AuthFrame } from "@/components/shell/auth-frame";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (await getAuthContext()) redirect("/");
  if (!(await hasAnyUser())) redirect("/setup");
  const sp = await searchParams;
  return (
    <AuthFrame subtitle="Sign in to the control tower.">
      <Flash searchParams={sp} />
      <form action={loginAction} className="flex flex-col gap-4">
        <Field label="Email">
          <input name="email" type="email" autoComplete="username" required />
        </Field>
        <Field label="Password">
          <input name="password" type="password" autoComplete="current-password" required />
        </Field>
        <div className="pt-2">
          <Button variant="gold">Sign in →</Button>
        </div>
      </form>
    </AuthFrame>
  );
}
