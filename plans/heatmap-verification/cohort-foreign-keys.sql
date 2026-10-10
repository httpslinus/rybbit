BEGIN;
DO $$
DECLARE
  fixture_site integer;
  fixture_cohort integer;
BEGIN
  INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
  VALUES ('heatmap-cohort-fk-qa', 'Local cohort FK fixture', 'cohort-fk-qa@example.test', false, now(), now());
  INSERT INTO sites (name, domain, type)
  VALUES ('Local cohort FK fixture', 'cohort-fk.example.test', 'web')
  RETURNING site_id INTO fixture_site;
  INSERT INTO cohorts (site_id, user_id, name, start_date, end_date, time_zone, filters)
  VALUES (fixture_site, 'heatmap-cohort-fk-qa', 'FK fixture', '2026-01-01', '2026-01-02', 'UTC',
    '[{"parameter":"pathname","type":"equals","value":["/fixture"]}]')
  RETURNING cohort_id INTO fixture_cohort;
  DELETE FROM "user" WHERE id = 'heatmap-cohort-fk-qa';
  IF (SELECT user_id FROM cohorts WHERE cohort_id = fixture_cohort) IS NOT NULL THEN
    RAISE EXCEPTION 'Cohort owner must be cleared when the account is deleted';
  END IF;
  DELETE FROM sites WHERE site_id = fixture_site;
  IF EXISTS (SELECT 1 FROM cohorts WHERE cohort_id = fixture_cohort) THEN
    RAISE EXCEPTION 'Site deletion must cascade to cohort definitions';
  END IF;
END $$;
ROLLBACK;
