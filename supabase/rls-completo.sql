-- ============================================================================
-- RWDent — Row Level Security (RLS) das tabelas principais
-- ============================================================================
-- POR QUE ISSO EXISTE
-- O app filtra os dados por clínica SÓ no navegador (.eq('clinica_id', ...)).
-- Isso é conveniência de tela, NÃO é segurança: a chave "anon" do Supabase é
-- pública (fica no código do front, como deve ser), então qualquer pessoa
-- logada em QUALQUER clínica pode abrir o console do navegador e pedir os
-- dados de OUTRA clínica trocando o clinica_id — a menos que o banco recuse.
-- Quem recusa é a RLS (Row Level Security): uma regra no próprio Postgres que
-- só deixa cada clínica ver/mexer nas próprias linhas, aconteça o que
-- acontecer no front.
--
-- Este script é IDEMPOTENTE (pode rodar de novo sem duplicar nada) e NÃO
-- contém DROP, DELETE nem TRUNCATE — não apaga nenhum dado. Ele só liga a RLS
-- e cria as regras de isolamento por clínica.
--
-- >>> ANTES DE RODAR <<<
--   1. Faça backup (Supabase → Database → Backups).
--   2. Rode PRIMEIRO só o "PASSO 0 — DIAGNÓSTICO" abaixo e veja o resultado.
--   3. Rode o resto.
--   4. Teste no app: login, pacientes, agenda, estoque, financeiro, anamnese
--      (link público), admin. Se algo sumiu, é policy — me avise, não force.
--
-- Depende de funções já criadas em security-hardening.sql:
--   - public.rwdent_user_clinica_ids()  → clínicas do usuário logado
--   - public.rwdent_is_admin()          → se o usuário é admin
-- Rode security-hardening.sql ANTES deste, se ainda não rodou.
-- ============================================================================


-- ============================================================================
-- PASSO 0 — DIAGNÓSTICO (rode isto sozinho primeiro e leia o resultado)
-- ============================================================================
-- Mostra, pra cada tabela principal: se a RLS está LIGADA e quantas policies
-- ela tem. "rls_ligada = false" numa tabela com dados de paciente é o alerta
-- vermelho — significa que hoje qualquer clínica logada pode ler as outras.
select
  t.tablename as tabela,
  t.rowsecurity as rls_ligada,
  (select count(*) from pg_policies p
     where p.schemaname = 'public' and p.tablename = t.tablename) as qtd_policies
from pg_tables t
where t.schemaname = 'public'
  and t.tablename in (
    'pacientes','agendamentos','anamneses','atendimentos_odonto',
    'procedimentos_dentes','plano_tratamento','financeiro_config',
    'profissionais','log_atividades','prontuarios'
  )
order by rls_ligada, tabela;


-- ============================================================================
-- PASSO 1 — LIGA A RLS + CRIA AS REGRAS DE ISOLAMENTO POR CLÍNICA
-- ============================================================================
-- Uma vez com RLS ligada e SEM policy, a tabela fica invisível pra todo mundo
-- (inclusive pro app) — por isso cada bloco liga a RLS e cria as 4 policies
-- (ver/inserir/atualizar/apagar) na MESMA passada. A regra é sempre a mesma:
-- "a linha só é acessível se o clinica_id dela for de uma clínica do usuário
--  logado — ou se o usuário for admin".
--
-- A anamnese pública (paciente sem login) NÃO é afetada: ela lê/escreve por
-- funções SECURITY DEFINER (rwdent_get_anamnese_context / rwdent_submit_anamnese),
-- que rodam com permissão de dono e passam por cima da RLS de propósito.

do $$
declare
  t text;
  tabelas text[] := array[
    'pacientes','agendamentos','anamneses','atendimentos_odonto',
    'procedimentos_dentes','plano_tratamento','financeiro_config',
    'profissionais','log_atividades'
  ];
begin
  foreach t in array tabelas loop
    -- Pula tabela que por acaso não exista nesta base, sem quebrar o resto.
    if not exists (select 1 from pg_tables where schemaname='public' and tablename=t) then
      raise notice 'tabela % não existe — pulando', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    -- SELECT
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_iso_select') then
      execute format($p$
        create policy %I on public.%I for select to authenticated
        using (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin())
      $p$, t||'_iso_select', t);
    end if;

    -- INSERT
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_iso_insert') then
      execute format($p$
        create policy %I on public.%I for insert to authenticated
        with check (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin())
      $p$, t||'_iso_insert', t);
    end if;

    -- UPDATE
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_iso_update') then
      execute format($p$
        create policy %I on public.%I for update to authenticated
        using (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin())
        with check (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin())
      $p$, t||'_iso_update', t);
    end if;

    -- DELETE
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_iso_delete') then
      execute format($p$
        create policy %I on public.%I for delete to authenticated
        using (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin())
      $p$, t||'_iso_delete', t);
    end if;

    raise notice 'RLS + policies aplicadas em %', t;
  end loop;
end $$;


-- ============================================================================
-- PASSO 2 — prontuarios (tratada à parte)
-- ============================================================================
-- prontuarios é lida no app junto de pacientes (pacientes(*, prontuarios(*))).
-- Dependendo de como a tabela foi criada, ela pode ter clinica_id próprio OU
-- se ligar ao paciente por paciente_id. Este bloco cobre os dois casos sem
-- adivinhar errado: usa clinica_id se a coluna existir; senão, isola via o
-- paciente dono (que já fica protegido pelo PASSO 1).
do $$
declare
  tem_clinica boolean;
  tem_paciente boolean;
begin
  if not exists (select 1 from pg_tables where schemaname='public' and tablename='prontuarios') then
    raise notice 'tabela prontuarios não existe — pulando';
    return;
  end if;

  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='prontuarios' and column_name='clinica_id')
    into tem_clinica;
  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='prontuarios' and column_name='paciente_id')
    into tem_paciente;

  alter table public.prontuarios enable row level security;

  if tem_clinica then
    if not exists (select 1 from pg_policies where schemaname='public' and tablename='prontuarios' and policyname='prontuarios_iso_all') then
      create policy prontuarios_iso_all on public.prontuarios for all to authenticated
        using (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin())
        with check (clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin());
    end if;
    raise notice 'prontuarios isolada por clinica_id';
  elsif tem_paciente then
    if not exists (select 1 from pg_policies where schemaname='public' and tablename='prontuarios' and policyname='prontuarios_iso_via_paciente') then
      create policy prontuarios_iso_via_paciente on public.prontuarios for all to authenticated
        using (exists (select 1 from public.pacientes pa
                       where pa.id = prontuarios.paciente_id
                         and (pa.clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin())))
        with check (exists (select 1 from public.pacientes pa
                       where pa.id = prontuarios.paciente_id
                         and (pa.clinica_id in (select public.rwdent_user_clinica_ids()) or public.rwdent_is_admin())));
    end if;
    raise notice 'prontuarios isolada via paciente_id';
  else
    raise notice 'prontuarios sem clinica_id nem paciente_id — revise manualmente antes de confiar';
  end if;
end $$;


-- ============================================================================
-- PASSO 3 — CONFERÊNCIA (rode e confirme que agora está tudo "true" e com 4 policies)
-- ============================================================================
select
  t.tablename as tabela,
  t.rowsecurity as rls_ligada,
  (select count(*) from pg_policies p
     where p.schemaname='public' and p.tablename=t.tablename) as qtd_policies
from pg_tables t
where t.schemaname='public'
  and t.tablename in (
    'pacientes','agendamentos','anamneses','atendimentos_odonto',
    'procedimentos_dentes','plano_tratamento','financeiro_config',
    'profissionais','log_atividades','prontuarios'
  )
order by rls_ligada, tabela;
