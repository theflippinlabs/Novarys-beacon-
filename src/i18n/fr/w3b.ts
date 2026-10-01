// Wave 3b: launch checklist items, approved-content edits, empty states.
export const fr: Record<string, string> = {
  // Launch checklist: site and critical issues
  "{domain} is verified and answers over HTTPS in the latest audit.": "{domain} est vérifié et répond en HTTPS dans le dernier audit.",
  "No critical technical issues": "Aucun problème technique critique",
  "{n} open critical issue(s) in the latest audit.": "{n} problème(s) critique(s) ouvert(s) dans le dernier audit.",
  // Launch checklist: hosted llms.txt and entity endpoint
  "llms.txt and entity endpoint available": "llms.txt et point d’accès d’entité disponibles",
  "Served at /p/{org}/llms.txt and /api/v1/entity/{org}/{product} with {n} verified fact(s).": "Servis sur /p/{org}/llms.txt et /api/v1/entity/{org}/{product} avec {n} fait(s) vérifié(s).",
  "The public site is turned off for the organisation: llms.txt and the entity endpoint answer 404.": "Le site public est désactivé pour l’organisation : llms.txt et le point d’accès d’entité répondent 404.",
  "The product is not served yet: llms.txt and the entity endpoint list onboarded, non-deprecated products only.":
    "Le produit n’est pas encore servi : llms.txt et le point d’accès d’entité ne listent que les produits intégrés et non obsolètes.",
  "No verified fact yet: the entity profile and llms.txt publish verified facts only.": "Aucun fait vérifié pour l’instant : le profil d’entité et llms.txt ne publient que des faits vérifiés.",
  // Launch checklist: Bing
  "Bing Webmaster Tools connected": "Bing Webmaster Tools connecté",
  "Bing Webmaster Tools is connected.": "Bing Webmaster Tools est connecté.",
  "Bing Webmaster Tools is configured but its last sync failed.": "Bing Webmaster Tools est configuré mais sa dernière synchronisation a échoué.",
  // Launch checklist: AI visibility baseline
  "AI visibility baseline sampled": "Référence de visibilité IA échantillonnée",
  "{tested} of {n} active AI visibility prompt(s) tested at least once.": "{tested} sur {n} prompt(s) de visibilité IA actif(s) testé(s) au moins une fois.",
  "No active AI visibility prompt for this product yet.": "Aucun prompt de visibilité IA actif pour ce produit pour l’instant.",
  // Launch checklist: referral code
  "Referral code active": "Code de parrainage actif",
  "{n} active referral code(s) for this product.": "{n} code(s) de parrainage actif(s) pour ce produit.",
  // Launch checklist: revenue source
  "Revenue source connected": "Source de revenus connectée",
  "{n} revenue event(s) or subscription(s) received for this product.": "{n} événement(s) de revenus ou abonnement(s) reçu(s) pour ce produit.",
  "Stripe is connected; no revenue event for this product yet.": "Stripe est connecté ; aucun événement de revenus pour ce produit pour l’instant.",
  "Stripe is configured but its last sync failed.": "Stripe est configuré mais sa dernière synchronisation a échoué.",

  // Content: edit of an approved, unpublished asset
  "Version {n} was approved, but the latest draft (version {m}) has different text: it needs fresh checks and a new approval. The approval of version {n} does not carry over and it is not published.":
    "La version {n} a été approuvée, mais le dernier brouillon (version {m}) a un texte différent : il doit repasser les vérifications et obtenir une nouvelle approbation. L’approbation de la version {n} ne se reporte pas et elle n’est pas publiée.",
  "Show the approved text (version {n})": "Afficher le texte approuvé (version {n})",
  "No changes: this text is already approved, so its approval stands.": "Aucune modification : ce texte est déjà approuvé, son approbation est donc maintenue.",

  // Empty states: experiments
  "An experiment compares a control and a variant on one counted event, with a minimum sample size per arm. Create one from a hypothesis, or from an experiment the growth report proposes.":
    "Une expérimentation compare un contrôle et une variante sur un événement compté, avec une taille d’échantillon minimale par bras. Créez-en une à partir d’une hypothèse, ou d’une expérimentation proposée par le rapport de croissance.",
  "Design an experiment": "Concevoir une expérimentation",
  "Open the growth report": "Ouvrir le rapport de croissance",
  // Empty states: product relationships
  "No relationships yet.": "Aucune relation pour l’instant.",
  "Describe how your products relate (complementary, same audience, workflow extension, upsell, cross-sell) so cross-sell rules rest on an explicit, reviewable reason.":
    "Décrivez comment vos produits se complètent (complémentaires, même audience, prolongement du flux de travail, montée en gamme, vente croisée) pour que les règles de vente croisée reposent sur une raison explicite et vérifiable.",
  "Describe a relationship": "Décrire une relation",
  "Add a product": "Ajouter un produit",
  "Review cross-sell rules": "Voir les règles de vente croisée",
  // Empty states: topic clusters
  "Clusters group the active queries of {product} by topic, one recommended asset each. They are computed from the query universe and refreshed with its coverage.":
    "Les clusters regroupent par sujet les requêtes actives de {product}, avec un contenu recommandé chacun. Ils sont calculés à partir de l’univers de requêtes et actualisés avec sa couverture.",
  "Clusters group a product's active queries by topic, one recommended asset each. Select a product in the filters to see or compute them.":
    "Les clusters regroupent par sujet les requêtes actives d’un produit, avec un contenu recommandé chacun. Sélectionnez un produit dans les filtres pour les voir ou les calculer.",
  "Review active queries": "Voir les requêtes actives",
  "Show clusters for {product}": "Afficher les clusters de {product}",
  // Empty states: content gaps
  "No content gap found": "Aucune lacune de contenu trouvée",
  "Every relevant cluster is covered, or there is no measured evidence yet (search impressions, sampled AI answers or business-relevant clusters without a page).":
    "Chaque cluster pertinent est couvert, ou aucune donnée mesurée n’existe encore (impressions de recherche, réponses IA échantillonnées ou clusters pertinents pour l’activité sans page).",
  "Review uncovered queries": "Voir les requêtes non couvertes",
};
