import { pageData } from "@/lib/page";
import { latestBriefing } from "@/services/briefings";
import { BriefingPanel } from "./briefing";

/** The latest stored briefing at the top of the command center (loads its own data). */
export async function LatestBriefing() {
  const { data, can } = await pageData((tx, ctx) => latestBriefing(tx, ctx.org.id));
  return <BriefingPanel briefing={data} canRun={can("job:run")} />;
}
