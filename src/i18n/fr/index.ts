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
import { fr as p2sec } from "./p2sec";
import { fr as p2search } from "./p2search";
import { fr as p2measure } from "./p2measure";
import { fr as p2know } from "./p2know";
import { fr as p2content } from "./p2content";
import { fr as p2crawl } from "./p2crawl";
import { fr as p2intel } from "./p2intel";
import { fr as w2a } from "./w2a";
import { fr as w2b } from "./w2b";
import { fr as w2c } from "./w2c";
import { fr as w2d } from "./w2d";
import { fr as w3b } from "./w3b";

export const FR_AREAS = { common, shell, overview, products, knowledge, onboarding, discovery, queries, content, distribution, visibility, opportunities, conversions, referrals, revenue, autopilot, settings, publicPages, messages, media, agent, agentui, p2sec, p2search, p2measure, p2know, p2content, p2crawl, p2intel, w2a, w2b, w2c, w2d, w3b } as const;

export const FR: Readonly<Record<string, string>> = Object.freeze(Object.assign({}, ...Object.values(FR_AREAS)));
