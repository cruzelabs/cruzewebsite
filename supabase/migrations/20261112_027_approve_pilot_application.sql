-- ============================================================================
-- 20261112_027_approve_pilot_application.sql
--
-- One approval creates the fleet's organization (Linear CRU-90, piece 2).
--
-- public.approve_pilot_application(application_id uuid) is what the admin
-- dialog's Approve now calls instead of a plain status update. In one
-- transaction it:
--   1. finds the application's organization: the one the application already
--      has, else the one the applicant's profile already has when its name
--      matches the application's company (normalize_company_name, 023), else
--      a new organizations row (org_type fleet, status active) named after
--      the application's company and created by the caller;
--   2. sets organization_id on the application and on the applicant's
--      profile, and writes a role_history row when the profile's organization
--      changes (role and status stay as they are, like start_impersonation);
--   3. sets the application's status to approved (an application already in
--      onboarding or active keeps its status), reviewed_by to the caller and
--      reviewed_at to now.
-- It returns the organization's id and name and the applicant's user id,
-- which are what staff pass to the portal's `npm run fleet:create` (REA #77).
--
-- Safe to call twice: the application row is locked, so a second call waits
-- for the first, then finds the organization already set and changes nothing
-- (no update, so no second webhook and no second email).
--
-- It refuses, with nothing changed:
--   * a caller who is not an active admin (42501), as change_user_role (002)
--     and start_impersonation (017) do;
--   * a denied or archived application. Move it back to in_review first, so
--     an approval from a dialog opened before someone denied it cannot undo
--     the denial;
--   * an applicant whose account is not an active fleet_owner, since the
--     account becomes the fleet's owner;
--   * an applicant whose profile names a different organization than the
--     application, or an organization whose name does not match the
--     application's company, or one that is not a fleet. A person belongs to
--     one organization, so moving them is a decision for a person;
--   * an application with no company name, which would name the organization;
--   * when invite_requires_confirmed_email() is true (022's switch for the
--     day "Confirm email" is turned on), an applicant whose email address was
--     never confirmed.
--
-- Guard: a trigger refuses any change that puts an application into
-- approved, onboarding or active, or clears its organization there, without
-- an organization (23514). So the old status dropdown, the bulk bar or a
-- direct update cannot skip the approval. Rows already in those stages
-- without one can still be edited and approved; only the move is checked.
-- The live site's old dropdown hits this guard, so apply this file when the
-- site with the new Approve button is published.
--
-- SECURITY DEFINER with a fixed search_path; EXECUTE for authenticated and
-- service_role only, as 021 left the other admin functions.
--
-- Idempotent: safe to run more than once. Needs 002, 017, 022 and 023 (it
-- uses is_admin(), invite_requires_confirmed_email() and
-- normalize_company_name()).
-- Test: supabase/tests/027_approve_pilot_application.test.sql
-- ============================================================================

create or replace function public.approve_pilot_application(application_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_app public.pilot_applications%rowtype;
  v_profile public.profiles%rowtype;
  v_org_id uuid;
  v_org_name text;
  v_org_type text;
  v_created boolean := false;
  v_status text;
  v_confirmed_at timestamptz;
begin
  if v_caller is null or not public.is_admin() then
    raise exception 'approve_pilot_application: caller is not an active admin'
      using errcode = '42501';
  end if;

  -- Lock the application first, so two approvals of it run one after the other.
  select * into v_app
  from public.pilot_applications a
  where a.id = approve_pilot_application.application_id
  for update;
  if not found then
    raise exception 'approve_pilot_application: no application with that id'
      using errcode = 'P0002';
  end if;
  if v_app.status in ('denied', 'archived') then
    raise exception 'approve_pilot_application: the application is %. Move it back to in_review, then approve.',
      v_app.status
      using errcode = '22023';
  end if;

  select * into v_profile
  from public.profiles p
  where p.id = v_app.user_id
  for update;
  if not found then
    raise exception 'approve_pilot_application: the applicant has no profile'
      using errcode = 'P0002';
  end if;
  if v_profile.role is distinct from 'fleet_owner' then
    raise exception 'approve_pilot_application: the applicant''s account is %, not fleet_owner. Only a fleet owner account can own a pilot fleet.',
      coalesce(v_profile.role, 'without a role')
      using errcode = '22023';
  end if;
  if v_profile.status is distinct from 'active' then
    raise exception 'approve_pilot_application: the applicant''s account is %. Make it active on the Users tab, then approve.',
      coalesce(v_profile.status, 'without a status')
      using errcode = '22023';
  end if;

  if public.invite_requires_confirmed_email() then
    select u.email_confirmed_at into v_confirmed_at from auth.users u where u.id = v_app.user_id;
    if v_confirmed_at is null then
      raise exception 'approve_pilot_application: the applicant has not confirmed their email address'
        using errcode = '22023';
    end if;
  end if;

  -- The organization: the application's, else the profile's when it is the
  -- same company, else a new one.
  if v_app.organization_id is not null
     and v_profile.organization_id is not null
     and v_app.organization_id <> v_profile.organization_id then
    raise exception 'approve_pilot_application: the application names organization % but the applicant belongs to organization %',
      v_app.organization_id, v_profile.organization_id
      using errcode = '22023';
  end if;
  v_org_id := coalesce(v_app.organization_id, v_profile.organization_id);

  if v_org_id is not null then
    select o.name, o.org_type into v_org_name, v_org_type
    from public.organizations o
    where o.id = v_org_id;
    if v_org_type is distinct from 'fleet' then
      raise exception 'approve_pilot_application: organization % is a % organization, not a fleet',
        v_org_id, coalesce(v_org_type, 'missing')
        using errcode = '22023';
    end if;
    -- Only the profile named it: join it only when it is the same company.
    if v_app.organization_id is null
       and public.normalize_company_name(v_org_name) <> public.normalize_company_name(v_app.company_name) then
      raise exception 'approve_pilot_application: the applicant already belongs to organization "%" (%), and this application is for "%". A person belongs to one organization, so link them by hand.',
        v_org_name, v_org_id, btrim(coalesce(v_app.company_name, ''))
        using errcode = '22023';
    end if;
  else
    v_org_name := nullif(btrim(v_app.company_name), '');
    if v_org_name is null then
      raise exception 'approve_pilot_application: the application has no company name to name the organization'
        using errcode = '22023';
    end if;
    insert into public.organizations (name, org_type, status, website, created_by)
    values (v_org_name, 'fleet', 'active', nullif(btrim(v_app.website), ''), v_caller)
    returning id into v_org_id;
    v_created := true;
  end if;

  if v_profile.organization_id is null then
    update public.profiles p
    set organization_id = v_org_id
    where p.id = v_profile.id;

    insert into public.role_history (
      user_id, old_role, new_role, old_status, new_status, changed_by, reason
    ) values (
      v_profile.id, v_profile.role, v_profile.role, v_profile.status, v_profile.status, v_caller,
      format('Pilot application %s approved: joined organization %s (%s)', v_app.id, v_org_name, v_org_id)
    );
  end if;

  v_status := case when v_app.status in ('approved', 'onboarding', 'active') then v_app.status else 'approved' end;

  -- Update only what is missing, so a second call changes nothing. A row
  -- approved before 027 without a reviewer gets one.
  if v_app.organization_id is distinct from v_org_id
     or v_app.status is distinct from v_status
     or v_app.reviewed_by is null
     or v_app.reviewed_at is null then
    update public.pilot_applications a
    set organization_id = v_org_id,
        status = v_status,
        reviewed_by = v_caller,
        reviewed_at = now()
    where a.id = v_app.id;
  end if;

  return jsonb_build_object(
    'application_id', v_app.id,
    'application_status', v_status,
    'organization_id', v_org_id,
    'organization_name', v_org_name,
    'organization_created', v_created,
    'owner_id', v_app.user_id
  );
end;
$$;

-- Admins call it from the site, signed in; the is_admin() check inside does
-- the rest. Supabase's default privileges grant EXECUTE on a new function to
-- anon, so revoke it explicitly.
revoke all on function public.approve_pilot_application(uuid) from public, anon;
grant execute on function public.approve_pilot_application(uuid) to authenticated, service_role;

comment on function public.approve_pilot_application(uuid) is
  'Admin only. Approves a pilot application and ties it and its applicant to a fleet organization, creating one if needed. Safe to call twice. Migration 027.';

-- The guard: no move into approved, onboarding or active without an
-- organization, whoever makes it. A trigger and not a check constraint, so
-- rows that are already in those stages without one (from before 027) can
-- still be edited, and approved.
create or replace function public.pilot_application_requires_organization()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status in ('approved', 'onboarding', 'active')
     and new.organization_id is null
     and (tg_op = 'INSERT'
          or old.status is distinct from new.status
          or old.organization_id is distinct from new.organization_id) then
    raise exception 'pilot_applications: an application needs its organization before it is %. Approve it with approve_pilot_application.',
      new.status
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Only the trigger calls it; Postgres checks EXECUTE when the trigger is
-- created, not when it fires.
revoke all on function public.pilot_application_requires_organization() from public, anon, authenticated;

drop trigger if exists pilot_application_requires_organization on public.pilot_applications;
create trigger pilot_application_requires_organization
  before insert or update of status, organization_id on public.pilot_applications
  for each row execute function public.pilot_application_requires_organization();

notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- Verify on live after applying (SQL editor), read-only:
--   select p.prosecdef, p.proconfig,
--          has_function_privilege('anon', p.oid, 'execute') as anon_execute,
--          has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
--          exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as public_execute
--   from pg_proc p
--   where p.oid = 'public.approve_pilot_application(uuid)'::regprocedure;
--   -> true, {"search_path=public, pg_temp"}, false, true, false
--   select count(*) from pg_trigger
--    where tgname = 'pilot_application_requires_organization' and not tgisinternal;
--   -> 1
--   Applications already past approval without an organization (approve each
--   one in the admin dialog):
--   select id, company_name, status from public.pilot_applications
--    where status in ('approved', 'onboarding', 'active') and organization_id is null;
--
-- Rollback (by hand): the site's Approve then fails with "function not
-- found", so publish the site from before this change first.
--   drop trigger pilot_application_requires_organization on public.pilot_applications;
--   drop function public.pilot_application_requires_organization();
--   drop function public.approve_pilot_application(uuid);
--   notify pgrst, 'reload schema';
-- Organizations it created stay. They are ordinary rows; delete one only
-- after clearing organization_id on the application and the profile.
-- ============================================================================
