import type { ReactNode } from "react";
import { desc, eq, sql } from "drizzle-orm";
import { addAffiliateAction, addCampaignAction, createReferralCodeAction, setCommissionStatusAction, toggleReferralCodeAction } from "@/app/actions/growth";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel, StatusBadge, Table, Td, Th, formatValue } from "@/components/ui";
import { affiliates, campaigns, channelEnum, commissions, products, referralCodes, revenueEvents } from "@/db/schema";
import { env } from "@/lib/env";
import { pageData, type SP } from "@/lib/page";

export const metadata = { title: "Referrals" };

const BACK = "/referrals";
const PIPELINE_DAYS = 90;

type Money = { currency: string; cents: number };

/** Groups `{ key, currency, cents }` rows into key → per-currency totals (amounts are never summed across currencies). */
function byKey(rows: { key: string; currency: string; cents: number | string }[]) {
  const m = new Map<string, Money[]>();
  for (const r of rows) m.set(r.key, [...(m.get(r.key) ?? []), { currency: r.currency, cents: Number(r.cents) }]);
  return m;
}

function MoneyList({ items }: { items?: Money[] }) {
  if (!items?.length) return <span className="text-muted">—</span>;
  return (
    <span className="flex flex-col">
      {items.map((x) => (
        <span key={x.currency}>{formatValue(x.cents, "money", x.currency)}</span>
      ))}
    </span>
  );
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export default async function ReferralsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { data, can } = await pageData(async (tx, ctx) => {
    const org = ctx.org.id;
    const now = new Date();
    const prods = await tx.select({ id: products.id, name: products.name, domain: products.domain }).from(products).where(eq(products.organizationId, org)).orderBy(products.name);
    const affs = await tx.select().from(affiliates).where(eq(affiliates.organizationId, org)).orderBy(affiliates.name);
    const camps = await tx
      .select({ c: campaigns, productName: products.name })
      .from(campaigns)
      .leftJoin(products, eq(products.id, campaigns.productId))
      .where(eq(campaigns.organizationId, org))
      .orderBy(desc(campaigns.createdAt));
    const codes = await tx
      .select({ rc: referralCodes, productName: products.name, affiliateName: affiliates.name, campaignName: campaigns.name })
      .from(referralCodes)
      .leftJoin(products, eq(products.id, referralCodes.productId))
      .leftJoin(affiliates, eq(affiliates.id, referralCodes.affiliateId))
      .leftJoin(campaigns, eq(campaigns.id, referralCodes.campaignId))
      .where(eq(referralCodes.organizationId, org))
      .orderBy(desc(referralCodes.createdAt));
    const comms = await tx
      .select({ c: commissions, affiliateName: affiliates.name, revenueType: revenueEvents.type, productName: products.name })
      .from(commissions)
      .innerJoin(affiliates, eq(affiliates.id, commissions.affiliateId))
      .leftJoin(revenueEvents, eq(revenueEvents.id, commissions.revenueEventId))
      .leftJoin(products, eq(products.id, revenueEvents.productId))
      .where(eq(commissions.organizationId, org))
      .orderBy(desc(commissions.createdAt))
      .limit(100);

    // Per-affiliate totals (per currency).
    const affRevenue = await tx.execute<{ key: string; currency: string; cents: string }>(sql`
      select rc.affiliate_id::text as key, r.currency, sum(r.amount_cents)::bigint as cents
      from revenue_events r join referral_codes rc on rc.id = r.referral_code_id
      where r.organization_id = ${org} and rc.organization_id = ${org} and rc.affiliate_id is not null
      group by 1, 2`);
    const affCommissions = await tx.execute<{ key: string; currency: string; cents: string }>(sql`
      select affiliate_id::text as key, currency, sum(amount_cents)::bigint as cents
      from commissions where organization_id = ${org} and status <> 'VOID'
      group by 1, 2`);

    // Per-code counts (all time).
    const visits = await tx.execute<{ id: string; n: number }>(sql`
      select referral_code_id::text as id, count(*)::int as n from attribution_events
      where organization_id = ${org} and referral_code_id is not null group by 1`);
    const signups = await tx.execute<{ id: string; n: number }>(sql`
      select referral_code_id::text as id, count(*)::int as n from conversion_events
      where organization_id = ${org} and type = 'SIGNUP' and referral_code_id is not null group by 1`);
    const purchases = await tx.execute<{ id: string; n: number }>(sql`
      select referral_code_id::text as id, count(*)::int as n from revenue_events
      where organization_id = ${org} and type = 'NEW' and referral_code_id is not null group by 1`);
    const recurring = await tx.execute<{ key: string; currency: string; cents: string }>(sql`
      select referral_code_id::text as key, currency, sum(amount_cents)::bigint as cents from revenue_events
      where organization_id = ${org} and type in ('RENEWAL', 'UPGRADE') and referral_code_id is not null group by 1, 2`);

    // Pipeline totals, last 90 days. Activation is credited when the ACTIVATED event carries a referral code
    // or belongs to an identity whose SIGNUP carried one.
    const pipe = (
      await tx.execute<{ visits: number; signups: number; activations: number; purchases: number }>(sql`
      select
        (select count(*) from attribution_events where organization_id = ${org} and referral_code_id is not null and occurred_at >= now() - make_interval(days => ${PIPELINE_DAYS}))::int as visits,
        (select count(*) from conversion_events where organization_id = ${org} and type = 'SIGNUP' and referral_code_id is not null and occurred_at >= now() - make_interval(days => ${PIPELINE_DAYS}))::int as signups,
        (select count(distinct coalesce(a.identity_id::text, a.visitor_id)) from conversion_events a
          where a.organization_id = ${org} and a.type = 'ACTIVATED' and a.occurred_at >= now() - make_interval(days => ${PIPELINE_DAYS})
            and (a.referral_code_id is not null or a.identity_id in (
              select s.identity_id from conversion_events s where s.organization_id = ${org} and s.type = 'SIGNUP' and s.referral_code_id is not null and s.identity_id is not null)))::int as activations,
        (select count(*) from revenue_events where organization_id = ${org} and type = 'NEW' and referral_code_id is not null and occurred_at >= now() - make_interval(days => ${PIPELINE_DAYS}))::int as purchases`)
    ).rows[0];
    const pipeRecurring = await tx.execute<{ currency: string; cents: string }>(sql`
      select currency, sum(amount_cents)::bigint as cents from revenue_events
      where organization_id = ${org} and type in ('RENEWAL', 'UPGRADE') and referral_code_id is not null and occurred_at >= now() - make_interval(days => ${PIPELINE_DAYS})
      group by 1 order by 1`);

    const counts = (rows: { id: string; n: number }[]) => new Map(rows.map((r) => [r.id, Number(r.n)]));
    return {
      now,
      prods,
      affs,
      camps,
      codes,
      comms,
      affRevenue: byKey(affRevenue.rows),
      affCommissions: byKey(affCommissions.rows),
      visits: counts(visits.rows),
      signups: counts(signups.rows),
      purchases: counts(purchases.rows),
      recurring: byKey(recurring.rows),
      pipe: { visits: Number(pipe?.visits ?? 0), signups: Number(pipe?.signups ?? 0), activations: Number(pipe?.activations ?? 0), purchases: Number(pipe?.purchases ?? 0), recurring: pipeRecurring.rows.map((r) => ({ currency: r.currency, cents: Number(r.cents) })) },
    };
  });

  const base = env().BEACON_BASE_URL.replace(/\/+$/, "");
  const canGrowth = can("growth:write");
  const canRevenue = can("revenue:write");
  const prodsWithDomain = data.prods.filter((p) => p.domain);

  const pipeline: { label: string; value: ReactNode }[] = [
    { label: "Visit", value: formatValue(data.pipe.visits) },
    { label: "Signup", value: formatValue(data.pipe.signups) },
    { label: "Activation", value: formatValue(data.pipe.activations) },
    { label: "Purchase", value: formatValue(data.pipe.purchases) },
    { label: "Recurring revenue", value: <MoneyList items={data.pipe.recurring} /> },
  ];

  return (
    <>
      <PageHeader
        eyebrow="10 / Referrals"
        title="Referral & affiliate engine"
        description="Tracked referral links, affiliates and their commissions. Commissions flagged by fraud heuristics are held for human review — never auto-voided, never paid before the hold period ends."
      />
      <Flash searchParams={sp} />

      <Panel eyebrow={`Pipeline · last ${PIPELINE_DAYS} days`} title="Referral & affiliate links → recurring revenue" className="mb-6">
        {data.codes.length ? (
          <>
            <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
              {pipeline.map((s, i) => (
                <li key={s.label} className="flex flex-col gap-1 border border-line bg-panel-2/40 p-3">
                  <span className="eyebrow">
                    {i > 0 && <span className="text-gold">→ </span>}
                    {s.label}
                  </span>
                  <span className="num text-xl text-platinum">{s.value}</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-[11px] text-muted">Visits = tracked /r/ link hits. Signups and purchases carry the referral code. Activation counts people whose signup came through a code. Recurring revenue = renewals + upgrades on referred subscriptions, per currency.</p>
          </>
        ) : (
          <EmptyState title="No referral links yet">Create a referral link below. Visits are recorded when someone opens {base}/r/CODE; signups, purchases and renewals are credited once your product sends lifecycle and revenue events.</EmptyState>
        )}
      </Panel>

      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel eyebrow="Referral links" title={`${data.codes.length} code${data.codes.length === 1 ? "" : "s"}`} pad={false}>
          {data.codes.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Link</Th>
                  <Th>Product / affiliate</Th>
                  <Th>Destination</Th>
                  <Th className="text-right">Visits</Th>
                  <Th className="text-right">Signups</Th>
                  <Th className="text-right">Purchases</Th>
                  <Th className="text-right">Recurring</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {data.codes.map(({ rc, productName, affiliateName, campaignName }) => (
                  <tr key={rc.id}>
                    <Td>
                      <div className="num text-xs text-platinum">{`${base}/r/${rc.code}`}</div>
                      {campaignName && <div className="text-[11px] text-muted">campaign · {campaignName}</div>}
                    </Td>
                    <Td className="text-xs">
                      {productName ?? "—"}
                      <div className="text-muted">{affiliateName ?? "Direct referral"}</div>
                    </Td>
                    <Td className="num max-w-56 truncate text-xs">
                      <span title={rc.destinationUrl}>{rc.destinationUrl}</span>
                    </Td>
                    <Td className="num text-right">{formatValue(data.visits.get(rc.id) ?? 0)}</Td>
                    <Td className="num text-right">{formatValue(data.signups.get(rc.id) ?? 0)}</Td>
                    <Td className="num text-right">{formatValue(data.purchases.get(rc.id) ?? 0)}</Td>
                    <Td className="num text-right text-xs">
                      <MoneyList items={data.recurring.get(rc.id)} />
                    </Td>
                    <Td>
                      <div className="flex flex-col items-start gap-1.5">
                        <StatusBadge status={rc.active ? "ACTIVE" : "ARCHIVED"} />
                        {canGrowth && (
                          <form action={toggleReferralCodeAction}>
                            <HiddenBack path={BACK} />
                            <input type="hidden" name="id" value={rc.id} />
                            <input type="hidden" name="active" value={rc.active ? "false" : "true"} />
                            <Button>{rc.active ? "Deactivate" : "Activate"}</Button>
                          </form>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="p-4 text-sm text-muted">No referral codes yet. Counts are all-time per code.</p>
          )}
        </Panel>

        {canGrowth && (
          <Panel eyebrow="Referral links" title="Create referral link">
            {prodsWithDomain.length ? (
              <form action={createReferralCodeAction} className="flex flex-col gap-3">
                <HiddenBack path={BACK} />
                <Field label="Product">
                  <select name="productId" required defaultValue={prodsWithDomain[0].id}>
                    {prodsWithDomain.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.domain})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Code" hint="Optional. 3–40 letters, digits, - or _. Generated when empty.">
                  <input name="code" pattern="[A-Za-z0-9_\-]{3,40}" maxLength={40} placeholder="SPRING-PARTNER" />
                </Field>
                <Field label="Affiliate" hint="Links owned by an affiliate are classified AFFILIATE and earn commission.">
                  <select name="affiliateId" defaultValue="">
                    <option value="">None (referral)</option>
                    {data.affs.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Destination URL" hint="Must be https on the selected product’s domain.">
                  <input name="destinationUrl" type="url" required pattern="https://.*" placeholder="https://example.com/signup" />
                </Field>
                <Field label="Campaign">
                  <select name="campaignId" defaultValue="">
                    <option value="">None</option>
                    {data.camps.map(({ c }) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <div>
                  <Button variant="gold">Create link</Button>
                </div>
              </form>
            ) : (
              <p className="text-sm text-muted">Set a domain on at least one product first — referral destinations must be on the product’s own domain.</p>
            )}
          </Panel>
        )}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel eyebrow="Affiliates" title={`${data.affs.length} affiliate${data.affs.length === 1 ? "" : "s"}`} pad={false}>
          {data.affs.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Commission</Th>
                  <Th className="text-right">Months</Th>
                  <Th className="text-right">Hold</Th>
                  <Th className="text-right">Attributed revenue</Th>
                  <Th className="text-right">Commissions</Th>
                </tr>
              </thead>
              <tbody>
                {data.affs.map((a) => (
                  <tr key={a.id}>
                    <Td className="text-platinum">{a.name}</Td>
                    <Td>
                      <StatusBadge status={a.status} />
                    </Td>
                    <Td className="num text-right">{(a.commissionBps / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}%</Td>
                    <Td className="num text-right">{a.commissionMonths}</Td>
                    <Td className="num text-right">{a.holdDays}d</Td>
                    <Td className="num text-right text-xs">
                      <MoneyList items={data.affRevenue.get(a.id)} />
                    </Td>
                    <Td className="num text-right text-xs">
                      <MoneyList items={data.affCommissions.get(a.id)} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <div className="p-4">
              <EmptyState title="No affiliates">Add an affiliate, then create a referral link owned by them. Revenue arriving through their links earns commission per their terms.</EmptyState>
            </div>
          )}
          <p className="border-t border-line px-4 py-2 text-[11px] text-muted">Attributed revenue: all revenue events carrying one of the affiliate’s codes. Commissions exclude VOID. Totals are per currency.</p>
        </Panel>

        {canRevenue && (
          <Panel eyebrow="Affiliates" title="Add affiliate">
            <form action={addAffiliateAction} className="flex flex-col gap-3">
              <HiddenBack path={BACK} />
              <Field label="Name">
                <input name="name" required minLength={2} maxLength={120} />
              </Field>
              <Field label="Contact email" hint="Stored only as a keyed hash (used for self-referral detection).">
                <input name="email" type="email" />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Commission %">
                  <input name="commissionPct" type="number" min={0} max={90} step="0.01" defaultValue={20} required />
                </Field>
                <Field label="Months">
                  <input name="commissionMonths" type="number" min={1} max={120} defaultValue={12} required />
                </Field>
                <Field label="Hold days">
                  <input name="holdDays" type="number" min={0} max={180} defaultValue={30} required />
                </Field>
              </div>
              <div>
                <Button variant="gold">Add affiliate</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>

      <Panel eyebrow="Commissions" title="Latest 100 commissions" className="mt-6" pad={false}>
        {data.comms.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Created</Th>
                <Th>Affiliate</Th>
                <Th>Revenue event</Th>
                <Th className="text-right">Amount</Th>
                <Th>Status</Th>
                <Th>Fraud flags</Th>
                <Th>Payable after</Th>
                {canRevenue && <Th>Actions</Th>}
              </tr>
            </thead>
            <tbody>
              {data.comms.map(({ c, affiliateName, revenueType, productName }) => {
                const inHold = c.payableAfter > data.now;
                const actions: { status: string; label: string; variant?: "gold" | "danger"; disabled?: boolean; title?: string }[] = [];
                if (c.status === "PENDING" || c.status === "ON_HOLD")
                  actions.push({ status: "APPROVED", label: "Approve", variant: "gold", disabled: inHold, title: inHold ? `Hold period ends ${day(c.payableAfter)}` : undefined });
                if (c.status === "PENDING" || c.status === "APPROVED") actions.push({ status: "ON_HOLD", label: "Hold" });
                if (c.status === "ON_HOLD") actions.push({ status: "PENDING", label: "Release" });
                if (c.status === "APPROVED") actions.push({ status: "PAID", label: "Mark paid", variant: "gold" });
                if (c.status !== "PAID" && c.status !== "VOID") actions.push({ status: "VOID", label: "Void", variant: "danger" });
                return (
                  <tr key={c.id}>
                    <Td className="num text-xs">{day(c.createdAt)}</Td>
                    <Td className="text-platinum">{affiliateName}</Td>
                    <Td className="text-xs">
                      {revenueType ?? "—"}
                      <div className="text-muted">{productName ?? ""}</div>
                    </Td>
                    <Td className="num text-right text-platinum">{formatValue(c.amountCents, "money", c.currency)}</Td>
                    <Td>
                      <StatusBadge status={c.status} />
                      {c.paidAt && <div className="num mt-1 text-[11px] text-muted">paid {day(c.paidAt)}</div>}
                    </Td>
                    <Td>
                      {c.fraudFlags.length ? (
                        <div className="flex flex-wrap gap-1">
                          {c.fraudFlags.map((fl) => (
                            <Badge key={fl} tone="warn">
                              {fl.replace(/_/g, " ")}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-muted">none</span>
                      )}
                    </Td>
                    <Td className={`num text-xs ${inHold ? "text-warn" : ""}`}>{day(c.payableAfter)}</Td>
                    {canRevenue && (
                      <Td>
                        {actions.length ? (
                          <form action={setCommissionStatusAction} className="flex flex-wrap gap-1.5">
                            <HiddenBack path={BACK} />
                            <input type="hidden" name="id" value={c.id} />
                            {actions.map((a) => (
                              <Button key={a.status} name="status" value={a.status} variant={a.variant} disabled={a.disabled} title={a.title}>
                                {a.label}
                              </Button>
                            ))}
                          </form>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <div className="p-4">
            <EmptyState title="No commissions yet">Commissions are created automatically when revenue events (Stripe webhook or /api/v1/revenue) arrive for a subscription acquired through an affiliate’s link.</EmptyState>
          </div>
        )}
      </Panel>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel eyebrow="Campaigns" title={`${data.camps.length} UTM campaign${data.camps.length === 1 ? "" : "s"}`} pad={false}>
          {data.camps.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Channel</Th>
                  <Th>utm_source / medium / campaign</Th>
                  <Th>Product</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {data.camps.map(({ c, productName }) => (
                  <tr key={c.id}>
                    <Td className="text-platinum">{c.name}</Td>
                    <Td>
                      <Badge>{c.channel.replace(/_/g, " ")}</Badge>
                    </Td>
                    <Td className="num text-xs">
                      {c.utmSource} / {c.utmMedium} / {c.utmCampaign}
                    </Td>
                    <Td className="text-xs">{productName ?? "Ecosystem"}</Td>
                    <Td>
                      <StatusBadge status={c.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="p-4 text-sm text-muted">No campaigns. Register UTM combinations so visits and conversions carrying them are linked to a named campaign.</p>
          )}
        </Panel>

        {canGrowth && (
          <Panel eyebrow="Campaigns" title="Add campaign">
            <form action={addCampaignAction} className="flex flex-col gap-3">
              <HiddenBack path={BACK} />
              <Field label="Name">
                <input name="name" required minLength={2} maxLength={120} />
              </Field>
              <Field label="Channel">
                <select name="channel" defaultValue="REFERRAL">
                  {channelEnum.enumValues.map((ch) => (
                    <option key={ch} value={ch}>
                      {ch.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="utm_source">
                <input name="utmSource" required maxLength={80} placeholder="partner-newsletter" />
              </Field>
              <Field label="utm_medium">
                <input name="utmMedium" required maxLength={80} placeholder="email" />
              </Field>
              <Field label="utm_campaign">
                <input name="utmCampaign" required maxLength={120} placeholder="spring-launch" />
              </Field>
              <Field label="Product">
                <select name="productId" defaultValue="">
                  <option value="">Ecosystem (no product)</option>
                  {data.prods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="text-[11px] text-muted">UTM values are stored lower-case.</p>
              <div>
                <Button variant="gold">Add campaign</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>
    </>
  );
}
