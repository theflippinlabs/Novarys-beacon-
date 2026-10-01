// Phase 2: measurement (tracking API, attribution models, Stripe inbox, GA4, KPI states, ecosystem graph).
export const fr: Record<string, string> = {
  // ── KPI tiles ───────────────────────────────────────────────────────
  "Connect →": "Connecter →",
  "Multiple currencies, not converted or added": "Plusieurs devises, ni converties ni additionnées",
  "New attributed MRR · {days}d": "Nouveau MRR attribué · {days} j",
  "AI referrals (Beacon tracker)": "Visites issues d’IA (traceur Beacon)",
  "AI referral sessions (GA4)": "Sessions issues d’IA (GA4)",
  "Technical audit not run yet": "Audit technique pas encore lancé",
  "Beacon tracker (AI-assistant referrers)": "Traceur Beacon (référents assistants IA)",
  "GA4 sessions from AI-assistant referrers": "Sessions GA4 issues d’assistants IA",
  "Subscriptions started ÷ visitors": "Abonnements démarrés ÷ visiteurs",
  "New MRR from ORGANIC_SEARCH, AI_REFERRAL, REFERRAL, AFFILIATE, CROSS_SELL": "Nouveau MRR issu de ORGANIC_SEARCH, AI_REFERRAL, REFERRAL, AFFILIATE, CROSS_SELL",

  // ── Event types and channels ────────────────────────────────────────
  "PRODUCT VIEWED": "PRODUIT CONSULTÉ",
  "SIGNUP STARTED": "INSCRIPTION COMMENCÉE",
  "SIGNUP COMPLETED": "INSCRIPTION TERMINÉE",
  "ACTIVATION COMPLETED": "ACTIVATION ATTEINTE",
  "SUBSCRIPTION STARTED": "ABONNEMENT DÉMARRÉ",
  "SUBSCRIPTION UPGRADED": "ABONNEMENT MONTÉ EN GAMME",
  "SUBSCRIPTION CANCELLED": "ABONNEMENT RÉSILIÉ",
  UNATTRIBUTED: "NON ATTRIBUÉ",
  "Browser tracker, automatic on every page load and SPA navigation.": "Traceur navigateur, automatique à chaque chargement de page et navigation SPA.",
  "Browser or server event when a product or pricing page is viewed.": "Événement navigateur ou serveur quand une page produit ou tarifs est consultée.",
  "Browser or server event when the signup form is started.": "Événement navigateur ou serveur quand le formulaire d’inscription est commencé.",
  "(also accepted as {alias})": "(également accepté sous le nom {alias})",
  "No touch at all in the lookback window → UNATTRIBUTED (distinct from DIRECT)": "Aucun contact dans la fenêtre de rétrospection → NON ATTRIBUÉ (distinct de DIRECT)",
  "Only touches inside the lookback window count. DIRECT touches never override a non-direct touch under last-touch. No qualifying touch → UNATTRIBUTED.":
    "Seuls les contacts de la fenêtre de rétrospection comptent. En dernier contact, un contact DIRECT ne remplace jamais un contact non direct. Aucun contact éligible → NON ATTRIBUÉ.",

  // ── Attribution models ──────────────────────────────────────────────
  Linear: "Linéaire",
  "Position-based (40/20/40)": "En U (40/20/40)",
  "100% of the credit goes to the first touch in the lookback window.": "100 % du crédit va au premier contact de la fenêtre de rétrospection.",
  "100% of the credit goes to the last non-direct touch in the lookback window (the last touch if every touch was direct).":
    "100 % du crédit va au dernier contact non direct de la fenêtre de rétrospection (au dernier contact si tous étaient directs).",
  "The credit is split equally across every touch in the lookback window.": "Le crédit est réparti à parts égales entre tous les contacts de la fenêtre de rétrospection.",
  "40% to the first touch, 40% to the last touch, 20% split across the touches in between.": "40 % au premier contact, 40 % au dernier, 20 % répartis entre les contacts intermédiaires.",
  "no-touch-in-window": "aucun contact dans la fenêtre",
  "referral-precedence": "priorité au parrainage",
  "first-touch": "premier contact",
  "last-non-direct-touch": "dernier contact non direct",
  "consent-denied": "consentement refusé",

  // ── Conversions page ────────────────────────────────────────────────
  "Cohort: people first seen in the last {days} days, and how many of them reached each step since. With a channel filter, the cohort is people whose first event came from that channel.":
    "Cohorte : les personnes vues pour la première fois au cours des {days} derniers jours, et combien d’entre elles ont atteint chaque étape depuis. Avec un filtre de canal, la cohorte se limite aux personnes dont le premier événement vient de ce canal.",
  "Attribution model: {model}": "Modèle d’attribution : {model}",
  "Credited conversions and revenue by channel · last {days} days": "Conversions et revenus crédités par canal · {days} derniers jours",
  "Credited conversions": "Conversions créditées",
  "Credited revenue": "Revenus crédités",
  "No conversion credited in this period.": "Aucune conversion créditée sur cette période.",
  "Fractional values are shares of conversions split across touches. Attribution shows which touches preceded a conversion: correlation, not causation.":
    "Les valeurs décimales sont des parts de conversions réparties entre contacts. L’attribution montre quels contacts ont précédé une conversion : corrélation, pas causalité.",
  "Conversions · {n} in the last {days} days": "Conversions · {n} au cours des {days} derniers jours",
  When: "Quand",
  Event: "Événement",
  "Source / medium / campaign": "Source / support / campagne",
  "Landing page": "Page d’arrivée",
  "Credited touch (rule)": "Contact crédité (règle)",
  "Model credit": "Crédit du modèle",
  Value: "Valeur",
  "Campaign: {name}": "Campagne : {name}",
  "No conversion (signup, trial, activation, checkout or subscription) in this period.": "Aucune conversion (inscription, essai, activation, paiement ou abonnement) sur cette période.",
  "Value: measured revenue of the same customer in the same product, per currency. Credited touch: the persisted single-touch decision (organisation model and referral precedence).":
    "Valeur : revenus mesurés du même client dans le même produit, par devise. Contact crédité : la décision mono-contact enregistrée (modèle de l’organisation et priorité au parrainage).",
  "← Newer": "← Plus récentes",
  "Older →": "Plus anciennes →",

  // ── Revenue page ────────────────────────────────────────────────────
  "Multiple currencies recorded ({currencies}). Every amount is shown in its own currency; amounts in different currencies are never converted or added together.":
    "Plusieurs devises enregistrées ({currencies}). Chaque montant est affiché dans sa propre devise ; des montants de devises différentes ne sont jamais convertis ni additionnés.",
  "Revenue source connected, no revenue received yet": "Source de revenus connectée, aucun revenu reçu pour l’instant",
  "Money is stored in minor units (cents) in each event’s own currency and is never converted. Totals are computed per currency; tiles list each currency separately when more than one is recorded.":
    "Les montants sont stockés en unités mineures (centimes) dans la devise de chaque événement et ne sont jamais convertis. Les totaux sont calculés par devise ; les tuiles listent chaque devise séparément lorsqu’il y en a plusieurs.",

  // ── Cross-sell and ecosystem graph ──────────────────────────────────
  "Measured revenue": "Revenus mesurés",
  "{amount} reported by the product": "{amount} déclarés par le produit",
  "Impressions and clicks: cross-sell events recorded by the products. Signups and subscriptions: destination-product events whose visit came from the rule's link (utm_source beacon-cross-sell, utm_campaign = rule id). Measured revenue: revenue events of those people in the destination product. Correlation, not causation.":
    "Impressions et clics : événements de vente croisée enregistrés par les produits. Inscriptions et abonnements : événements du produit de destination dont la visite vient du lien de la règle (utm_source beacon-cross-sell, utm_campaign = identifiant de la règle). Revenus mesurés : événements de revenus de ces personnes dans le produit de destination. Corrélation, pas causalité.",
  "Ecosystem relationship (optional)": "Relation de l’écosystème (facultatif)",
  "Ecosystem graph": "Graphe de l’écosystème",
  "Typed relationships between products · explained, optionally sourced": "Relations typées entre produits · justifiées, sourcées si possible",
  Rationale: "Justification",
  Rules: "Règles",
  Sourced: "Sourcée",
  remove: "retirer",
  "No relationships yet. Describe how your products relate (complementary, same audience, workflow extension, upsell, cross-sell) so cross-sell rules rest on an explicit, reviewable reason.":
    "Aucune relation pour l’instant. Décrivez comment vos produits se complètent (complémentaires, même audience, prolongement du flux de travail, montée en gamme, vente croisée) pour que les règles de vente croisée reposent sur une raison explicite et vérifiable.",
  "New relationship": "Nouvelle relation",
  "Rationale (why these products relate)": "Justification (pourquoi ces produits sont liés)",
  "Save relationship": "Enregistrer la relation",
  COMPLEMENTARY: "COMPLÉMENTAIRE",
  "SAME AUDIENCE": "MÊME AUDIENCE",
  "WORKFLOW EXTENSION": "PROLONGEMENT DU FLUX DE TRAVAIL",
  UPSELL: "MONTÉE EN GAMME",
  "Relationship saved.": "Relation enregistrée.",
  "Relationship removed.": "Relation retirée.",
  "A product cannot be related to itself.": "Un produit ne peut pas être lié à lui-même.",
  "The relationship must link the same source and destination products.": "La relation doit relier les mêmes produits source et destination.",

  // ── Stripe webhook inbox ────────────────────────────────────────────
  "Webhook inbox": "Boîte de réception des webhooks",
  "{processed} processed · {unmapped} unmapped · {failed} failed": "{processed} traités · {unmapped} non associés · {failed} en échec",
  "Link revenue to people: set metadata.beacon_identity (your user id, the identityRef you send to Beacon) on the subscription or checkout session, or pass it as client_reference_id at checkout. Map products with metadata.beacon_product on the price, subscription or invoice, or a default product.":
    "Pour relier les revenus aux personnes : renseignez metadata.beacon_identity (votre identifiant utilisateur, l’identityRef envoyé à Beacon) sur l’abonnement ou la session de paiement, ou passez-le comme client_reference_id au paiement. Associez les produits avec metadata.beacon_product sur le prix, l’abonnement ou la facture, ou avec un produit par défaut.",
  "Reprocess {n} event(s)": "Retraiter {n} événement(s)",
  "Reprocessed {total} event(s): {processed} processed, {unmapped} unmapped, {failed} failed.": "{total} événement(s) retraité(s) : {processed} traité(s), {unmapped} non associé(s), {failed} en échec.",
  RECEIVED: "REÇU",
  UNMAPPED: "NON ASSOCIÉ",
  PROCESSED: "TRAITÉ",
  "Subscription and payment events via signed webhooks. Set metadata.beacon_identity (your user id, the identityRef sent to Beacon) on the Stripe customer's subscription or checkout session to link revenue to the person's acquisition journey; without it, revenue is linked to the Stripe customer only.":
    "Événements d’abonnement et de paiement via des webhooks signés. Renseignez metadata.beacon_identity (votre identifiant utilisateur, l’identityRef envoyé à Beacon) sur l’abonnement ou la session de paiement Stripe pour relier les revenus au parcours d’acquisition de la personne ; sinon, les revenus sont reliés au seul client Stripe.",
  "From the Stripe endpoint (whsec_…). Events: invoice.paid, customer.subscription.created/updated/deleted, checkout.session.completed, charge.refunded, refund.created.":
    "Depuis le point de terminaison Stripe (whsec_…). Événements : invoice.paid, customer.subscription.created/updated/deleted, checkout.session.completed, charge.refunded, refund.created.",

  // ── Tracking setup page ─────────────────────────────────────────────
  "Browser: page views (including SPA navigation) & CTA clicks (add data-beacon-cta to CTA links)": "Navigateur : pages vues (navigation SPA comprise) et clics sur CTA (ajoutez data-beacon-cta aux liens d’appel à l’action)",
  "A publishable key may send PAGE_VIEW, CTA_CLICK, PRODUCT_VIEWED and SIGNUP_STARTED only, and never identityRef, emailHashInput, consent or traits (rejected with 403). Identity linking and consent are server-side.":
    "Une clé publiable ne peut envoyer que PAGE_VIEW, CTA_CLICK, PRODUCT_VIEWED et SIGNUP_STARTED, et jamais identityRef, emailHashInput, consent ou traits (refusés avec une erreur 403). La liaison d’identité et le consentement se font côté serveur.",
  "Server: identity and consent (secret key with identity:write)": "Serveur : identité et consentement (clé secrète avec identity:write)",
  "Event types: {types}. Legacy names stay accepted: SIGNUP, ACTIVATED, SUBSCRIBED, UPGRADED, CANCELLED.": "Types d’événements : {types}. Les anciens noms restent acceptés : SIGNUP, ACTIVATED, SUBSCRIBED, UPGRADED, CANCELLED.",
  "Server: batch (up to 100 events per request)": "Serveur : lot (jusqu’à 100 événements par requête)",
  "What Beacon stores": "Ce que Beacon enregistre",
  Privacy: "Confidentialité",
  "Visitor: a random id in a first-party cookie (bcn_vid, 1 year) and a session id in sessionStorage (new after 30 minutes of inactivity). No fingerprinting.":
    "Visiteur : un identifiant aléatoire dans un cookie propriétaire (bcn_vid, 1 an) et un identifiant de session dans sessionStorage (renouvelé après 30 minutes d’inactivité). Aucune empreinte numérique.",
  "Per event: type, page URL without query string, landing page, UTM parameters (source, medium, campaign, term, content), referrer host, CTA id, the attribution decision and its touches.":
    "Par événement : type, URL de la page sans paramètres, page d’arrivée, paramètres UTM (source, medium, campaign, term, content), domaine référent, identifiant du CTA, la décision d’attribution et ses contacts.",
  "IP address: never stored. A keyed hash of it is kept on acquisition touches for fraud checks and rate limiting, and cleared after {days} days.":
    "Adresse IP : jamais enregistrée. Une empreinte chiffrée à clé est conservée sur les contacts d’acquisition pour la détection de fraude et la limitation de débit, puis effacée après {days} jours.",
  "Identity: only the identityRef your server sends, a keyed hash of the email (never the email) and consent. Browsers cannot send them.":
    "Identité : uniquement l’identityRef envoyé par votre serveur, une empreinte à clé de l’e-mail (jamais l’e-mail) et le consentement. Les navigateurs ne peuvent pas les envoyer.",
  "Consent: when your server records analytics consent as refused, events are still counted but stored without visitor, session, identity, touch or IP linkage.":
    "Consentement : lorsque votre serveur enregistre un refus du consentement à la mesure d’audience, les événements restent comptés mais sont stockés sans lien avec le visiteur, la session, l’identité, les contacts ou l’IP.",
  "Do-Not-Track and Global Privacy Control: the tracker sends nothing.": "Do-Not-Track et Global Privacy Control : le traceur n’envoie rien.",

  // ── Journey ─────────────────────────────────────────────────────────
  "Journey · last {days} days": "Parcours · {days} derniers jours",
  "Search → visit → conversion, by landing page": "Recherche → visite → conversion, par page d’arrivée",
  "Search clicks": "Clics de recherche",
  "GA4 sessions": "Sessions GA4",
  "Beacon visitors": "Visiteurs Beacon",
  Links: "Liens",
  "Search Console page ↔ GA4 landing page": "Page Search Console ↔ page d’arrivée GA4",
  "Search ↔ GA4: {label}": "Recherche ↔ GA4 : {label}",
  "Beacon landing page → Beacon conversion of the same visitor": "Page d’arrivée Beacon → conversion Beacon du même visiteur",
  "Visit → conversion: {label}": "Visite → conversion : {label}",
  MEASURED: "MESURÉ",
  MODELLED: "MODÉLISÉ",
  UNKNOWN: "INCONNU",
  "MEASURED: same system and same visitor. MODELLED: joined on the page path only (the people behind the numbers may differ). UNKNOWN: one side has no data. Search Console, GA4 and Beacon count differently; their numbers are shown side by side, never added.":
    "MESURÉ : même système et même visiteur. MODÉLISÉ : rapprochement sur le chemin de la page uniquement (les personnes derrière les chiffres peuvent différer). INCONNU : un des côtés n’a pas de données. Search Console, GA4 et Beacon comptent différemment ; leurs chiffres sont affichés côte à côte, jamais additionnés.",
};
