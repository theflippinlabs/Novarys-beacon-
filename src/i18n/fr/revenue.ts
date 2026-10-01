export const fr: Record<string, string> = {
  "11 / Revenue": "11 / Revenus",
  "Revenue attribution": "Attribution des revenus",
  "MRR, subscriptions and revenue by acquisition channel and product, from provider webhooks and the revenue API. Amounts are recorded in each event’s own currency.":
    "MRR, abonnements et revenus par canal d’acquisition et par produit, issus des webhooks des fournisseurs et de l’API de revenus. Les montants sont enregistrés dans la devise propre à chaque événement.",

  // KPI tiles
  MRR: "MRR",
  ARR: "ARR",
  "MRR attributable to Beacon": "MRR attribuable à Beacon",
  "Beacon channels": "Canaux Beacon",
  "New subscriptions": "Nouveaux abonnements",
  "Revenue in period": "Revenus sur la période",
  "New MRR via Beacon": "Nouveau MRR via Beacon",
  "Last {days} days": "{days} derniers jours",
  "Active subscriptions": "Abonnements actifs",
  "Revenue events": "Événements de revenus",
  "MRR × 12": "MRR × 12",
  "Multiple currencies recorded ({currencies}). The tiles and per-channel/per-product totals above add amounts without conversion and label them in {currency}; use the per-event table below for exact per-currency figures.":
    "Plusieurs devises enregistrées ({currencies}). Les tuiles et les totaux par canal et par produit ci-dessus additionnent les montants sans conversion et les affichent en {currency} ; utilisez le tableau par événement ci-dessous pour obtenir les montants exacts par devise.",

  // Empty state
  "No revenue data connected": "Aucune donnée de revenus connectée",
  "Connect Stripe webhook →": "Connecter le webhook Stripe →",
  "Revenue API on the Tracking tab": "API de revenus dans l’onglet Suivi",
  "Beacon has not received any revenue events. Connect a Stripe webhook in Settings → Integrations, or post invoices and subscription changes to":
    "Beacon n’a reçu aucun événement de revenus. Connectez un webhook Stripe dans Paramètres → Intégrations, ou envoyez les factures et les changements d’abonnement à",
  "with a secret key (documented on each product’s Tracking tab). Nothing on this page is estimated.":
    "avec une clé secrète (documenté dans l’onglet Suivi de chaque produit). Rien sur cette page n’est estimé.",

  // Breakdowns
  "Current MRR": "MRR actuel",
  "MRR by acquisition channel": "MRR par canal d’acquisition",
  "MRR by product": "MRR par produit",
  "Revenue by acquisition channel": "Revenus par canal d’acquisition",
  "Revenue by product": "Revenus par produit",
  "{amount} · {n} subscription(s)": "{amount} · {n} abonnement(s)",
  "Beacon channel": "Canal Beacon",
  "{amount} · {n} event(s)": "{amount} · {n} événement(s)",
  "No active subscriptions.": "Aucun abonnement actif.",
  "No revenue events in this period.": "Aucun événement de revenus sur cette période.",
  "MRR by channel (table view)": "MRR par canal (vue tableau)",
  "MRR by product (table view)": "MRR par produit (vue tableau)",
  "Revenue by channel (table view)": "Revenus par canal (vue tableau)",
  "Revenue by product (table view)": "Revenus par produit (vue tableau)",
  "Table view": "Vue tableau",
  Channel: "Canal",
  Product: "Produit",
  Subs: "Abonnements",
  Revenue: "Revenus",
  "MRR Δ": "Δ MRR",
  Currency: "Devise",

  // Ledger
  Ledger: "Registre",
  "Latest 50 revenue events": "50 derniers événements de revenus",
  Occurred: "Date",
  Type: "Type",
  Amount: "Montant",
  Provider: "Fournisseur",
  "External ID": "ID externe",

  // Revenue event types and acquisition channels
  NEW: "NOUVEAU",
  RENEWAL: "RENOUVELLEMENT",
  UPGRADE: "MONTÉE EN GAMME",
  DOWNGRADE: "DESCENTE EN GAMME",
  CHURN: "RÉSILIATION",
  REFUND: "REMBOURSEMENT",
  "PAID ADS": "PUBLICITÉ PAYANTE",

  // Definitions
  Definitions: "Définitions",
  "How revenue is attributed": "Comment les revenus sont attribués",
  "Attributable to Beacon": "Attribuable à Beacon",
  "MRR of active and past-due subscriptions whose acquisition channel is one Beacon operates: {channels}. The channel is fixed at acquisition using the organisation’s attribution rules (see":
    "MRR des abonnements actifs et impayés dont le canal d’acquisition est l’un de ceux qu’opère Beacon : {channels}. Le canal est fixé à l’acquisition selon les règles d’attribution de l’organisation (voir",
  "organic search": "recherche organique",
  "ai referral": "référent IA",
  referral: "parrainage",
  affiliate: "affiliation",
  "cross sell": "vente croisée",
  Conversions: "Conversions",
  "). Paid, social, email, direct and other channels are not counted.":
    "). Les canaux publicité payante, réseaux sociaux, e-mail, direct et autres ne sont pas comptabilisés.",
  "Sum of MRR deltas of revenue events in the period on Beacon channels (new, upgrades, downgrades and churn net out).":
    "Somme des variations de MRR des événements de revenus de la période sur les canaux Beacon (nouveaux abonnements, montées en gamme, descentes en gamme et résiliations se compensent).",
  "Current MRR × 12.": "MRR actuel × 12.",
  Currencies: "Devises",
  "Money is stored in minor units (cents) in each event’s own currency and is never converted. Totals are labelled in the organisation’s primary currency ({currency}); check the currency column when more than one currency is recorded.":
    "Les montants sont stockés en unités mineures (centimes) dans la devise propre à chaque événement et ne sont jamais convertis. Les totaux sont affichés dans la devise principale de l’organisation ({currency}) ; vérifiez la colonne Devise lorsque plusieurs devises sont enregistrées.",
};
