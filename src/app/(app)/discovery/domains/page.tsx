import type { Metadata } from "next";
import Link from "next/link";
import { addDomainAction, removeDomainAction, verifyDomainAction } from "@/app/actions/seo";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel } from "@/components/ui";
import { VERIFICATION_FILE_PATH, VERIFICATION_TXT_PREFIX } from "@/core/seo/domains";
import { getI18n, getT } from "@/i18n/server";
import { pageData, type SP } from "@/lib/page";
import { listDomains } from "@/services/domains";
import { AUDIT_RATE_LIMIT_PER_HOUR } from "@/services/seo";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Verified domains") };
}

const BACK = "/discovery/domains";

export default async function DomainsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t } = await getI18n();
  const { data, can } = await pageData(async (tx, ctx) => ({ domains: await listDomains(tx, ctx.org.id) }));
  const manage = can("settings:manage");
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : t("n/a"));
  return (
    <>
      <PageHeader
        eyebrow={t("03 / Discovery")}
        title={t("Verified domains")}
        description={t("Beacon only crawls sites you prove you control. Verify a domain once (DNS TXT record or a file on the site); its subdomains are covered too. Audits are limited to {n} per hour per workspace and one running audit per product.", { n: AUDIT_RATE_LIMIT_PER_HOUR })}
        actions={
          <Link className="eyebrow hover:text-chrome" href="/discovery">
            {t("← Discovery")}
          </Link>
        }
      />
      <Flash searchParams={sp} />
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-4">
          {data.domains.map((d) => (
            <Panel
              key={d.id}
              title={<span id={`d-${d.id}`}>{d.domain}</span>}
              eyebrow={d.verifiedAt ? t("Verified") : t("Not verified yet")}
              actions={d.verifiedAt ? <Badge tone="ok">✓ {t("Verified")}</Badge> : <Badge tone="warn">{t("Pending")}</Badge>}
            >
              {d.verifiedAt ? (
                <p className="text-xs text-chrome">
                  {t("Verified on {date} by {method}. Last checked {checked}.", { date: day(d.verifiedAt), method: d.method === "DNS_TXT" ? t("DNS TXT record") : t("verification file"), checked: day(d.lastCheckedAt) })}
                </p>
              ) : (
                <ol className="flex list-decimal flex-col gap-3 pl-5 text-xs text-chrome">
                  <li>
                    {t("Either add this DNS TXT record to {domain}:", { domain: d.domain })}
                    <code className="mt-1 block break-all border border-line bg-obsidian px-2 py-1 font-mono text-[11px] text-platinum">
                      {VERIFICATION_TXT_PREFIX}
                      {d.token}
                    </code>
                  </li>
                  <li>
                    {t("Or publish a text file at {url} containing only the token:", { url: `https://${d.domain}${VERIFICATION_FILE_PATH}` })}
                    <code className="mt-1 block break-all border border-line bg-obsidian px-2 py-1 font-mono text-[11px] text-platinum">{d.token}</code>
                  </li>
                  <li>{t("Then choose Verify now. DNS changes can take a while to propagate.")}</li>
                </ol>
              )}
              {d.lastError && <p className="mt-3 break-words text-xs text-warn">{t("Last check failed: {error}", { error: d.lastError })}</p>}
              {manage && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <form action={verifyDomainAction}>
                    <HiddenBack path={BACK} />
                    <input type="hidden" name="id" value={d.id} />
                    <Button variant={d.verifiedAt ? "ghost" : "gold"}>{d.verifiedAt ? t("Check again") : t("Verify now")}</Button>
                  </form>
                  <form action={removeDomainAction}>
                    <HiddenBack path={BACK} />
                    <input type="hidden" name="id" value={d.id} />
                    <Button variant="danger">{t("Remove")}</Button>
                  </form>
                </div>
              )}
            </Panel>
          ))}
          {!data.domains.length && <EmptyState variant="not_connected" what={t("No domains yet")} why={t("Add the domain of a product site to audit it.")} action={{ label: t("Add a domain"), href: "#add-domain" }} />}
        </div>
        <Panel title={<span id="add-domain">{t("Add a domain")}</span>} eyebrow={t("Ownership")}>
          {manage ? (
            <form action={addDomainAction} className="flex flex-col gap-3">
              <HiddenBack path={BACK} />
              <Field label={t("Domain")} hint={t("For example example.com. Verifying example.com also covers www.example.com and other subdomains.")}>
                <input name="domain" required placeholder="example.com" autoComplete="off" />
              </Field>
              <div>
                <Button variant="gold">{t("Add domain")}</Button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-muted">{t("Admin role required to manage domains.")}</p>
          )}
          <p className="mt-4 border-t border-line pt-3 text-[11px] text-muted">{t("Local development only: with BEACON_SSRF_ALLOW_PRIVATE=true outside production, localhost and private-network fixture sites can be audited without verification.")}</p>
        </Panel>
      </div>
    </>
  );
}
