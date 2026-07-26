-- ============================================================================
-- RWDent — SQL CONSOLIDADO do login da secretária (rode este INTEIRO, 1x)
-- ============================================================================
-- Junta TUDO num arquivo só, na ordem certa:
--   1. Fundação: tabela clinica_membros + funções + policies (idempotente).
--   2. Acesso da secretária às tabelas da clínica (policies aditivas).
--   3. Correção: secretária lê SÓ colunas seguras da clínica (via função),
--      nunca email/telefone/assinatura/user_id do dono.
--   4. Função rwdent_minha_clinica() na versão final: PREFERE a clínica onde a
--      pessoa é secretária (resolve a "clínica-fantasma" vazia que o cadastro
--      cria por baixo dos panos).
--
-- SEGURO: sem DROP/TRUNCATE de tabela; sem DELETE de dados de paciente/venda.
-- É ADITIVO e IDEMPOTENTE (pode rodar de novo). Enquanto não houver secretária,
-- o sistema se comporta igual a hoje. NÃO redefine my_clinica_ids() (a função
-- que protege o isolamento entre clínicas continua intocada).
--
-- >>> FAÇA BACKUP ANTES (Supabase → Database → Backups). <<<
-- Depois de rodar, teste: o DONO continua vendo tudo normal.
-- ============================================================================


-- ── 1. Tabela de associação (quem é secretária de qual clínica) ─────────────
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

-- Dono da clínica (para as policies de gestão de membros).
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

-- Policies da própria clinica_membros (não dependem de função de admin, cujo
-- nome varia entre bases — basta ser dono).
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


-- ── 2. Acesso da secretária às tabelas da clínica (policies ADITIVAS) ───────
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
      raise notice 'tabela % nao existe — pulando', t;
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

-- prontuarios: isola via o paciente dono (ou por clinica_id se a coluna existir)
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


-- ── 3. Secretária lê SÓ colunas seguras da clínica (nome/logo/cor/status) ───
-- Função que devolve a clínica do usuário SEM expor email/telefone/assinatura/
-- user_id do dono. PREFERE a clínica onde a pessoa é secretária — assim, se por
-- acaso existir uma "clínica-fantasma" vazia no nome dela, ela ainda cai na
-- clínica real onde trabalha.
create or replace function public.rwdent_minha_clinica()
returns table (
  id uuid, nome_cli text, nome_resp text, logo_url text, cor_marca text, status text
)
language sql stable security definer set search_path = public as $$
  select c.id, c.nome_cli, c.nome_resp, c.logo_url, c.cor_marca, c.status
  from public.clinicas c
  where c.id in (select clinica_id from public.clinica_membros where user_id = auth.uid())
     or c.user_id = auth.uid()
  order by (case when c.id in (select clinica_id from public.clinica_membros where user_id = auth.uid())
                 then 0 else 1 end)
  limit 1;
$$;
grant execute on function public.rwdent_minha_clinica() to authenticated;

-- Neutraliza a leitura DIRETA da tabela clinicas pela secretária (sem DROP —
-- só passa a não liberar linha nenhuma; ela lê pela função acima). O DONO NÃO é
-- afetado (ele lê pela policy dele, clinicas_admin_select). Se a policy de
-- membro ainda não existir (bases muito novas), cria já neutralizada.
do $$
begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='clinicas' and policyname='clinicas_membro_select') then
    alter policy clinicas_membro_select on public.clinicas using (false);
  else
    create policy clinicas_membro_select on public.clinicas for select to authenticated using (false);
  end if;
end $$;


-- ── 4. Conferência ─────────────────────────────────────────────────────────
select tablename, policyname, cmd
from pg_policies
where schemaname='public'
  and (tablename='clinica_membros' or policyname like '%membro%')
order by tablename, policyname;
