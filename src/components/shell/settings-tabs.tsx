import { Tabs } from "@/components/ui";
import { getT } from "@/i18n/server";

export async function SettingsTabs({ active }: { active: "org" | "integrations" | "notifications" | "health" | "audit" }) {
  const t = await getT();
  return (
    <Tabs
      active={active}
      items={[
        { key: "org", label: t("Organisation & members"), href: "/settings" },
        { key: "integrations", label: t("Integrations"), href: "/settings/integrations" },
        { key: "notifications", label: t("Notifications"), href: "/settings/notifications" },
        { key: "health", label: t("System health"), href: "/settings/health" },
        { key: "audit", label: t("Audit log"), href: "/settings/audit" },
      ]}
    />
  );
}
