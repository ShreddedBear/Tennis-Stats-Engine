-- ---------------------------------------------------------------------------
-- TENNIS MATRIX AUDIT — functions and indexes drizzle-kit's schema diff cannot express.
--
-- Idempotent: safe to re-run on every `pnpm --filter @workspace/db push`.
--
-- These are the Audit's existing production definitions, carried over unchanged in
-- behaviour. They are plain plpgsql and plain Postgres indexes -- nothing here depends
-- on any hosted platform, which is why the Audit's data layer could move to this
-- workspace's DATABASE_URL without the decision logic noticing.
--
-- SECURITY DEFINER is deliberately NOT reproduced. In the old deployment these ran as a
-- privileged owner so a browser-role caller could reach them past row-level security.
-- Here the Audit is reached only through the API server, which holds the single database
-- connection, so the functions run as the caller and need no elevated rights. That
-- removes a whole class of exposure the old setup had to defend with grants.
-- ---------------------------------------------------------------------------

-- --- Run leasing -----------------------------------------------------------------
-- Concurrency control for the audit driver. Several workers may try to advance the same
-- run (the browser poll loop, a scheduled driver); the lease is what makes exactly one of
-- them the owner, and `found` is what the pipeline reads to decide whether it holds it.
-- A lease is claimable when it is unowned, expired, or already this owner's -- so a
-- crashed worker's run recovers on expiry rather than being stuck forever.

create or replace function public.claim_audit_run(
  p_run_id uuid, p_lease_owner text, p_lease_seconds integer default 60
) returns boolean
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
begin
  update public.audit_runs
     set lease_owner = p_lease_owner,
         lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 10)),
         heartbeat_at = now(),
         updated_at = now()
   where id = p_run_id
     and status in ('RUNNING', 'COMPLETE')
     and (
       lease_owner is null
       or lease_expires_at is null
       or lease_expires_at < now()
       or lease_owner = p_lease_owner
     );
  return found;
end;
$function$;

create or replace function public.renew_audit_run_lease(
  p_run_id uuid, p_lease_owner text, p_lease_seconds integer default 60
) returns boolean
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
begin
  update public.audit_runs
     set lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 10)),
         heartbeat_at = now(),
         updated_at = now()
   where id = p_run_id
     and status = 'RUNNING'
     and lease_owner = p_lease_owner;
  return found;
end;
$function$;

create or replace function public.release_audit_run_lease(
  p_run_id uuid, p_lease_owner text
) returns boolean
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
begin
  update public.audit_runs
     set lease_owner = null,
         lease_expires_at = null,
         heartbeat_at = now(),
         updated_at = now()
   where id = p_run_id
     and lease_owner = p_lease_owner;
  return found;
end;
$function$;

-- --- Evidence warehouse upsert ----------------------------------------------------
-- One atomic write per (metric, player, context, date). The conflict target is the
-- functional unique index below, which is why that index is created here too and not
-- left to the schema diff: without it this upsert has nothing to conflict on.

create unique index if not exists metric_evidence_context_unique_idx
  on public.metric_evidence_store (
    metric_code,
    lower(player_name),
    coalesce(lower(opponent_name), ''::text),
    coalesce(lower(tournament), ''::text),
    coalesce(lower(surface), ''::text),
    as_of_date
  );

create or replace function public.upsert_metric_evidence_side(p_payload jsonb)
returns public.metric_evidence_store
language plpgsql
set search_path to 'public'
as $function$
declare
  persisted public.metric_evidence_store;
begin
  insert into public.metric_evidence_store (
    metric_code, metric_name, player_name, opponent_name, tournament, surface,
    as_of_date, treatment, value_text, reliability, sample_label,
    evidence_family, source_ids, sources, unavailable_reason, valid_until,
    updated_at
  )
  values (
    p_payload->>'metric_code', p_payload->>'metric_name',
    p_payload->>'player_name', nullif(p_payload->>'opponent_name', ''),
    nullif(p_payload->>'tournament', ''), nullif(p_payload->>'surface', ''),
    (p_payload->>'as_of_date')::date, p_payload->>'treatment',
    p_payload->>'value_text', (p_payload->>'reliability')::double precision,
    nullif(p_payload->>'sample_label', ''), nullif(p_payload->>'evidence_family', ''),
    coalesce(array(select jsonb_array_elements_text(p_payload->'source_ids')), '{}'),
    coalesce(p_payload->'sources', '[]'::jsonb),
    nullif(p_payload->>'unavailable_reason', ''),
    (p_payload->>'valid_until')::timestamptz,
    coalesce((p_payload->>'updated_at')::timestamptz, now())
  )
  on conflict (
    metric_code,
    (lower(player_name)),
    (coalesce(lower(opponent_name), '')),
    (coalesce(lower(tournament), '')),
    (coalesce(lower(surface), '')),
    as_of_date
  ) do update set
    metric_name = excluded.metric_name,
    treatment = excluded.treatment,
    value_text = excluded.value_text,
    reliability = excluded.reliability,
    sample_label = excluded.sample_label,
    evidence_family = excluded.evidence_family,
    source_ids = excluded.source_ids,
    sources = excluded.sources,
    unavailable_reason = excluded.unavailable_reason,
    valid_until = excluded.valid_until,
    updated_at = excluded.updated_at
  returning * into persisted;

  return persisted;
end;
$function$;

-- --- Clear Slate ------------------------------------------------------------------
-- CLEAR SLATE MEANS PHYSICAL DELETION -- never retirement, archival, an is_active flag or
-- "preserve for auditing". The Audit learned this the hard way: an earlier version only
-- flipped summary_versions.is_active, so re-uploading the same PDF found the old match row
-- by canonical key and revived its audit history under what looked like a fresh upload.
--
-- Everything reachable from a cleared match goes: its audit runs and every child row
-- computed from them, its coverage, decisions, grades, identity records, summary versions
-- and uploads, and the slate row itself. Global reference data is untouched, and so is
-- every table belonging to the AI prediction engine -- nothing here names one.
--
-- The `after` counts are re-queried inside the same transaction, so the caller can prove
-- the delete actually happened rather than trusting that the call returned without error.

create or replace function public.clear_operational_slate(p_user_id uuid)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_match_ids uuid[];
  v_run_ids uuid[];
  v_before jsonb;
  v_after jsonb;
  v_deleted_matches integer := 0;
  v_deleted_uploads integer := 0;
  v_deleted_slates integer := 0;
  v_deleted_observations integer := 0;
begin
  select coalesce(array_agg(id), '{}') into v_match_ids
    from public.matches where user_id = p_user_id;

  select coalesce(array_agg(id), '{}') into v_run_ids
    from public.audit_runs where match_id = any(v_match_ids);

  select jsonb_build_object(
    'matches', (select count(*) from public.matches where id = any(v_match_ids)),
    'audit_runs', (select count(*) from public.audit_runs where id = any(v_run_ids)),
    'metric_results', (select count(*) from public.metric_results where audit_run_id = any(v_run_ids)),
    'final_decisions', (select count(*) from public.final_decisions where audit_run_id = any(v_run_ids)),
    'audit_stage_runs', (select count(*) from public.audit_stage_runs where audit_run_id = any(v_run_ids)),
    'summary_versions', (select count(*) from public.summary_versions where match_id = any(v_match_ids)),
    'result_grades', (select count(*) from public.result_grades where match_id = any(v_match_ids)),
    'calibration_observations', (select count(*) from public.truth_engine_calibration_observations where match_id = any(v_match_ids))
  ) into v_before;

  -- Children of a run, then children of a match, then the match, then the slate.
  delete from public.metric_results          where audit_run_id = any(v_run_ids);
  delete from public.reconstruction_results  where audit_run_id = any(v_run_ids);
  delete from public.verification_results    where audit_run_id = any(v_run_ids);
  delete from public.disagreement_results    where audit_run_id = any(v_run_ids);
  delete from public.underdog_results        where audit_run_id = any(v_run_ids);
  delete from public.stress_results          where audit_run_id = any(v_run_ids);
  delete from public.final_decisions         where audit_run_id = any(v_run_ids);
  delete from public.audit_coverage          where audit_run_id = any(v_run_ids);
  delete from public.metric_coverage_rates   where audit_run_id = any(v_run_ids);
  delete from public.audit_stage_runs        where audit_run_id = any(v_run_ids);
  delete from public.source_snapshots        where audit_run_id = any(v_run_ids);
  delete from public.source_conflicts        where audit_run_id = any(v_run_ids);
  delete from public.execution_logs          where audit_run_id = any(v_run_ids) or match_id = any(v_match_ids);
  delete from public.audit_runs              where id = any(v_run_ids);

  delete from public.truth_engine_calibration_observations where match_id = any(v_match_ids);
  get diagnostics v_deleted_observations = row_count;
  delete from public.result_grades           where match_id = any(v_match_ids);
  delete from public.match_identity_records  where match_id = any(v_match_ids);
  delete from public.parsed_summary_fields
    where summary_version_id in (select id from public.summary_versions where match_id = any(v_match_ids));
  delete from public.summary_versions        where match_id = any(v_match_ids);
  delete from public.summary_uploads         where user_id = p_user_id;
  get diagnostics v_deleted_uploads = row_count;

  delete from public.matches                 where id = any(v_match_ids);
  get diagnostics v_deleted_matches = row_count;

  delete from public.prediction_slates       where user_id = p_user_id;
  get diagnostics v_deleted_slates = row_count;

  -- Independent proof, in the same transaction, that nothing survived.
  select jsonb_build_object(
    'matches', (select count(*) from public.matches where id = any(v_match_ids)),
    'audit_runs', (select count(*) from public.audit_runs where id = any(v_run_ids)),
    'metric_results', (select count(*) from public.metric_results where audit_run_id = any(v_run_ids)),
    'final_decisions', (select count(*) from public.final_decisions where audit_run_id = any(v_run_ids)),
    'audit_stage_runs', (select count(*) from public.audit_stage_runs where audit_run_id = any(v_run_ids)),
    'summary_versions', (select count(*) from public.summary_versions where match_id = any(v_match_ids)),
    'result_grades', (select count(*) from public.result_grades where match_id = any(v_match_ids)),
    'calibration_observations', (select count(*) from public.truth_engine_calibration_observations where match_id = any(v_match_ids))
  ) into v_after;

  return jsonb_build_object(
    'before', v_before,
    'after', v_after,
    'deleted_matches', v_deleted_matches,
    'deleted_uploads', v_deleted_uploads,
    'deleted_slates', v_deleted_slates,
    'deleted_calibration_observations', v_deleted_observations
  );
end;
$function$;

-- --- Indexes the pipeline depends on ----------------------------------------------
-- ensureRun() gives every new run a run_number strictly greater than any the match has
-- had, and never resets to 1 -- Clear Slate invalidates a previous row without deleting
-- it. This index is what makes that a guarantee rather than a convention.
create unique index if not exists audit_runs_match_run_number_idx
  on public.audit_runs (match_id, run_number);

-- Hot read paths: every child-row read is scoped by audit_run_id, and the slate/run
-- resolution reads are scoped by match.
create index if not exists metric_results_run_idx         on public.metric_results (audit_run_id);
create index if not exists reconstruction_results_run_idx on public.reconstruction_results (audit_run_id);
create index if not exists verification_results_run_idx   on public.verification_results (audit_run_id);
create index if not exists disagreement_results_run_idx   on public.disagreement_results (audit_run_id);
create index if not exists underdog_results_run_idx       on public.underdog_results (audit_run_id);
create index if not exists stress_results_run_idx         on public.stress_results (audit_run_id);
create index if not exists audit_stage_runs_run_idx       on public.audit_stage_runs (audit_run_id);
create index if not exists audit_runs_match_idx           on public.audit_runs (match_id);
create index if not exists summary_versions_match_idx     on public.summary_versions (match_id);
create index if not exists execution_logs_match_idx       on public.execution_logs (match_id);
