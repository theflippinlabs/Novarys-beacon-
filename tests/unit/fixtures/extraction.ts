/** Fixture pages for the onboarding website extraction parser (tests/unit/onboarding-launch.test.ts). */
export const HOME_URL = "https://acme.example/";

export const HOME_HTML = `<!doctype html><html><head>
<title>Acme Live | TikTok LIVE moderation for agencies</title>
<meta name="description" content="Acme Live helps TikTok agencies moderate LIVE chat in real time with keyword filters and a shared moderator dashboard.">
<meta property="og:description" content="Real-time moderation for TikTok LIVE streams run by agencies.">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"Organization","name":"Acme","logo":"https://acme.example/logo.png","sameAs":["https://x.com/acmelive","https://www.linkedin.com/company/acme-live","https://example.org/not-social"]},
 {"@type":"SoftwareApplication","name":"Acme Live","applicationCategory":"BusinessApplication","description":"Moderation workspace for TikTok LIVE agencies.","featureList":"Keyword filters, Spam detection",
  "offers":[{"@type":"Offer","name":"Starter","price":"29","priceCurrency":"EUR"},{"@type":"Offer","name":"Enterprise"}]}
]}</script>
<script type="application/ld+json">{ not valid json </script>
</head><body>
<nav><a href="/pricing">Pricing</a> <a href="https://docs.acme.example/start">Docs</a> <a href="/features">Features</a> <a href="/about">About</a> <a href="/blog/post-1">Blog</a></nav>
<h1>Keep every TikTok LIVE chat clean \u2014 automatically</h1>
<h2>Keyword filters</h2><p>Block or flag comments that contain configurable keywords during LIVE streams.</p>
<h2>Pricing</h2><p>Simple plans.</p>
<h3>Moderator dashboard</h3><p>A shared dashboard where moderators review flagged comments.</p>
<h2>FAQ</h2>
<footer><a href="https://twitter.com/intent/tweet?text=hi">Share</a> <a href="https://github.com/acme/live?utm_source=site">GitHub</a> <a href="https://www.youtube.com/@acme">YouTube</a></footer>
</body></html>`;

export const FEATURES_URL = "https://acme.example/features";
export const FEATURES_HTML = `<!doctype html><html><head><title>Features</title></head><body>
<h1>Features</h1><h2>Spam detection</h2><p>Detect repeated messages and link spam automatically.</p><h2>Keyword filters</h2><p>Duplicate of the homepage heading.</p>
</body></html>`;
