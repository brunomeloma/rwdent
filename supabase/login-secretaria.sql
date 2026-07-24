-- ============================================================================
-- RWDent — Login separado da secretária (perfil "secretária")
-- ============================================================================
-- O QUE ESTE SCRIPT FAZ
--   1. Cria a tabela clinica_membros (quem é secretária de qual clínica).
--   2. Liga RLS nela com regras seguras.
--   3. Dá à secretária acesso à clínica dela SEM tocar em nada que já existe:
--      adiciona UMA policy nova por tabela (additiva). As policies e a função
--      my_clinica_ids() de hoje ficam INTACTAS.
--
-- POR QUE É SEGURO RODAR
--   - NÃO tem DROP, DELETE nem TRUNCATE — não apaga dado nenhum.
--   - É IDEMPOTENTE: pode rodar de novo sem duplicar nada.
--   - É ADITIVO: enquanto não existir secretária cadastrada, o sistema se
--     comporta EXATAMENTE como hoje. As policies novas só concedem acesso a
--     quem estiver em clinica_membros — tabela que nasce vazia.
--   - NÃO redefine my_clinica_ids() (não arrisca quebrar o acesso do dono nem
--     o isolamento entre clínicas). Em vez disso, cada tabela ganha uma policy
--     paralela que checa a associação. Policies "permissive" se somam com OU,
--     então o dono continua entrando pela policy antiga e a secretária entra
--     pela nova.
--
-- >>> ANTES DE RODAR: faça backup (Supabase → Database → Backups). <<<
-- Depois de rodar, teste no app: dono continua vendo tudo normal.
-- (O login da secretária em si é criado pelo app, não por aqui.)
-- ============================================================================

-- ── 1. Tabela de associação ────────────────────────────────────────────────
create table if not exists public.clinica_membros (
  user_id    uuid not null references auth.users(id) on delete cascade,
  clinica_id uuid not null references public.clinicas(id) on delete cascade,
  papel      text not null default 'secretaria' check (papel in ('secretaria')),
  created_at timestamptz not null default now(),
  primary key (user_id, clinica_id)
);

create index if not exists idx_clinica_membros_user    on public.clinica_membros(user_id);
create index if not exists idx_clinica_membros_clinica on public.clinica_membros(clinica_id);

alter table public.clinica_membros enable row level security;

-- Quem é dono da clínica (para as policies de gestão de membros). Não depende
-- de my_clinica_ids() de propósito, pra não misturar "dono" com "membro".
create or replace function public.rwdent_e_dono(p_clinica_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.clinicas c
                 where c.id = p_clinica_id and c.user_id = auth.uid());
$$;

-- Papel do usuário logado numa clínica: 'dono', 'secretaria' ou null.
create or replace function public.meu_papel(p_clinica_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.clinicas c where c.id = p_clinica_id and c.user_id = auth.uid())
      then 'dono'
    when exists (select 1 from public.clinica_membros m where m.clinica_id = p_clinica_id and m.user_id = auth.uid())
      then (select papel from public.clinica_membros m where m.clinica_id = p_clinica_id and m.user_id = auth.uid())
    else null
  end;
$$;

-- Policies da própria clinica_membros:
--  - o usuário lê as próprias linhas (pra saber que é secretária e de qual clínica);
--  - o dono lê/gerencia os membros da clínica dele;
--  - admin vê tudo.
-- Obs: de propósito NÃO dependemos de nenhuma função de admin aqui, porque o
-- nome dela varia entre bases (is_admin / rwdent_is_admin). Pra gerir membros
-- basta ser dono (rwdent_e_dono, definida acima). Admin, se precisar, mexe pelo
-- painel do Supabase (é superusuário lá). Isso deixa a migração sem depender de
-- nenhuma função de nome incerto.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='clinica_membros' and policyname='clinica_membros_self_select') then
    create policy clinica_membros_self_select on public.clinica_membros
      for select to authenticated
      using (user_id = auth.uid() or public.rwdent_e_dono(clinica_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='clinica_membros' and policyname='clinica_membros_owner_insert') then
    create policy clinica_membros_owner_insert on public.clinica_membros
      for insert to authenticated
      with check (public.rwdent_e_dono(clinica_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='clinica_membros' and policyname='clinica_membros_owner_delete') then
    create policy clinica_membros_owner_delete on public.clinica_membros
      for delete to authenticated
      using (public.rwdent_e_dono(clinica_id));
  end if;
end $$;


-- ── 1b. A secretária precisa LER (só ler) a linha da própria clínica ────────
-- A RLS de clinicas hoje só deixa o dono (user_id = auth.uid()) ou admin. Sem
-- isto, a secretária nem carregaria o nome/branding da clínica dela no login.
-- É SELECT apenas — ela nunca altera configurações da clínica (nome, cor, PIN).
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='clinicas' and policyname='clinicas_membro_select') then
    create policy clinicas_membro_select on public.clinicas
      for select to authenticated
      using (id in (select clinica_id from public.clinica_membros where user_id = auth.uid()));
  end if;
end $$;


-- ── 2. Acesso da secretária às tabelas da clínica (policies ADITIVAS) ───────
-- Uma policy nova "<tabela>_membro" por tabela, FOR ALL, que concede acesso a
-- quem for MEMBRO daquela clínica. As policies antigas (do dono) continuam
-- valendo em paralelo. Se clinica_membros estiver vazia, nada é concedido.
do $$
declare
  t text;
  tabelas text[] := array[
    'pacientes','agendamentos','anamneses','atendimentos_odonto',
    'procedimentos_dentes','plano_tratamento','financeiro_config',
    'profissionais','log_atividades','lista_espera','anamnese_links'
  ];
begin
  foreach t in array tabelas loop
    if not exists (select 1 from pg_tables where schemaname='public' and tablename=t) then
      raise notice 'tabela % não existe — pulando', t;
      continue;
    end if;
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_membro') then
      execute format($p$
        create policy %I on public.%I for all to authenticated
        using (clinica_id in (select clinica_id from public.clinica_membros where user_id = auth.uid()))
        with check (clinica_id in (select clinica_id from public.clinica_membros where user_id = auth.uid()))
      $p$, t||'_membro', t);
      raise notice 'policy de membro criada em %', t;
    end if;
  end loop;
end $$;

-- prontuarios: isola via o paciente dono (mesma lógica das outras, mas por join)
do $$
begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='prontuarios')
     and not exists (select 1 from pg_policies where schemaname='public' and tablename='prontuarios' and policyname='prontuarios_membro') then
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='prontuarios' and column_name='clinica_id') then
      create policy prontuarios_membro on public.prontuarios for all to authenticated
        using (clinica_id in (select clinica_id from public.clinica_membros where user_id = auth.uid()))
        with check (clinica_id in (select clinica_id from public.clinica_membros where user_id = auth.uid()));
    else
      create policy prontuarios_membro on public.prontuarios for all to authenticated
        using (exists (select 1 from public.pacientes pa
                       where pa.id = prontuarios.paciente_id
                         and pa.clinica_id in (select clinica_id from public.clinica_membros where user_id = auth.uid())))
        with check (exists (select 1 from public.pacientes pa
                       where pa.id = prontuarios.paciente_id
                         and pa.clinica_id in (select clinica_id from public.clinica_membros where user_id = auth.uid())));
    end if;
  end if;
end $$;


-- ── 3. Conferência ─────────────────────────────────────────────────────────
-- Deve listar clinica_membros com RLS ligada, e uma policy "<t>_membro" em cada
-- tabela principal (além das "<t>_rls" que já existiam).
select tablename, policyname, cmd
from pg_policies
where schemaname='public'
  and (tablename='clinica_membros' or policyname like '%membro%')
order by tablename, policyname;
