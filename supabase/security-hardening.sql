-- RWDent - Supabase security hardening
-- Safe to paste in Supabase SQL Editor after making a backup.
-- This script does not delete patients, stock, prices, appointments, or financial data.

create extension if not exists pgcrypto;

-- Clinics owned by the logged-in user.
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

-- Real admin authorization should live in the database, not only in JavaScript.
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'admin_users'
      and policyname = 'admin_users_self_read'
  ) then
    create policy "admin_users_self_read"
      on public.admin_users
      for select
      to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

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

-- Safer public anamnese links.
-- Anonymous patients should use a random token, not paciente_id + clinica_id in the URL.
create table if not exists public.anamnese_links (
  token uuid primary key default gen_random_uuid(),
  paciente_id bigint not null references public.pacientes(id) on delete cascade,
  clinica_id bigint not null references public.clinicas(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.anamnese_links enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anamnese_links'
      and policyname = 'anamnese_links_owner_select'
  ) then
    create policy "anamnese_links_owner_select"
      on public.anamnese_links
      for select
      to authenticated
      using (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'anamnese_links'
      and policyname = 'anamnese_links_owner_insert'
  ) then
    create policy "anamnese_links_owner_insert"
      on public.anamnese_links
      for insert
      to authenticated
      with check (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin());
  end if;
end $$;

-- Public page reads only through this controlled function.
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

-- Public page writes only through this controlled function.
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

grant execute on function public.rwdent_get_anamnese_context(uuid) to anon;
grant execute on function public.rwdent_submit_anamnese(uuid, jsonb) to anon;

create index if not exists idx_clinicas_user_id on public.clinicas(user_id);
create index if not exists idx_anamnese_links_clinica_id on public.anamnese_links(clinica_id);
create index if not exists idx_anamnese_links_paciente_id on public.anamnese_links(paciente_id);
create index if not exists idx_anamnese_links_expires_at on public.anamnese_links(expires_at);

-- Optional indexes. Run only if these tables exist with clinica_id/data columns.
-- create index if not exists idx_pacientes_clinica_id on public.pacientes(clinica_id);
-- create index if not exists idx_agendamentos_clinica_id_data on public.agendamentos(clinica_id, data);
-- create index if not exists idx_profissionais_clinica_id on public.profissionais(clinica_id);
-- create index if not exists idx_anamneses_clinica_id on public.anamneses(clinica_id);
