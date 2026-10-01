export const fr: Record<string, string> = {
  // Wizard chrome
  "Onboarding · {name}": "Intégration guidée · {name}",
  "Describe the product once. Only enter facts you can stand behind; leave anything unknown blank — Beacon marks it unknown instead of guessing.":
    "Décrivez le produit une seule fois. Ne saisissez que des faits dont vous êtes sûr ; laissez vide tout ce qui est inconnu — Beacon le marque comme inconnu au lieu de deviner.",
  "Exit to product →": "Retour au produit →",
  "Knowledge completeness": "Complétude des connaissances",
  "Finish & analyse →": "Terminer et analyser →",
  "Save & continue →": "Enregistrer et continuer →",
  Save: "Enregistrer",
  "Skip (leave unknown)": "Passer (laisser inconnu)",
  "← Back": "← Retour",

  // Step titles (src/services/onboarding.ts ONBOARDING_STEPS)
  Identity: "Identité",
  Website: "Site web",
  Category: "Catégorie",
  Description: "Description",
  Audience: "Audience",
  "Problems solved": "Problèmes résolus",
  Features: "Fonctionnalités",
  Pricing: "Tarifs",
  Integrations: "Intégrations",
  "Proof / sources": "Preuves / sources",
  "Conversion events": "Événements de conversion",

  // Step 1 — Identity
  "Lifecycle status": "Statut du cycle de vie",
  "Logo URL (https)": "URL du logo (https)",

  // Step 2 — Website
  "Canonical domain": "Domaine canonique",
  "Used for canonical URLs, audits and tracking origin checks.": "Utilisé pour les URL canoniques, les audits et la vérification des origines du suivi.",
  "Documentation URL": "URL de la documentation",
  "Pricing page URL": "URL de la page de tarifs",
  "Languages (comma separated ISO codes)": "Langues (codes ISO séparés par des virgules)",
  "Supported countries (comma separated)": "Pays pris en charge (séparés par des virgules)",
  "Social accounts — one per line: network | https://url": "Comptes sociaux — un par ligne : réseau | https://url",

  // Step 3 — Category
  "Precise category, e.g. “TikTok LIVE moderation software”.": "Catégorie précise, par ex. « logiciel de modération TikTok LIVE ».",
  "Topics / keywords (comma separated)": "Thèmes / mots-clés (séparés par des virgules)",
  "Public API available?": "API publique disponible ?",
  Yes: "Oui",
  No: "Non",
  "Free trial?": "Essai gratuit ?",

  // Step 4 — Description
  "Short description (≤ 300 chars)": "Description courte (≤ 300 caractères)",
  "What it is and who it is for, in one precise sentence.": "Ce que c’est et à qui cela s’adresse, en une phrase précise.",
  "Full description": "Description complète",
  "How it works": "Fonctionnement",
  "Ordered steps (1. … 2. …) enable factual tutorials and HowTo structured data.":
    "Des étapes numérotées (1. … 2. …) permettent des tutoriels factuels et des données structurées HowTo.",

  // Steps 5–7
  "Target audiences — one per line: Name | description": "Audiences cibles — une par ligne : Nom | description",
  "TikTok agencies | Agencies managing a roster of LIVE creators": "Agences TikTok | Agences gérant un portefeuille de créateurs LIVE",
  "Industries — one per line": "Secteurs — un par ligne",
  "Problems solved — one per line: Problem | explanation": "Problèmes résolus — un par ligne : Problème | explication",
  "Features — one per line: Feature | description (≥ 60 chars enables a dedicated page)":
    "Fonctionnalités — une par ligne : Fonctionnalité | description (≥ 60 caractères permet une page dédiée)",
  "Use cases — one per line: Use case | description": "Cas d’usage — un par ligne : Cas d’usage | description",

  // Step 8 — Pricing
  "Plans — one per line: Plan | price | currency | MONTH/YEAR/ONE_TIME/USAGE/CUSTOM | trial days | description":
    "Offres — une par ligne : Offre | prix | devise | MONTH/YEAR/ONE_TIME/USAGE/CUSTOM | jours d’essai | description",
  "Leave the price blank when it is not public. Prices are only published in structured data once verified.":
    "Laissez le prix vide s’il n’est pas public. Les prix ne sont publiés dans les données structurées qu’une fois vérifiés.",

  // Step 9 — Competitors
  "Competitors — one per line: Name | domain": "Concurrents — un par ligne : Nom | domaine",
  "Add sourced comparison facts later in the knowledge editor. Comparison pages require ≥ 3 sourced facts.":
    "Ajoutez plus tard des faits comparatifs sourcés dans l’éditeur de connaissances. Les pages comparatives exigent ≥ 3 faits sourcés.",

  // Step 10 — Integrations
  "Integrations — one per line: Integration | description": "Intégrations — une par ligne : Intégration | description",
  "Only list integrations that exist today.": "N’indiquez que les intégrations qui existent aujourd’hui.",

  // Step 11 — Proof / sources
  "Canonical sources — one per line: Title | https://url | WEBSITE/DOCUMENTATION/PRICING/CHANGELOG/CASE_STUDY/PRESS/REPOSITORY/LEGAL/OTHER":
    "Sources canoniques — une par ligne : Titre | https://url | WEBSITE/DOCUMENTATION/PRICING/CHANGELOG/CASE_STUDY/PRESS/REPOSITORY/LEGAL/OTHER",
  "Every public claim should trace back to one of these URLs.": "Chaque affirmation publique doit pouvoir être rattachée à l’une de ces URL.",
  "Factual differentiators — one per line: Differentiator | evidence": "Différenciateurs factuels — un par ligne : Différenciateur | preuve",
  "Testimonials, case studies and metrics are added in the knowledge editor, where each item needs a source and explicit permission to publish.":
    "Les témoignages, études de cas et indicateurs s’ajoutent dans l’éditeur de connaissances, où chaque élément nécessite une source et une autorisation de publication explicite.",

  // Step 12 — Analytics
  "Beacon’s first-party tracker works without any third-party analytics (keys are created in the last step). Optionally connect Google Analytics 4 to import sessions by channel, including AI-assistant referrals.":
    "Le traceur first-party de Beacon fonctionne sans aucun outil d’analytique tiers (les clés sont créées à la dernière étape). Vous pouvez aussi connecter Google Analytics 4 pour importer les sessions par canal, y compris les visites référées par des assistants IA.",
  "✓ GA4 connected ({id}).": "✓ GA4 connecté ({id}).",
  "GA4 property ID": "ID de propriété GA4",
  "Service account JSON": "JSON du compte de service",
  "Stored encrypted (AES-256-GCM). Grant the service account Viewer access on the property. Leave blank to keep the stored secret.":
    "Stocké chiffré (AES-256-GCM). Accordez au compte de service l’accès Lecteur sur la propriété. Laissez vide pour conserver le secret enregistré.",

  // Step 13 — Search Console
  "Connect Google Search Console for impressions, clicks, positions and query data. Bing Webmaster can be connected in Settings → Integrations.":
    "Connectez Google Search Console pour obtenir les impressions, les clics, les positions et les données de requêtes. Bing Webmaster peut être connecté dans Paramètres → Intégrations.",
  "✓ Connected ({site}).": "✓ Connecté ({site}).",
  "Search Console property": "Propriété Search Console",
  "Add the service account email as a user of the property. Stored encrypted; leave blank to keep the stored secret.":
    "Ajoutez l’adresse e-mail du compte de service comme utilisateur de la propriété. Stocké chiffré ; laissez vide pour conserver le secret enregistré.",

  // Step 14 — Conversion events
  "Conversion URLs — one per line: Label | https://url | TRY_FREE/START_NOW/VIEW_DEMO/COMPARE_PLANS/BOOK_DEMO/ASK/OTHER":
    "URL de conversion — une par ligne : Libellé | https://url | TRY_FREE/START_NOW/VIEW_DEMO/COMPARE_PLANS/BOOK_DEMO/ASK/OTHER",
  "Finishing runs ": "La finalisation lance l’",
  "product analysis": "analyse produit",
  ": entity model → query map → content-gap analysis → suggested pages → GEO/AEO questions → distribution suggestions → opportunities → Beacon score. Create tracking keys on the product’s":
    " : modèle d’entité → carte des requêtes → analyse des lacunes de contenu → pages suggérées → questions GEO/AEO → suggestions de distribution → opportunités → score Beacon. Créez les clés de suivi du produit sur sa",
  "tracking page": "page de suivi",
};
