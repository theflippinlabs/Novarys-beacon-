export const fr: Record<string, string> = {
  "10 / Referrals": "10 / Parrainages",
  "Referral & affiliate engine": "Moteur de parrainage et d’affiliation",
  "Tracked referral links, affiliates and their commissions. Commissions flagged by fraud heuristics are held for human review — never auto-voided, never paid before the hold period ends.":
    "Liens de parrainage suivis, affiliés et leurs commissions. Les commissions signalées par les heuristiques antifraude sont mises en attente de revue humaine — jamais annulées automatiquement, jamais versées avant la fin de la période de blocage.",

  // Pipeline
  "Pipeline · last {days} days": "Pipeline · {days} derniers jours",
  "Referral & affiliate links → recurring revenue": "Liens de parrainage et d’affiliation → revenus récurrents",
  Visit: "Visite",
  Signup: "Inscription",
  Activation: "Activation",
  Purchase: "Achat",
  "Recurring revenue": "Revenus récurrents",
  "Visits = tracked /r/ link hits. Signups and purchases carry the referral code. Activation counts people whose signup came through a code. Recurring revenue = renewals + upgrades on referred subscriptions, per currency.":
    "Visites = ouvertures suivies des liens /r/. Les inscriptions et les achats portent le code de parrainage. L’activation compte les personnes dont l’inscription provient d’un code. Revenus récurrents = renouvellements + montées en gamme des abonnements parrainés, par devise.",
  "No referral links yet": "Aucun lien de parrainage pour l’instant",
  "Create a referral link below. Visits are recorded when someone opens {url}; signups, purchases and renewals are credited once your product sends lifecycle and revenue events.":
    "Créez un lien de parrainage ci-dessous. Une visite est enregistrée chaque fois que quelqu’un ouvre {url} ; les inscriptions, achats et renouvellements sont attribués dès que votre produit envoie ses événements de cycle de vie et de revenus.",

  // Referral links
  "Referral links": "Liens de parrainage",
  "{n} code": "{n} code",
  "{n} codes": "{n} codes",
  Link: "Lien",
  "Product / affiliate": "Produit / affilié",
  Destination: "Destination",
  Visits: "Visites",
  Signups: "Inscriptions",
  Purchases: "Achats",
  Recurring: "Récurrent",
  Status: "Statut",
  "campaign · {name}": "campagne · {name}",
  "Direct referral": "Parrainage direct",
  Deactivate: "Désactiver",
  Activate: "Activer",
  "No referral codes yet. Counts are all-time per code.": "Aucun code de parrainage pour l’instant. Les compteurs couvrent toute la durée de vie de chaque code.",
  "Create referral link": "Créer un lien de parrainage",
  Product: "Produit",
  Code: "Code",
  "Optional. 3–40 letters, digits, - or _. Generated when empty.":
    "Facultatif. 3 à 40 lettres, chiffres, - ou _. Généré automatiquement s’il est vide.",
  "SPRING-PARTNER": "PARTENAIRE-PRINTEMPS",
  Affiliate: "Affilié",
  "Links owned by an affiliate are classified AFFILIATE and earn commission.":
    "Les liens appartenant à un affilié sont classés AFFILIÉ et donnent droit à une commission.",
  "None (referral)": "Aucun (parrainage)",
  "Destination URL": "URL de destination",
  "Must be https on the selected product’s domain.": "Doit être en https sur le domaine du produit sélectionné.",
  Campaign: "Campagne",
  None: "Aucune",
  "Create link": "Créer le lien",
  "Set a domain on at least one product first — referral destinations must be on the product’s own domain.":
    "Définissez d’abord un domaine sur au moins un produit — les destinations de parrainage doivent se trouver sur le domaine du produit.",

  // Affiliates
  Affiliates: "Affiliés",
  "{n} affiliate": "{n} affilié",
  "{n} affiliates": "{n} affiliés",
  Name: "Nom",
  Commission: "Commission",
  Months: "Mois",
  Hold: "Suspendre",
  "Attributed revenue": "Revenus attribués",
  Commissions: "Commissions",
  "{pct}%": "{pct} %",
  "No affiliates": "Aucun affilié",
  "Add an affiliate, then create a referral link owned by them. Revenue arriving through their links earns commission per their terms.":
    "Ajoutez un affilié, puis créez un lien de parrainage qui lui appartient. Les revenus générés par ses liens donnent droit à une commission selon ses conditions.",
  "Attributed revenue: all revenue events carrying one of the affiliate’s codes. Commissions exclude VOID. Totals are per currency.":
    "Revenus attribués : tous les événements de revenus portant l’un des codes de l’affilié. Les commissions excluent le statut ANNULÉE. Les totaux sont exprimés par devise.",
  "Add affiliate": "Ajouter un affilié",
  "Contact email": "E-mail de contact",
  "Stored only as a keyed hash (used for self-referral detection).":
    "Stocké uniquement sous forme de hachage à clé (utilisé pour détecter l’auto-parrainage).",
  "Commission %": "Commission (%)",
  "Hold days": "Jours de blocage",

  // Commissions
  "Latest 100 commissions": "100 dernières commissions",
  Created: "Créée",
  "Revenue event": "Événement de revenus",
  Amount: "Montant",
  "Fraud flags": "Signaux de fraude",
  "Payable after": "Payable après le",
  Actions: "Actions",
  Approve: "Approuver",
  "Hold period ends {date}": "La période de blocage se termine le {date}",
  Release: "Lever la suspension",
  "Mark paid": "Marquer comme payée",
  Void: "Annuler",
  "paid {date}": "payée le {date}",
  none: "aucun",
  "No commissions yet": "Aucune commission pour l’instant",
  "Commissions are created automatically when revenue events (Stripe webhook or /api/v1/revenue) arrive for a subscription acquired through an affiliate’s link.":
    "Les commissions sont créées automatiquement à la réception d’événements de revenus (webhook Stripe ou /api/v1/revenue) pour un abonnement acquis via le lien d’un affilié.",

  // Fraud flags
  "SELF REFERRAL": "AUTO-PARRAINAGE",
  "INSTANT CONVERSION": "CONVERSION INSTANTANÉE",
  "IP VELOCITY": "RAFALE D’INSCRIPTIONS PAR IP",
  REFUNDED: "REMBOURSÉ",

  // Revenue event types and channels
  NEW: "NOUVEAU",
  RENEWAL: "RENOUVELLEMENT",
  UPGRADE: "MONTÉE EN GAMME",
  DOWNGRADE: "DESCENTE EN GAMME",
  CHURN: "RÉSILIATION",
  REFUND: "REMBOURSEMENT",
  "PAID ADS": "PUBLICITÉ PAYANTE",

  // Campaigns
  Campaigns: "Campagnes",
  "{n} UTM campaign": "{n} campagne UTM",
  "{n} UTM campaigns": "{n} campagnes UTM",
  Channel: "Canal",
  Ecosystem: "Écosystème",
  "No campaigns. Register UTM combinations so visits and conversions carrying them are linked to a named campaign.":
    "Aucune campagne. Enregistrez des combinaisons UTM pour que les visites et les conversions qui les portent soient rattachées à une campagne nommée.",
  "Add campaign": "Ajouter une campagne",
  "partner-newsletter": "newsletter-partenaire",
  "spring-launch": "lancement-printemps",
  "Ecosystem (no product)": "Écosystème (aucun produit)",
  "UTM values are stored lower-case.": "Les valeurs UTM sont enregistrées en minuscules.",
};
