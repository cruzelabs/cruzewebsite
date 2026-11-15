-- Server-side test for migration 026 (the application fields a pilot needs).
--
-- Builds the database from the repo the way the 025 test does: Supabase
-- stand-ins, then supabase-schema.sql and every migration from 001 to 025
-- (013 and 021 print their expected fresh-database errors). Then it adds
-- users, an admin and an application from before 026, and checks:
--   * before 026 the new columns do not exist, and an applicant could tie an
--     LOI to someone else's application
--   * 026 applies twice; the second apply adds no second check and changes
--     nothing; the application from before keeps its answers
--   * an applicant's insert with every new column works and stores what was
--     typed; an insert with only the old columns still works
--   * applicants can insert exactly the wizard's 22 columns: the staff
--     columns are still refused (42501) and anon cannot insert at all
--   * the row-level rule still holds: an applicant cannot insert for someone
--     else or with a status other than pending, and cannot change the truck
--     count afterwards
--   * out-of-range counts, an unknown tablet manager, over-long text and a
--     fleet_size that differs from truck_count are rejected (23514)
--   * an LOI ties only to the signer's own application, carries its truck
--     count (or the old form's size bucket) and, for a truck count, has the
--     sentence that names it in its text; anything else is 42501, including
--     an LOI with no application. The old form's LOI still goes in
--
-- Runs against a throwaway Postgres. Never run it against a real project.
-- From the repo root:
--
--   docker run -d --rm --name t26pg -e POSTGRES_PASSWORD=x -v "$PWD":/repo:ro postgres:17-alpine
--   until docker exec t26pg pg_isready -q; do sleep 1; done
--   docker exec -w /repo t26pg psql -U postgres -v ON_ERROR_STOP=1 \
--     -v mig=supabase/migrations/20261112_026_application_fields.sql \
--     -f supabase/tests/026_application_fields.test.sql
--   docker rm -f t26pg
--
-- Prints "application_fields: all checks passed" or stops at the first
-- failure.
\set QUIET on
\o /dev/null
set client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- Supabase stand-ins. Roles are cluster-wide and CI runs other tests first.
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
end $$;
alter role service_role bypassrls;   -- as live

create schema extensions;
create extension pgcrypto with schema extensions;
set search_path = "$user", public, extensions;

create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb
);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Database Webhooks: a stand-in for supabase_functions.http_request that
-- records each call instead of sending it. Security definer, as live.
create schema supabase_functions;
grant usage on schema supabase_functions to anon, authenticated, service_role;
create table supabase_functions.calls (
  id bigserial primary key, tbl text, op text, url text, method text, headers text, params text, timeout text);
create function supabase_functions.http_request() returns trigger language plpgsql security definer
  set search_path = supabase_functions as $$
begin
  insert into supabase_functions.calls (tbl, op, url, method, headers, params, timeout)
  values (tg_table_name, tg_op, tg_argv[0], tg_argv[1], tg_argv[2], tg_argv[3], tg_argv[4]);
  return new;
end $$;

set client_min_messages = error;
create publication supabase_realtime;
set client_min_messages = warning;

-- Supabase's default privileges in schema public, the same on live.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The repo, in order, up to 025.
-- ---------------------------------------------------------------------------
\ir ../../supabase-schema.sql
\ir ../migrations/20260504_001_security_fix.sql
\ir ../migrations/20260504_002_role_management.sql
\ir ../migrations/20260504_003_jwt_claims.sql
\ir ../migrations/20260505_004_signup_trigger_fix.sql
\ir ../migrations/20260505_005_restore_name_columns.sql
\ir ../migrations/20260505_006_investor_leads.sql
\ir ../migrations/20260506_007_loi_signatures.sql
\ir ../migrations/20260506_008_loi_amendments.sql
\ir ../migrations/20260506_009_archive_library.sql
\ir ../migrations/20260506_010_security_fixes.sql
\ir ../migrations/20260506_011_audit_round2.sql
\ir ../migrations/20260511_012_investor_visits.sql
\echo application_fields: 013 fails on a fresh database (investor_journey needs columns only live had); expected:
\set ON_ERROR_STOP 0
\ir ../migrations/20260511_013_investor_lead_session_id.sql
\set ON_ERROR_STOP 1
\ir ../migrations/20260518_014_pilot_application_enhancements.sql
\ir ../migrations/20260617_015_contact_messages.sql
\ir ../migrations/20260620_016_fix_profile_privilege_escalation.sql
\ir ../migrations/20261017_017_start_impersonation.sql
\ir ../migrations/20261017_018_close_anon_reads.sql
\ir ../migrations/20261018_019_audit_round2_safe.sql
\ir ../migrations/20261018_020_contact_messages_inbox.sql
\echo application_fields: 021 fails on a fresh database (three functions only live had); expected:
\set ON_ERROR_STOP 0
\ir ../migrations/20261022_021_revoke_public_execute.sql
\set ON_ERROR_STOP 1
\ir ../migrations/20261022_022_invites_and_profiles.sql
\ir ../migrations/20261022_023_restate_live_state.sql
\ir ../migrations/20261022_024_pilot_email_no_key.sql
\ir ../migrations/20261022_025_staff_messages_invite_ledger.sql
set client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- Helpers (as in the 025 test).
-- ---------------------------------------------------------------------------
create function pg_temp.ok(p_cond boolean, p_what text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAILED: %', p_what; end if;
end $$;

create function pg_temp.exec_as(p_sql text, p_role text, p_sub text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('set local role %I', p_role);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  execute p_sql;
  get diagnostics n = row_count;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  return n;
end $$;

create function pg_temp.fails_as(p_sql text, p_role text, p_sub text, p_state text) returns void language plpgsql as $$
declare v_state text;
begin
  execute format('set local role %I', p_role);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    execute 'reset role';
    perform set_config('request.jwt.claim.sub', '', true);
    if v_state <> p_state then
      raise exception 'FAILED: % as % gave %, expected %', p_sql, p_role, v_state, p_state;
    end if;
    return;
  end;
  execute 'reset role';
  raise exception 'FAILED: expected an error from % as %', p_sql, p_role;
end $$;

-- ---------------------------------------------------------------------------
-- Data from before 026.
-- ---------------------------------------------------------------------------
\set adm '''00000000-0000-0000-0000-0000000000a1'''
\set u1 '''00000000-0000-0000-0000-0000000000c1'''
\set u2 '''00000000-0000-0000-0000-0000000000c2'''
\set u3 '''00000000-0000-0000-0000-0000000000c3'''
\set app1 '''40000000-0000-0000-0000-000000000001'''
insert into auth.users (id, email) values
  (:adm, 'admin@example.com'), (:u1, 'one@example.com'), (:u2, 'two@example.com'), (:u3, 'three@example.com');
insert into public.profiles (id, role, status) values
  (:adm, 'admin', 'active'), (:u1, 'fleet_owner', 'active'), (:u2, 'fleet_owner', 'active'),
  (:u3, 'fleet_owner', 'active')
on conflict (id) do update set role = excluded.role, status = excluded.status;

-- An application from the five-field form: a size bucket and nothing else.
insert into public.pilot_applications (id, user_id, company_name, fleet_size, contact_name, contact_email, contact_phone, status)
values (:app1, :u1, 'One Freight', '101-500', 'Ona', 'one@example.com', '555-0101', 'pending');
-- The new columns are not there yet.
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, truck_count)
  values (%L, 'Two Freight', 'pending', 40)$q$, :u2), 'authenticated', :u2, '42703');
rollback;
-- The hole 026 closes: u3 ties an LOI to u1's application.
begin;
select pg_temp.ok(pg_temp.exec_as(format($q$insert into public.loi_signatures
  (user_id, pilot_application_id, participant_name, participant_company, fleet_size, agreed, initials, loi_full_text)
  values (%L, %L, 'Tess', 'Three Freight', '500', true, 'T', 'text')$q$, :u3, :app1), 'authenticated', :u3) = 1,
  'before 026 an applicant can tie an LOI to someone else''s application');
rollback;

-- ---------------------------------------------------------------------------
-- Apply 026, twice.
-- ---------------------------------------------------------------------------
\i :mig
create temp table before_second as
  select (select count(*) from pg_constraint where conrelid = 'public.pilot_applications'::regclass) as constraints,
         (select count(*) from pg_attribute where attrelid = 'public.pilot_applications'::regclass
            and attnum > 0 and not attisdropped) as columns;
\i :mig

-- (1) The columns.
select pg_temp.ok((select count(*) from information_schema.columns
  where table_schema = 'public' and table_name = 'pilot_applications'
    and (column_name, data_type) in (
      ('truck_count', 'integer'), ('data_authorizer_name', 'text'), ('data_authorizer_email', 'text'),
      ('tablet_model', 'text'), ('tablet_count', 'integer'), ('tablet_management', 'text'),
      ('safety_contact_name', 'text'), ('safety_contact_email', 'text'))) = 8,
  'the eight new columns exist with their types');
select pg_temp.ok((select count(*) from pg_constraint c
  where c.conrelid = 'public.pilot_applications'::regclass and c.contype = 'c' and cardinality(c.conkey) = 1
    and exists (select 1 from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      and a.attname in ('truck_count', 'data_authorizer_name', 'data_authorizer_email', 'tablet_model',
                        'tablet_count', 'tablet_management', 'safety_contact_name', 'safety_contact_email'))) = 8,
  'each new column has one check, also after the second apply');
select pg_temp.ok((select count(*) from pg_constraint
  where conrelid = 'public.pilot_applications'::regclass
    and conname = 'pilot_applications_fleet_size_is_truck_count') = 1,
  'one check holds fleet_size to truck_count, also after the second apply');
select pg_temp.ok((select count(*) from pg_policy
  where polrelid = 'public.loi_signatures'::regclass and polcmd = 'a') = 1,
  'loi_signatures has one insert policy, also after the second apply');
select pg_temp.ok((select b.constraints = (select count(*) from pg_constraint where conrelid = 'public.pilot_applications'::regclass)
    and b.columns = (select count(*) from pg_attribute where attrelid = 'public.pilot_applications'::regclass
      and attnum > 0 and not attisdropped) from before_second b),
  'the second apply adds no column and no constraint');
select pg_temp.ok((select fleet_size = '101-500' and company_name = 'One Freight' and status = 'pending'
    and truck_count is null and data_authorizer_name is null and data_authorizer_email is null
    and tablet_model is null and tablet_count is null and tablet_management is null
    and safety_contact_name is null and safety_contact_email is null
  from public.pilot_applications where id = :app1),
  'the application from before 026 keeps its answers and has nulls in the new columns');

-- (2) Inserts: exactly the wizard's columns.
select pg_temp.ok(not has_table_privilege('authenticated', 'public.pilot_applications', 'insert'),
  'authenticated has no table-wide insert');
select pg_temp.ok(not has_any_column_privilege('anon', 'public.pilot_applications', 'insert'), 'anon cannot insert');
with granted as (
  select a.attname::text as c from pg_attribute a
  where a.attrelid = 'public.pilot_applications'::regclass and a.attnum > 0 and not a.attisdropped
    and has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert')
), wanted as (
  select unnest(array[
    'user_id', 'company_name', 'truck_size', 'fleet_size', 'website', 'primary_lanes',
    'fms_provider', 'fms_other', 'contact_name', 'contact_email', 'contact_phone',
    'contact_title', 'application_notes', 'status',
    'truck_count', 'data_authorizer_name', 'data_authorizer_email', 'tablet_model',
    'tablet_count', 'tablet_management', 'safety_contact_name', 'safety_contact_email']) as c
)
select pg_temp.ok(
  not exists (select c from granted except select c from wanted)
  and not exists (select c from wanted except select c from granted),
  'applicants can insert exactly the wizard''s 22 columns; open by mistake: '
    || coalesce((select string_agg(c, ', ') from (select c from granted except select c from wanted) x), 'none')
    || '; closed by mistake: '
    || coalesce((select string_agg(c, ', ') from (select c from wanted except select c from granted) y), 'none'));
select pg_temp.ok(bool_and(not has_column_privilege('authenticated', 'public.pilot_applications', c, 'insert')),
  'applicants cannot insert staff columns')
from unnest(array['fleet_visible_message', 'reviewed_by', 'reviewed_at', 'notes', 'organization_id', 'id', 'created_at']) c;

-- The new form's insert, with every answer.
begin;
select pg_temp.ok(pg_temp.exec_as(format($q$insert into public.pilot_applications
  (user_id, company_name, truck_size, fleet_size, website, primary_lanes, fms_provider, fms_other,
   contact_name, contact_email, contact_phone, contact_title, application_notes, status,
   truck_count, data_authorizer_name, data_authorizer_email, tablet_model, tablet_count, tablet_management,
   safety_contact_name, safety_contact_email)
  values (%L, 'Two Freight', null, '140', null, 'Laredo yard; I-35 Laredo to Dallas', 'Other', 'Fleet Complete',
   'Dana', 'dana@example.com', '555-0102', null, null, 'pending',
   140, 'Ira Ops', 'ira@example.com', 'Samsung Galaxy Tab Active5', 120, 'fleet_mdm',
   'Sam Safety', 'sam@example.com')$q$, :u2), 'authenticated', :u2) = 1,
  'the new form''s insert works');
select pg_temp.ok((select truck_count = 140 and fleet_size = '140' and fms_provider = 'Other' and fms_other = 'Fleet Complete'
    and primary_lanes = 'Laredo yard; I-35 Laredo to Dallas'
    and data_authorizer_name = 'Ira Ops' and data_authorizer_email = 'ira@example.com'
    and tablet_model = 'Samsung Galaxy Tab Active5' and tablet_count = 120 and tablet_management = 'fleet_mdm'
    and safety_contact_name = 'Sam Safety' and safety_contact_email = 'sam@example.com'
    and reviewed_by is null and organization_id is null and fleet_visible_message is null
  from public.pilot_applications where user_id = :u2),
  'the row holds what the applicant typed and no staff value');
-- The applicant reads the answers back and cannot change them.
select pg_temp.ok(pg_temp.exec_as(format($q$select truck_count from public.pilot_applications where user_id = %L$q$, :u2),
  'authenticated', :u2) = 1, 'the applicant reads their own application');
select pg_temp.ok(pg_temp.exec_as(format($q$update public.pilot_applications set truck_count = 5 where user_id = %L$q$, :u2),
  'authenticated', :u2) = 0, 'the applicant cannot change the truck count after applying');
select pg_temp.ok(pg_temp.exec_as(format($q$select truck_count from public.pilot_applications where user_id = %L$q$, :u2),
  'authenticated', :u3) = 0, 'another applicant sees nothing');
select pg_temp.ok(pg_temp.exec_as($q$select truck_count, tablet_management from public.pilot_applications$q$,
  'authenticated', :adm) = 2, 'an admin reads every application');
rollback;

-- Optional answers left empty, tablets managed by Cruze or by hand.
begin;
select pg_temp.ok(pg_temp.exec_as(format($q$insert into public.pilot_applications
  (user_id, company_name, fleet_size, primary_lanes, fms_provider, contact_name, contact_email, contact_phone, status,
   truck_count, tablet_count, tablet_management)
  values (%L, 'Three Freight', '1', 'Houston', 'None', 'Tess', 'tess@example.com', '555-0103', 'pending',
   1, 0, 'cruze')$q$, :u3), 'authenticated', :u3) = 1, 'one truck, no tablets yet, Cruze manages them');
rollback;
begin;
select pg_temp.ok(pg_temp.exec_as(format($q$insert into public.pilot_applications
  (user_id, company_name, fleet_size, status, truck_count, tablet_management)
  values (%L, 'Three Freight', '1000000', 'pending', 1000000, 'manual')$q$, :u3), 'authenticated', :u3) = 1,
  'the largest truck count, tablets managed by hand');
rollback;
-- The old form's insert (the published site until the new one ships).
begin;
select pg_temp.ok(pg_temp.exec_as(format($q$insert into public.pilot_applications
  (user_id, company_name, truck_size, fleet_size, website, primary_lanes, fms_provider, fms_other,
   contact_name, contact_email, contact_phone, contact_title, application_notes, status)
  values (%L, 'Three Freight', null, '26-100', null, null, null, null,
   'Tess', 'tess@example.com', '555-0103', null, null, 'pending')$q$, :u3), 'authenticated', :u3) = 1,
  'the old form''s insert still works');
rollback;

-- Still refused: staff columns, anon, someone else's row, a status other than pending.
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, truck_count, fleet_visible_message)
  values (%L, 'Three Freight', 'pending', 12, 'phish')$q$, :u3), 'authenticated', :u3, '42501');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, truck_count, reviewed_by)
  values (%L, 'Three Freight', 'pending', 12, %L)$q$, :u3, :u3), 'authenticated', :u3, '42501');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, truck_count, organization_id)
  values (%L, 'Three Freight', 'pending', 12, gen_random_uuid())$q$, :u3), 'authenticated', :u3, '42501');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, truck_count)
  values (%L, 'Three Freight', 'pending', 12)$q$, :u3), 'anon', null, '42501');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, truck_count)
  values (%L, 'Three Freight', 'pending', 12)$q$, :u2), 'authenticated', :u3, '42501');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, truck_count)
  values (%L, 'Three Freight', 'approved', 12)$q$, :u3), 'authenticated', :u3, '42501');
rollback;

-- (1) The checks.
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, truck_count)
  values (%L, 'Three Freight', 'pending', 0)$q$, :u3), 'authenticated', :u3, '23514');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, truck_count)
  values (%L, 'Three Freight', 'pending', -4)$q$, :u3), 'authenticated', :u3, '23514');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, truck_count)
  values (%L, 'Three Freight', 'pending', 1000001)$q$, :u3), 'authenticated', :u3, '23514');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, tablet_count)
  values (%L, 'Three Freight', 'pending', -1)$q$, :u3), 'authenticated', :u3, '23514');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, tablet_count)
  values (%L, 'Three Freight', 'pending', 1000001)$q$, :u3), 'authenticated', :u3, '23514');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, tablet_management)
  values (%L, 'Three Freight', 'pending', 'someone')$q$, :u3), 'authenticated', :u3, '23514');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, data_authorizer_name)
  values (%L, 'Three Freight', 'pending', repeat('n', 201))$q$, :u3), 'authenticated', :u3, '23514');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, data_authorizer_email)
  values (%L, 'Three Freight', 'pending', repeat('e', 321))$q$, :u3), 'authenticated', :u3, '23514');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, tablet_model)
  values (%L, 'Three Freight', 'pending', repeat('m', 201))$q$, :u3), 'authenticated', :u3, '23514');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, safety_contact_name)
  values (%L, 'Three Freight', 'pending', repeat('n', 201))$q$, :u3), 'authenticated', :u3, '23514');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, safety_contact_email)
  values (%L, 'Three Freight', 'pending', repeat('e', 321))$q$, :u3), 'authenticated', :u3, '23514');
rollback;
-- (2) fleet_size is the truck count as text whenever a truck count is given.
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, fleet_size, truck_count)
  values (%L, 'Three Freight', 'pending', '101-500', 140)$q$, :u3), 'authenticated', :u3, '23514');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, fleet_size, truck_count)
  values (%L, 'Three Freight', 'pending', null, 140)$q$, :u3), 'authenticated', :u3, '23514');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status, fleet_size, truck_count)
  values (%L, 'Three Freight', 'pending', '0140', 140)$q$, :u3), 'authenticated', :u3, '23514');
rollback;

-- (4) The LOI. u2 applies with the new form (140 trucks), then signs. The
-- text holds the sentence src/lib/loi.ts renders, with p_text_count in it
-- (the LOI's own fleet_size unless given).
create function pg_temp.loi_sql(p_user text, p_app text, p_fleet_size text, p_text_count text default null)
returns text language sql as $$
  select format($q$insert into public.loi_signatures
    (user_id, pilot_application_id, participant_name, participant_company, fleet_size, agreed, initials, loi_full_text)
    values (%L, %L, 'Dana', 'Two Freight', %L, true, 'D',
            'LETTER OF INTENT' || chr(10) || 'Fleet Integration: ' || %L || ' vehicles shall be enrolled.' || chr(10) || 'Initials: D')$q$,
    p_user, p_app, p_fleet_size, coalesce(p_text_count, p_fleet_size))
$$;
\set app2 '''40000000-0000-0000-0000-000000000002'''
insert into public.pilot_applications (id, user_id, company_name, fleet_size, truck_count, primary_lanes,
  fms_provider, contact_name, contact_email, contact_phone, status)
values (:app2, :u2, 'Two Freight', '140', 140, 'Laredo yard', 'Omnitracs', 'Dana', 'dana@example.com', '555-0102', 'pending');

begin;
select pg_temp.ok(pg_temp.exec_as(pg_temp.loi_sql(:u2, :app2, '140'), 'authenticated', :u2) = 1,
  'the applicant signs an LOI that names the truck count they typed');
select pg_temp.ok((select fleet_size = '140' and loi_full_text like '%140 vehicles shall be enrolled%'
  from public.loi_signatures where pilot_application_id = :app2), 'the LOI holds the typed count');
rollback;
begin;
select pg_temp.fails_as(pg_temp.loi_sql(:u2, :app2, '101-500'), 'authenticated', :u2, '42501');
rollback;
begin;
select pg_temp.fails_as(pg_temp.loi_sql(:u2, :app2, '141'), 'authenticated', :u2, '42501');
rollback;
-- The right fleet_size but a text that names another count, or none.
begin;
select pg_temp.fails_as(pg_temp.loi_sql(:u2, :app2, '140', '10'), 'authenticated', :u2, '42501');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.loi_signatures
  (user_id, pilot_application_id, participant_name, participant_company, fleet_size, agreed, initials, loi_full_text)
  values (%L, %L, 'Dana', 'Two Freight', '140', true, 'D', 'I agree to everything.')$q$, :u2, :app2),
  'authenticated', :u2, '42501');
rollback;
-- Someone else's application, with or without a truck count.
begin;
select pg_temp.fails_as(pg_temp.loi_sql(:u3, :app2, '140'), 'authenticated', :u3, '42501');
rollback;
begin;
select pg_temp.fails_as(pg_temp.loi_sql(:u3, :app1, '101-500'), 'authenticated', :u3, '42501');
rollback;
-- Signing as someone else, and anon.
begin;
select pg_temp.fails_as(pg_temp.loi_sql(:u2, :app2, '140'), 'authenticated', :u3, '42501');
rollback;
begin;
select pg_temp.fails_as(pg_temp.loi_sql(:u2, :app2, '140'), 'anon', null, '42501');
rollback;
-- The old form: an application with a size bucket and no truck count. Its
-- LOI repeats the bucket, as the live site's does.
begin;
select pg_temp.ok(pg_temp.exec_as(pg_temp.loi_sql(:u1, :app1, '101-500'), 'authenticated', :u1) = 1,
  'the old form''s LOI, with its application''s size bucket, still goes in');
rollback;
begin;
select pg_temp.fails_as(pg_temp.loi_sql(:u1, :app1, '501-1500'), 'authenticated', :u1, '42501');
rollback;
-- An LOI with no application: neither form sends one, so it is refused.
begin;
select pg_temp.fails_as(pg_temp.loi_sql(:u3, null, '12'), 'authenticated', :u3, '42501');
rollback;

\o
\echo application_fields: all checks passed
