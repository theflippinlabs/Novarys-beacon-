-- The app no longer uses em dashes (U+2014) or en dashes (U+2013). Clean the
-- text that Beacon itself generated or that members typed, so existing data
-- matches. Evidence (crawled pages, AI answers), audit logs and agent
-- transcripts (replayed byte-for-byte to the model) are left untouched.
-- Title-like columns get " | " (title separator); prose gets ", ".
DO $$
DECLARE
  r record;
  em text := chr(8212);
  en text := chr(8211);
  sep text;
BEGIN
  PERFORM set_config('beacon.bypass_rls', 'on', true);
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.data_type IN ('text', 'character varying')
      AND c.table_name IN (
        'products', 'product_facets', 'product_faqs', 'product_pricing', 'product_proofs', 'product_changelog',
        'competitors', 'product_competitors', 'query_clusters', 'queries', 'pages', 'content_assets', 'content_versions',
        'seo_issues', 'opportunities', 'growth_reports', 'recommendations', 'experiments', 'campaigns',
        'distribution_targets', 'agent_conversations', 'media'
      )
      AND c.column_name NOT IN ('id', 'slug', 'url', 'domain', 'organization_id')
  LOOP
    sep := CASE WHEN r.column_name IN ('title', 'seo_title', 'meta_title', 'h1', 'name') THEN ' | ' ELSE ', ' END;
    EXECUTE format(
      'UPDATE %I SET %I = replace(replace(replace(replace(%I, $1, $2), $3, $2), $4, $5), $6, $5) WHERE %I LIKE $7 OR %I LIKE $8',
      r.table_name, r.column_name, r.column_name, r.column_name, r.column_name
    ) USING ' ' || em || ' ', sep, ' ' || en || ' ', em, '-', en, '%' || em || '%', '%' || en || '%';
  END LOOP;
END $$;
