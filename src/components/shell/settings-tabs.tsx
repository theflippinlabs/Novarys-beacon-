import { Tabs } from "@/components/ui";

export function SettingsTabs({ active }: { active: "org" | "integrations" | "health" | "audit" }) {
  return (
    <Tabs
      active={active}
      items={[
        { key: "org", label: "Organisation & members", href: "/settings" },
        { key: "integrations", label: "Integrations", href: "/settings/integrations" },
        { key: "health", label: "System health", href: "/settings/health" },
        { key: "audit", label: "Audit log", href: "/settings/audit" },
      ]}
    />
  );
}
