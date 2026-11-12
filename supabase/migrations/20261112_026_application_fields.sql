-- ============================================================================
-- 20261112_026_application_fields.sql
--
-- The /apply form now asks for what a pilot needs on the day a fleet applies
-- (Linear CRU-90). fms_provider, fms_other and primary_lanes already exist
-- (014) and the form sets them again. This file adds the rest:
--
--   truck_count            the exact number of trucks, 1 to 1,000,000
--   data_authorizer_name   who at the fleet can authorize data access
--   data_authorizer_email
--   tablet_model           the tablets the drivers will use
--   tablet_count           0 to 1,000,000
--   tablet_management      who manages them: fleet_mdm, cruze or manual
--   safety_contact_name
--   safety_contact_email
--
-- fleet_size stays. Old rows hold a size bucket there ("101-500"). New rows
-- hold the same number as truck_count, as text, so every screen and report
-- that prints fleet_size keeps working. A check holds the two together.
--
-- Applicants may insert the new columns and nothing else new. 025 limited
-- inserts to the wizard's columns with column grants; this restates that list
-- with the eight columns added. The staff columns (fleet_visible_message,
-- reviewed_by, reviewed_at, notes, organization_id) stay closed, and anon
-- still cannot insert. The test holds the grant to this exact list, so a
-- column added later is closed until a migration opens it.
--
-- The signed LOI must name the truck count the applicant typed. The policy
-- "Users sign own LOI" (007) checked only user_id, so an applicant could tie
-- an LOI to anyone's application, or to none. It now requires:
--   * an application, and the signer's own;
--   * the LOI's fleet_size to equal that application's truck_count, or its
--     fleet_size for an application from the old form (a size bucket);
--   * when the application has a truck_count, the LOI text to contain the
--     sentence "Fleet Integration: <count> vehicles shall be enrolled." as
--     src/lib/loi.ts renders it. A change to that sentence needs a migration
--     that changes this policy too (src/lib/loi.test.ts pins it).
-- The text is still rendered in the browser, so the rest of it is what the
-- signer's browser sent, as before.
--
-- Order: apply this file before the site with the new form is published (its
-- insert names the new columns) and before notify-discord is redeployed (it
-- reads them). The old site and the old function keep working with this file
-- applied: the old form sends none of the new columns, so its rows have no
-- truck_count, and its LOI links the application it just made and repeats
-- that application's size bucket, which the policy accepts.
--
-- Idempotent: safe to run more than once.
-- Test: supabase/tests/026_application_fields.test.sql
-- ============================================================================

-- (1) The columns. Each check belongs to its column, so a second run skips
-- both. A null passes every check: the old form sends none of these, and the
-- new form leaves the people and tablet answers empty when they are skipped.
alter table public.pilot_applications
  add column if not exists truck_count integer
    check (truck_count between 1 and 1000000),
  add column if not exists data_authorizer_name text
    check (char_length(data_authorizer_name) <= 200),
  add column if not exists data_authorizer_email text
    check (char_length(data_authorizer_email) <= 320),
  add column if not exists tablet_model text
    check (char_length(tablet_model) <= 200),
  add column if not exists tablet_count integer
    check (tablet_count between 0 and 1000000),
  add column if not exists tablet_management text
    check (tablet_management in ('fleet_mdm', 'cruze', 'manual')),
  add column if not exists safety_contact_name text
    check (char_length(safety_contact_name) <= 200),
  add column if not exists safety_contact_email text
    check (char_length(safety_contact_email) <= 320);

-- (2) fleet_size repeats truck_count wherever a truck count is given. "is not
-- distinct from" so a null fleet_size fails too (a plain = would be null,
-- which a check lets through).
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.pilot_applications'::regclass
                   and conname = 'pilot_applications_fleet_size_is_truck_count') then
    alter table public.pilot_applications
      add constraint pilot_applications_fleet_size_is_truck_count
      check (truck_count is null or fleet_size is not distinct from truck_count::text);
  end if;
end $$;

comment on column public.pilot_applications.truck_count is
  'Exact number of trucks, typed by the applicant on /apply. The signed LOI names this number.';
comment on column public.pilot_applications.fleet_size is
  'What older screens print: a size bucket on rows from before 026, the truck_count as text on newer rows.';
comment on column public.pilot_applications.primary_lanes is
  'Domicile sites or lanes, as the applicant typed them on /apply.';
comment on column public.pilot_applications.data_authorizer_name is
  'Person at the fleet who can authorize access to its ELD or telematics data.';
comment on column public.pilot_applications.tablet_management is
  'Who manages the tablets: fleet_mdm (the fleet''s MDM), cruze, or manual (by hand).';

-- (3) Applicants insert the wizard's columns only (src/lib/pilotApplication.ts,
-- pilotInsertFromWizard): the 14 from 025 and the eight above. Revoking the
-- table privilege also revokes every column grant, so this list is the whole
-- grant, whatever was there before.
revoke insert on public.pilot_applications from anon, authenticated;
grant insert (
  user_id, company_name, truck_size, fleet_size, website, primary_lanes,
  fms_provider, fms_other, contact_name, contact_email, contact_phone,
  contact_title, application_notes, status,
  truck_count, data_authorizer_name, data_authorizer_email, tablet_model,
  tablet_count, tablet_management, safety_contact_name, safety_contact_email
) on public.pilot_applications to authenticated;

-- (4) An LOI ties only to the signer's own application and names its truck
-- count. The outer columns are qualified because pilot_applications has a
-- fleet_size column too. A null pilot_application_id matches no row, so it
-- is refused.
drop policy if exists "Users sign own LOI" on public.loi_signatures;
create policy "Users sign own LOI" on public.loi_signatures
  for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.pilot_applications p
      where p.id = loi_signatures.pilot_application_id
        and p.user_id = auth.uid()
        and loi_signatures.fleet_size = coalesce(p.truck_count::text, p.fleet_size)
        and (
          p.truck_count is null
          or strpos(loi_signatures.loi_full_text,
                    'Fleet Integration: ' || p.truck_count::text || ' vehicles shall be enrolled.') > 0
        )
    )
  );

-- Make PostgREST pick up the new columns straight away.
notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- Verify on live after applying (SQL editor), read-only:
--   select
--     (select count(*) from information_schema.columns
--       where table_schema = 'public' and table_name = 'pilot_applications'
--         and column_name in ('truck_count', 'data_authorizer_name', 'data_authorizer_email',
--                             'tablet_model', 'tablet_count', 'tablet_management',
--                             'safety_contact_name', 'safety_contact_email')) as new_columns,
--     has_table_privilege('authenticated', 'public.pilot_applications', 'insert') as table_insert,
--     has_column_privilege('authenticated', 'public.pilot_applications', 'truck_count', 'insert') as truck_count_insert,
--     has_column_privilege('authenticated', 'public.pilot_applications', 'fleet_visible_message', 'insert') as message_insert,
--     has_column_privilege('authenticated', 'public.pilot_applications', 'organization_id', 'insert') as organization_insert,
--     has_any_column_privilege('anon', 'public.pilot_applications', 'insert') as anon_insert,
--     (select count(*) from pg_constraint where conname = 'pilot_applications_fleet_size_is_truck_count') as size_check,
--     (select pg_get_expr(polwithcheck, polrelid) like '%truck_count%' from pg_policy
--       where polrelid = 'public.loi_signatures'::regclass and polname = 'Users sign own LOI') as loi_policy;
--   -> 8, false, true, false, false, false, 1, true
--
-- Rollback, by hand. Run it only before an application has used the new
-- columns, or those answers are lost, and only with the old form published,
-- because the new form's insert names these columns. Dropping a column drops
-- its checks and its grant with it:
--   drop policy "Users sign own LOI" on public.loi_signatures;
--   create policy "Users sign own LOI" on public.loi_signatures
--     for insert with check (auth.uid() = user_id);
--   alter table public.pilot_applications
--     drop column truck_count, drop column data_authorizer_name,
--     drop column data_authorizer_email, drop column tablet_model,
--     drop column tablet_count, drop column tablet_management,
--     drop column safety_contact_name, drop column safety_contact_email;
--   notify pgrst, 'reload schema';
-- ============================================================================
