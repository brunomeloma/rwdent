-- RWDent — Supabase security hardening
--
-- IMPORTANT:
-- - Review before running in production.
-- - This script is intentionally non-destructive: no DROP, TRUNCATE, or DELETE.
-- - Run after backing up the database.
-- - Adjust table/column names if your schema differs.
-- - It preserves existing patients, stock, prices, appointments, and financial data.

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
-- 2. Admin allow-list table
-- ============================================================
-- The JavaScript ADMIN_EMAILS array is only UI convenience. Real admin
-- authorization should live in the database.

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
-- Apply table by table after confirming the schema.
-- Do not remove old policies until normal login/admin flows are tested.

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
-- Anonymous users should not read this table directly.

create table if not exists public.anamnese_links (
  token uuid primary key default gen_random_uuid(),
  paciente_id bigint not null references public.pacientes(id) on delete cascade,
  clinica_id bigint not null references public.clinicas(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.anamnese_links enable row level security;

create policy if not exists "anamnese_links_owner_select"
  on public.anamnese_links for select to authenticated
  using (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin());

create policy if not exists "anamnese_links_owner_insert"
  on public.anamnese_links for insert to authenticated
  with check (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin());

-- No anon SELECT policy on anamnese_links. Public reads go through RPC below.

create or replace function public.rwdent_get_anamnese_context(p_token uuid)
returns table (
  paciente_id bigint,
  clinica_id bigint,
  paciente_nome text,
  clinica_nome text,
  dados jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    al.paciente_id,
    al.clinica_id,
    p.nome as paciente_nome,
    c.nome_cli as clinica_nome,
    a.dados
  from public.anamnese_links al
  join public.pacientes p on p.id = al.paciente_id and p.clinica_id = al.clinica_id
  join public.clinicas c on c.id = al.clinica_id
  left join public.anamneses a on a.paciente_id = al.paciente_id and a.clinica_id = al.clinica_id
  where al.token = p_token
    and al.expires_at > now()
  limit 1;
$$;

create or replace function public.rwdent_submit_anamnese(p_token uuid, p_dados jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paciente_id bigint;
  v_clinica_id bigint;
begin
  select paciente_id, clinica_id
    into v_paciente_id, v_clinica_id
  from public.anamnese_links
  where token = p_token
    and expires_at > now()
  limit 1;

  if v_paciente_id is null or v_clinica_id is null then
    raise exception 'Invalid or expired anamnese link';
  end if;

  insert into public.anamneses (paciente_id, clinica_id, dados)
  values (v_paciente_id, v_clinica_id, p_dados)
  on conflict (paciente_id)
  do update set
    clinica_id = excluded.clinica_id,
    dados = excluded.dados;

  update public.anamnese_links
  set used_at = now()
  where token = p_token;
end;
$$;

-- Allow the public anamnese page to use only the safe RPC surface.
grant execute on function public.rwdent_get_anamnese_context(uuid) to anon;
grant execute on function public.rwdent_submit_anamnese(uuid, jsonb) to anon;

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
