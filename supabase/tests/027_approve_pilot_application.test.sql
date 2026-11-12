-- Server-side test for migration 027 (approve_pilot_application).
--
-- Builds the database from the repo the way the 026 test does: Supabase
-- stand-ins, then supabase-schema.sql and every migration from 001 to 026
-- (013 and 021 print their expected fresh-database errors). Then it adds
-- admins, applicants and applications, and checks:
--   * 027 applies twice; the function is SECURITY DEFINER with a fixed
--     search_path, and only authenticated and service_role may execute it
--   * an applicant, anon, the service role without a user and a suspended
--     admin are refused (42501), and an unknown id is P0002
--   * an admin's approval creates one fleet organization named after the
--     company, ties the application and the applicant's profile to it, sets
--     status approved, reviewed_by and reviewed_at, writes one role_history
--     row, and fires one UPDATE webhook
--   * a second call returns the same organization and changes nothing: no
--     new organization, no audit row, no update and no webhook
--   * onboarding stays onboarding; an application approved before 027 gets
--     its organization, and one with an organization but no reviewer gets a
--     reviewer; an applicant who already belongs to a fleet organization of
--     the same company keeps it and the application joins it
--   * refused with nothing changed: a denied or archived application (until
--     it is moved back to in_review), a profile and an application that name
--     different organizations, a profile organization for another company, a
--     city organization, an archived, suspended or admin applicant, a blank
--     company name, and, with 022's confirm-email switch on, an applicant who
--     never confirmed their email
--   * the guard trigger: no move into approved, onboarding or active, and no
--     clearing of the organization there, without an organization (23514),
--     for an admin's direct update or an insert; rows already there from
--     before 027 can still be edited
--
-- Runs against a throwaway Postgres. Never run it against a real project.
-- From the repo root:
--
--   docker run -d --rm --name t27pg -e POSTGRES_PASSWORD=x -v "$PWD":/repo:ro postgres:17-alpine
--   until docker exec t27pg pg_isready -q; do sleep 1; done
--   docker exec -w /repo t27pg psql -U postgres -v ON_ERROR_STOP=1 \
--     -v mig=supabase/migrations/20261112_027_approve_pilot_application.sql \
--     -f supabase/tests/027_approve_pilot_application.test.sql
--   docker rm -f t27pg
--
-- Prints "approve_pilot_application: all checks passed" or stops at the
-- first failure.
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
-- The repo, in order, up to 026.
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
\echo approve_pilot_application: 013 fails on a fresh database (investor_journey needs columns only live had); expected:
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
\echo approve_pilot_application: 021 fails on a fresh database (three functions only live had); expected:
\set ON_ERROR_STOP 0
\ir ../migrations/20261022_021_revoke_public_execute.sql
\set ON_ERROR_STOP 1
\ir ../migrations/20261022_022_invites_and_profiles.sql
\ir ../migrations/20261022_023_restate_live_state.sql
\ir ../migrations/20261022_024_pilot_email_no_key.sql
\ir ../migrations/20261022_025_staff_messages_invite_ledger.sql
\ir ../migrations/20261112_026_application_fields.sql
set client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- Helpers (as in the 026 test), plus approve_as, which returns the result.
-- ---------------------------------------------------------------------------
create function pg_temp.ok(p_cond boolean, p_what text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAILED: %', p_what; end if;
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

create function pg_temp.exec_as(p_sql text, p_role text, p_sub text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('set local role %I', p_role);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  if current_user <> p_role then
    raise exception 'FAILED: exec_as did not switch to %', p_role;
  end if;
  execute p_sql;
  get diagnostics n = row_count;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  return n;
end $$;

create function pg_temp.approve_as(p_app uuid, p_sub text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  if current_user <> 'authenticated' then
    raise exception 'FAILED: approve_as did not switch to the authenticated role';
  end if;
  execute 'select public.approve_pilot_application($1)' into r using p_app;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  return r;
end $$;

create function pg_temp.approve_sql(p_app uuid) returns text language sql as $$
  select format('select public.approve_pilot_application(%L)', p_app)
$$;

-- A refused approval changes nothing: same row counts, same application.
create function pg_temp.state(p_app uuid) returns text language sql as $$
  select concat_ws('|',
    (select count(*) from public.organizations),
    (select count(*) from public.role_history),
    (select count(*) from supabase_functions.calls where tbl = 'pilot_applications' and op = 'UPDATE'),
    (select a.status || ':' || coalesce(a.organization_id::text, '-') || ':' || coalesce(a.reviewed_by::text, '-')
       from public.pilot_applications a where a.id = p_app),
    (select coalesce(p.organization_id::text, '-') from public.profiles p
       join public.pilot_applications a on a.user_id = p.id where a.id = p_app))
$$;

create function pg_temp.refused(p_app uuid, p_sub text, p_state text, p_what text) returns void language plpgsql as $$
declare v_before text := pg_temp.state(p_app);
begin
  perform pg_temp.fails_as(pg_temp.approve_sql(p_app), 'authenticated', p_sub, p_state);
  perform pg_temp.ok(pg_temp.state(p_app) = v_before, p_what || ': nothing changed');
end $$;

-- ---------------------------------------------------------------------------
-- People, organizations and applications.
-- ---------------------------------------------------------------------------
\set adm '''00000000-0000-0000-0000-0000000000a1'''
\set adm2 '''00000000-0000-0000-0000-0000000000a2'''
\set u1 '''00000000-0000-0000-0000-0000000000c1'''
\set u2 '''00000000-0000-0000-0000-0000000000c2'''
\set u3 '''00000000-0000-0000-0000-0000000000c3'''
\set u4 '''00000000-0000-0000-0000-0000000000c4'''
\set u5 '''00000000-0000-0000-0000-0000000000c5'''
\set u6 '''00000000-0000-0000-0000-0000000000c6'''
\set u7 '''00000000-0000-0000-0000-0000000000c7'''
\set u8 '''00000000-0000-0000-0000-0000000000c8'''
\set u9 '''00000000-0000-0000-0000-0000000000c9'''
\set u10 '''00000000-0000-0000-0000-000000000c10'''
\set u11 '''00000000-0000-0000-0000-000000000c11'''
\set u12 '''00000000-0000-0000-0000-000000000c12'''
\set u13 '''00000000-0000-0000-0000-000000000c13'''
\set u14 '''00000000-0000-0000-0000-000000000c14'''
\set u15 '''00000000-0000-0000-0000-000000000c15'''
\set u16 '''00000000-0000-0000-0000-000000000c16'''
\set u17 '''00000000-0000-0000-0000-000000000c17'''
\set u18 '''00000000-0000-0000-0000-000000000c18'''
\set u19 '''00000000-0000-0000-0000-000000000c19'''
\set orgx '''30000000-0000-0000-0000-00000000000a'''
\set orgy '''30000000-0000-0000-0000-00000000000b'''
\set orgcity '''30000000-0000-0000-0000-00000000000c'''
\set orgz '''30000000-0000-0000-0000-00000000000d'''
\set orgw '''30000000-0000-0000-0000-00000000000e'''
\set app1 '''40000000-0000-0000-0000-000000000001'''
\set app2 '''40000000-0000-0000-0000-000000000002'''
\set app3 '''40000000-0000-0000-0000-000000000003'''
\set app4 '''40000000-0000-0000-0000-000000000004'''
\set app5 '''40000000-0000-0000-0000-000000000005'''
\set app6 '''40000000-0000-0000-0000-000000000006'''
\set app7 '''40000000-0000-0000-0000-000000000007'''
\set app8 '''40000000-0000-0000-0000-000000000008'''
\set app9 '''40000000-0000-0000-0000-000000000009'''
\set app10a '''40000000-0000-0000-0000-00000000010a'''
\set app10b '''40000000-0000-0000-0000-00000000010b'''
\set app11 '''40000000-0000-0000-0000-000000000011'''
\set app12 '''40000000-0000-0000-0000-000000000012'''
\set app13 '''40000000-0000-0000-0000-000000000013'''
\set app14 '''40000000-0000-0000-0000-000000000014'''
\set app15 '''40000000-0000-0000-0000-000000000015'''
\set app16 '''40000000-0000-0000-0000-000000000016'''
\set app17 '''40000000-0000-0000-0000-000000000017'''
\set app18 '''40000000-0000-0000-0000-000000000018'''
\set app19 '''40000000-0000-0000-0000-000000000019'''
\set nope '''40000000-0000-0000-0000-0000000000ff'''

insert into auth.users (id, email, email_confirmed_at)
select u, 'user-' || right(u::text, 3) || '@example.com', now()
from unnest(array[:adm, :adm2, :u1, :u2, :u3, :u4, :u5, :u6, :u7, :u8, :u9, :u10, :u11, :u13, :u14,
                  :u15, :u16, :u17, :u18, :u19]::uuid[]) u;
insert into auth.users (id, email, email_confirmed_at) values (:u12, 'unconfirmed@example.com', null);

insert into public.profiles (id, role, status)
select u, 'fleet_owner', 'active'
from unnest(array[:u1, :u2, :u3, :u7, :u8, :u9, :u10, :u11, :u12, :u13, :u14,
                  :u15, :u16, :u17, :u18, :u19]::uuid[]) u
on conflict (id) do update set role = excluded.role, status = excluded.status;
insert into public.profiles (id, role, status) values
  (:adm, 'admin', 'active'), (:adm2, 'admin', 'suspended'),
  (:u4, 'fleet_owner', 'archived'), (:u5, 'fleet_owner', 'suspended'), (:u6, 'admin', 'active')
on conflict (id) do update set role = excluded.role, status = excluded.status;

insert into public.organizations (id, name, org_type, status) values
  (:orgx, 'Three Freight', 'fleet', 'active'),
  (:orgy, 'Seven Freight', 'fleet', 'active'),
  (:orgcity, 'City of Example', 'city', 'active'),
  (:orgz, 'Other Fleet Inc', 'fleet', 'active'),
  (:orgw, 'Seventeen Freight', 'fleet', 'active');
update public.profiles set organization_id = :orgx where id in (:u3, :u7);
update public.profiles set organization_id = :orgz where id = :u15;
update public.profiles set organization_id = :orgw where id = :u17;

insert into public.pilot_applications (id, user_id, company_name, fleet_size, truck_count, website, status, organization_id) values
  (:app1, :u1, '  One Freight  ', '140', 140, 'https://one.example', 'pending', null),
  (:app2, :u2, 'Two Freight', '26-100', null, null, 'onboarding', null),
  (:app3, :u3, 'Three Freight LLC', '12', 12, null, 'in_review', null),
  (:app4, :u4, 'Four Freight', '12', 12, null, 'pending', null),
  (:app5, :u5, 'Five Freight', '12', 12, null, 'pending', null),
  (:app6, :u6, 'Six Freight', '12', 12, null, 'pending', null),
  (:app7, :u7, 'Seven Freight', '12', 12, null, 'pending', :orgy),
  (:app8, :u8, 'Eight Freight', '12', 12, null, 'pending', :orgcity),
  (:app9, :u9, '   ', '12', 12, null, 'pending', null),
  (:app10a, :u10, 'Ten Freight', '12', 12, null, 'denied', null),
  (:app10b, :u10, 'Ten Freight', '12', 12, null, 'pending', null),
  (:app11, :u11, 'Eleven Freight', '12', 12, null, 'denied', null),
  (:app12, :u12, 'Twelve Freight', '12', 12, null, 'pending', null),
  (:app13, :u13, 'Thirteen Freight', '501-1500', null, null, 'approved', null),
  (:app14, :u14, 'Fourteen Freight', '12', 12, null, 'pending', null),
  (:app15, :u15, 'Fifteen Freight', '12', 12, null, 'pending', null),
  (:app16, :u16, 'Sixteen Freight', '12', 12, null, 'archived', null),
  (:app17, :u17, 'Seventeen Freight', '12', 12, null, 'approved', :orgw),
  (:app18, :u18, 'Eighteen Freight', '12', 12, null, 'pending', null),
  (:app19, :u19, 'Nineteen Freight', '12', 12, null, 'active', null);

-- ---------------------------------------------------------------------------
-- Apply 027, twice.
-- ---------------------------------------------------------------------------
\i :mig
\i :mig

select pg_temp.ok((select count(*) from pg_proc where proname = 'approve_pilot_application') = 1,
  'one approve_pilot_application, also after the second apply');
select pg_temp.ok((select prosecdef and proconfig = array['search_path=public, pg_temp']
  from pg_proc where oid = 'public.approve_pilot_application(uuid)'::regprocedure),
  'SECURITY DEFINER with search_path public, pg_temp');
select pg_temp.ok(not has_function_privilege('anon', 'public.approve_pilot_application(uuid)', 'execute'),
  'anon cannot execute it');
select pg_temp.ok(not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.approve_pilot_application(uuid)'::regprocedure and a.grantee = 0),
  'PUBLIC cannot execute it');
select pg_temp.ok(has_function_privilege('authenticated', 'public.approve_pilot_application(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.approve_pilot_application(uuid)', 'execute'),
  'authenticated and service_role can execute it (the admin check is inside)');

-- ---------------------------------------------------------------------------
-- Only an active admin.
-- ---------------------------------------------------------------------------
begin;
select pg_temp.refused(:app1, :u1, '42501', 'the applicant approving their own application');
select pg_temp.refused(:app1, :adm2, '42501', 'a suspended admin');
select pg_temp.refused(:app1, null, '42501', 'a signed-in role with no user');
rollback;
begin;
select pg_temp.fails_as(pg_temp.approve_sql(:app1), 'anon', null, '42501');
rollback;
begin;
select pg_temp.fails_as(pg_temp.approve_sql(:app1), 'service_role', null, '42501');
rollback;
begin;
select pg_temp.fails_as(pg_temp.approve_sql(:nope), 'authenticated', :adm, 'P0002');
rollback;
select pg_temp.ok((select count(*) from public.organizations) = 5, 'no organization created by a refused call');

-- ---------------------------------------------------------------------------
-- An admin approves app1.
-- ---------------------------------------------------------------------------
create temp table before1 as
  select (select count(*) from supabase_functions.calls where tbl = 'pilot_applications' and op = 'UPDATE') as updates,
         (select count(*) from public.role_history) as history,
         (select count(*) from public.organizations) as orgs;
create temp table r1 as select pg_temp.approve_as(:app1, :adm) as r;

select pg_temp.ok((select r->>'application_status' = 'approved'
    and (r->>'organization_created')::boolean
    and r->>'organization_name' = 'One Freight'
    and (r->>'owner_id')::uuid = :u1
    and (r->>'application_id')::uuid = :app1 from r1),
  'the result names the new organization, its name and the applicant');
select pg_temp.ok((select o.name = 'One Freight' and o.org_type = 'fleet' and o.status = 'active'
    and o.website = 'https://one.example' and o.created_by = :adm
  from public.organizations o where o.id = (select (r->>'organization_id')::uuid from r1)),
  'the organization is a fleet named after the company, created by the admin');
select pg_temp.ok((select a.organization_id = (select (r->>'organization_id')::uuid from r1)
    and a.status = 'approved' and a.reviewed_by = :adm and a.reviewed_at > now() - interval '1 minute'
  from public.pilot_applications a where a.id = :app1),
  'the application has the organization, approved, reviewed by the admin just now');
select pg_temp.ok((select p.organization_id = (select (r->>'organization_id')::uuid from r1)
    and p.role = 'fleet_owner' and p.status = 'active'
  from public.profiles p where p.id = :u1),
  'the applicant''s profile has the organization; role and status unchanged');
select pg_temp.ok((select count(*) from public.role_history h
  where h.user_id = :u1 and h.changed_by = :adm and h.old_role = 'fleet_owner' and h.new_role = 'fleet_owner'
    and h.reason like 'Pilot application ' || :app1 || ' approved: joined organization One Freight (%') = 1
  and (select count(*) from public.role_history) = (select history from before1) + 1,
  'one role_history row records the approval');
select pg_temp.ok((select count(*) from supabase_functions.calls where tbl = 'pilot_applications' and op = 'UPDATE')
    = (select updates from before1) + 1,
  'one UPDATE webhook (the approval email)');
select pg_temp.ok((select count(*) from public.organizations) = (select orgs from before1) + 1,
  'exactly one organization was created');

-- The same approval again: nothing new.
create temp table before2 as
  select pg_temp.state(:app1) as s,
         (select reviewed_at from public.pilot_applications where id = :app1) as reviewed_at;
create temp table r2 as select pg_temp.approve_as(:app1, :adm) as r;
select pg_temp.ok((select r2.r->>'organization_id' = r1.r->>'organization_id'
    and not (r2.r->>'organization_created')::boolean and r2.r->>'application_status' = 'approved' from r1, r2),
  'a second approval returns the same organization');
select pg_temp.ok((select s from before2) = pg_temp.state(:app1)
    and (select reviewed_at from before2) = (select reviewed_at from public.pilot_applications where id = :app1),
  'a second approval changes nothing: no organization, no audit row, no update, no webhook');
-- Another admin approving it again changes nothing either.
create temp table before3 as select pg_temp.state(:app1) as s;
select pg_temp.approve_as(:app1, :u6);
select pg_temp.ok((select s from before3) = pg_temp.state(:app1)
    and (select reviewed_by from public.pilot_applications where id = :app1) = :adm,
  'a second admin''s approval changes nothing and keeps the first reviewer');

-- ---------------------------------------------------------------------------
-- Later stages, approvals from before 027, and an applicant with an organization.
-- ---------------------------------------------------------------------------
create temp table r_app2 as select pg_temp.approve_as(:app2, :adm) as r;
select pg_temp.ok((select a.status = 'onboarding' and a.organization_id is not null and a.reviewed_by = :adm
    and (select r->>'application_status' from r_app2) = 'onboarding'
  from public.pilot_applications a where a.id = :app2),
  'an application in onboarding gets its organization and stays in onboarding');

select pg_temp.approve_as(:app13, :adm);
select pg_temp.ok((select a.status = 'approved' and a.organization_id is not null
    and (select p.organization_id from public.profiles p where p.id = :u13) = a.organization_id
  from public.pilot_applications a where a.id = :app13),
  'an application approved before 027 gets its organization');

-- 'Three Freight LLC' and the profile's 'Three Freight' are the same company.
create temp table r_app3 as select pg_temp.approve_as(:app3, :adm) as r;
select pg_temp.ok((select (r->>'organization_id')::uuid = :orgx and not (r->>'organization_created')::boolean
    and r->>'organization_name' = 'Three Freight' from r_app3)
  and (select organization_id = :orgx and status = 'approved' from public.pilot_applications where id = :app3)
  and (select count(*) from public.role_history where user_id = :u3) = 0,
  'an applicant who already belongs to the same company''s fleet organization keeps it; the application joins it');

-- Approved before 027 with its organization but no reviewer: it gets one,
-- once.
create temp table before17 as select (select count(*) from public.organizations) as orgs;
select pg_temp.approve_as(:app17, :adm);
select pg_temp.ok((select a.reviewed_by = :adm and a.reviewed_at is not null and a.organization_id = :orgw
    and a.status = 'approved' from public.pilot_applications a where a.id = :app17)
  and (select count(*) from public.organizations) = (select orgs from before17)
  and (select count(*) from public.role_history where user_id = :u17) = 0,
  'an approved application with an organization but no reviewer gets the reviewer, nothing else');
create temp table before17b as select pg_temp.state(:app17) as s,
  (select reviewed_at from public.pilot_applications where id = :app17) as reviewed_at;
select pg_temp.approve_as(:app17, :u6);
select pg_temp.ok((select s from before17b) = pg_temp.state(:app17)
    and (select reviewed_at from before17b) = (select reviewed_at from public.pilot_applications where id = :app17),
  'and a second call changes nothing');

-- ---------------------------------------------------------------------------
-- Refusals.
-- ---------------------------------------------------------------------------
begin;
select pg_temp.refused(:app7, :adm, '22023', 'a profile and an application that name different organizations');
select pg_temp.refused(:app15, :adm, '22023', 'a profile organization for another company');
select pg_temp.refused(:app8, :adm, '22023', 'a city organization');
select pg_temp.refused(:app4, :adm, '22023', 'an archived applicant');
select pg_temp.refused(:app5, :adm, '22023', 'a suspended applicant');
select pg_temp.refused(:app6, :adm, '22023', 'an admin applicant');
select pg_temp.refused(:app9, :adm, '22023', 'a blank company name');
select pg_temp.refused(:app10a, :adm, '22023', 'a denied application');
select pg_temp.refused(:app11, :adm, '22023', 'a denied application, the applicant''s only one');
select pg_temp.refused(:app16, :adm, '22023', 'an archived application');
rollback;

select pg_temp.approve_as(:app10b, :adm);
select pg_temp.ok((select status = 'approved' from public.pilot_applications where id = :app10b),
  'the applicant''s open application can be approved');
-- A denied application is reopened by moving it back to in_review.
begin;
select pg_temp.ok(pg_temp.exec_as(format($q$update public.pilot_applications set status = 'in_review' where id = %L$q$, :app11),
  'authenticated', :adm) = 1, 'an admin moves a denied application back to in_review');
commit;
select pg_temp.approve_as(:app11, :adm);
select pg_temp.ok((select status = 'approved' and organization_id is not null from public.pilot_applications where id = :app11),
  'a denied application moved back to in_review can be approved');

-- 022's switch for the day "Confirm email" is on.
create or replace function public.invite_requires_confirmed_email()
returns boolean language sql immutable set search_path = public as $$ select true $$;
begin;
select pg_temp.refused(:app12, :adm, '22023', 'an unconfirmed email with the switch on');
rollback;
select pg_temp.approve_as(:app14, :adm);
select pg_temp.ok((select status = 'approved' from public.pilot_applications where id = :app14),
  'a confirmed email is approved with the switch on');
create or replace function public.invite_requires_confirmed_email()
returns boolean language sql immutable set search_path = public as $$ select false $$;
select pg_temp.approve_as(:app12, :adm);
select pg_temp.ok((select status = 'approved' from public.pilot_applications where id = :app12),
  'with the switch off an unconfirmed email is approved, as accept_invitation allows');

-- ---------------------------------------------------------------------------
-- The guard: no move into approved, onboarding or active without an
-- organization, whoever makes it.
-- ---------------------------------------------------------------------------
create function pg_temp.update_sql(p_app uuid, p_set text) returns text language sql as $$
  select format('update public.pilot_applications set %s where id = %L', p_set, p_app)
$$;
begin;
select pg_temp.fails_as(pg_temp.update_sql(:app18, $$status = 'approved'$$), 'authenticated', :adm, '23514');
rollback;
begin;
select pg_temp.fails_as(pg_temp.update_sql(:app18, $$status = 'onboarding'$$), 'authenticated', :adm, '23514');
rollback;
begin;
select pg_temp.fails_as(pg_temp.update_sql(:app18, $$status = 'active', reviewed_at = now()$$), 'authenticated', :adm, '23514');
rollback;
begin;
select pg_temp.fails_as(pg_temp.update_sql(:app1, 'organization_id = null'), 'authenticated', :adm, '23514');
rollback;
begin;
select pg_temp.fails_as(format($q$insert into public.pilot_applications (user_id, company_name, status)
  values (%L, 'Sixteen Freight', 'approved')$q$, :u16), 'postgres', null, '23514');
rollback;
begin;
select pg_temp.ok(pg_temp.exec_as(pg_temp.update_sql(:app18, $$status = 'denied'$$), 'authenticated', :adm) = 1,
  'a move to denied needs no organization');
select pg_temp.ok(pg_temp.exec_as(pg_temp.update_sql(:app1, $$status = 'onboarding'$$), 'authenticated', :adm) = 1,
  'an approved application with its organization moves on to onboarding');
rollback;
-- app19 was active without an organization before 027: still editable, but
-- it moves only after its approval.
begin;
select pg_temp.ok(pg_temp.exec_as(pg_temp.update_sql(:app19, $$notes = 'call Tuesday'$$), 'authenticated', :adm) = 1,
  'a row already past approval without an organization can still be edited');
select pg_temp.fails_as(pg_temp.update_sql(:app19, $$status = 'onboarding'$$), 'authenticated', :adm, '23514');
commit;
select pg_temp.approve_as(:app19, :adm);
select pg_temp.ok((select status = 'active' and organization_id is not null from public.pilot_applications where id = :app19),
  'approving it keeps it active and gives it its organization');

-- Every approved application and its applicant share one fleet organization.
select pg_temp.ok(not exists (
    select 1 from public.pilot_applications a
    join public.profiles p on p.id = a.user_id
    left join public.organizations o on o.id = a.organization_id
    where a.status in ('approved', 'onboarding', 'active')
      and (a.organization_id is null or p.organization_id is distinct from a.organization_id
           or o.org_type is distinct from 'fleet')),
  'every approved application and its applicant share one fleet organization');

\o
\echo approve_pilot_application: all checks passed
