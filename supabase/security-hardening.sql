-- RWDent — Supabase security hardening
--
-- IMPORTANT:
-- - Review before running in production.
-- - This script is intentionally non-destructive: no DROP, TRUNCATE, or DELETE.
-- - Run after backing up the database.
-- - Adjust table/column names if your schema differs.

-- ============================================================
-- 1. Helper: clinics owned by the logged-in user
-- ============================================================

create or replace function public.rwdent_user_clinica_ids()
returns setof bigint
language sql
stable
security definer
set search_path = public
as $$
  select id
  from public.clinicas
  where user_id = auth.uid();
$$;

-- ============================================================
-- 2. Optional admin allow-list table
-- ============================================================

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

create policy if not exists "admin_users_self_read"
  on public.admin_users
  for select
  to authenticated
  using (user_id = auth.uid());

create or replace function public.rwdent_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = auth.uid()
  );
$$;

-- After creating your admin auth user, add it manually, for example:
-- insert into public.admin_users (user_id, email)
-- values ('USER_UUID_HERE', 'admin@rwdent.com')
-- on conflict (user_id) do nothing;

-- ============================================================
-- 3. RLS templates for clinic-owned tables
-- ============================================================
-- These policies assume each table has a clinica_id column.
-- Uncomment and run table by table after confirming the schema.

-- alter table public.pacientes enable row level security;
-- create policy if not exists "pacientes_owner_select"
--   on public.pacientes for select to authenticated
--   using (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin());
-- create policy if not exists "pacientes_owner_insert"
--   on public.pacientes for insert to authenticated
--   with check (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin());
-- create policy if not exists "pacientes_owner_update"
--   on public.pacientes for update to authenticated
--   using (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin())
--   with check (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin());
-- create policy if not exists "pacientes_owner_delete"
--   on public.pacientes for delete to authenticated
--   using (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin());

-- Repeat the same pattern for:
-- profissionais, agendamentos, financeiro_config, anamneses, galerias/fotos,
-- and any other table with clinic data.

-- ============================================================
-- 4. Safer public anamnese links
-- ============================================================
-- Current public links should not rely only on paciente_id and clinica_id.
-- This table lets the app generate one random token per form link.

create table if not exists public.anamnese_links (
  token uuid primary key default gen_random_uuid(),
  paciente_id bigint not null references public.pacientes(id) on delete cascade,
  clinica_id bigint not null references public.clinicas(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.anamnese_links enable row level security;

-- Authenticated clinic users can create and inspect their own links.
create policy if not exists "anamnese_links_owner_select"
  on public.anamnese_links for select to authenticated
  using (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin());

create policy if not exists "anamnese_links_owner_insert"
  on public.anamnese_links for insert to authenticated
  with check (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin());

-- Anonymous patients may read only a valid, non-expired token row by exact token filter.
-- Supabase still requires the client query to filter by token.
create policy if not exists "anamnese_links_anon_valid_select"
  on public.anamnese_links for select to anon
  using (expires_at > now());

-- ============================================================
-- 5. Helpful indexes, non-destructive
-- ============================================================

create index if not exists idx_clinicas_user_id on public.clinicas(user_id);
create index if not exists idx_anamnese_links_clinica_id on public.anamnese_links(clinica_id);
create index if not exists idx_anamnese_links_paciente_id on public.anamnese_links(paciente_id);
create index if not exists idx_anamnese_links_expires_at on public.anamnese_links(expires_at);

-- Add similar indexes after confirming table existence:
-- create index if not exists idx_pacientes_clinica_id on public.pacientes(clinica_id);
-- create index if not exists idx_agendamentos_clinica_id_data on public.agendamentos(clinica_id, data);
-- create index if not exists idx_profissionais_clinica_id on public.profissionais(clinica_id);
-- create index if not exists idx_anamneses_clinica_id on public.anamneses(clinica_id);
