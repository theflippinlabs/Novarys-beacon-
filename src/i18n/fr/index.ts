// French dictionaries, one file per area. Keys are the English source strings.
import { fr as common } from "./common";
import { fr as shell } from "./shell";
import { fr as overview } from "./overview";
import { fr as products } from "./products";
import { fr as knowledge } from "./knowledge";
import { fr as onboarding } from "./onboarding";
import { fr as discovery } from "./discovery";
import { fr as queries } from "./queries";
import { fr as content } from "./content";
import { fr as distribution } from "./distribution";
import { fr as visibility } from "./visibility";
import { fr as opportunities } from "./opportunities";
import { fr as conversions } from "./conversions";
import { fr as referrals } from "./referrals";
import { fr as revenue } from "./revenue";
import { fr as autopilot } from "./autopilot";
import { fr as settings } from "./settings";
import { fr as publicPages } from "./public";
import { fr as messages } from "./messages";
import { fr as media } from "./media";
import { fr as agent } from "./agent";
import { fr as agentui } from "./agentui";

export const FR_AREAS = { common, shell, overview, products, knowledge, onboarding, discovery, queries, content, distribution, visibility, opportunities, conversions, referrals, revenue, autopilot, settings, publicPages, messages, media, agent, agentui } as const;

export const FR: Readonly<Record<string, string>> = Object.freeze(Object.assign({}, ...Object.values(FR_AREAS)));
