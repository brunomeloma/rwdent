-- ============================================================================
-- RWDent — Ajustes de acesso (rode INTEIRO, 1x). Seguro e idempotente.
-- ============================================================================
-- 1) ADMIN deixa de ler/mexer nos DADOS de pacientes de outras clínicas. O
--    painel admin só precisa da LISTA de clínicas (tabela clinicas), então o
--    bypass is_admin() é removido das tabelas de dados — o admin passa a ver
--    só a própria clínica, como qualquer dono. (Fecha o furo achado no
--    pentest: uma conta admin invadida lia prontuários de todas as clínicas.)
-- 2) SECRETÁRIA fica SÓ-LEITURA nos profissionais — pode ver pra agendar, mas
--    não muda o dentista principal, nem cria/apaga profissional. Nome e cor da
--    clínica ela já não altera (a tabela clinicas é só-leitura pra ela).
-- 3) A função da clínica passa a devolver também expira_em, pra a secretária
--    respeitar o vencimento igual ao dono.
--
-- NÃO apaga dado nenhum. As policies do DONO e as _membro de leitura continuam.
-- >>> Faça backup antes (Supabase → Database → Backups). <<<
-- ============================================================================

-- ── 1. Tira o bypass is_admin() das tabelas de dados ────────────────────────
-- Mantém acesso do dono (my_clinica_ids). O admin continua vendo a LISTA de
-- clínicas (policies clinicas_admin_*), mas não os dados internos alheios.
-- As ações do painel que mexem em clínicas (aprovar, deletar) usam a service
-- role no servidor, que ignora RLS — então não dependem deste bypass.
do $$
declare t text;
  tabelas text[] := array[
    'pacientes','agendamentos','anamneses','atendimentos_odonto',
    'procedimentos_dentes','plano_tratamento','financeiro_config',
    'profissionais','log_atividades','lista_espera','anamnese_links'
  ];
begin
  foreach t in array tabelas loop
    if exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_rls') then
      execute format('alter policy %I on public.%I using (clinica_id in (select my_clinica_ids()))', t||'_rls', t);
      -- with check só existe em policy que permite escrita (FOR ALL); tenta e ignora se não aplicável
      begin
        execute format('alter policy %I on public.%I with check (clinica_id in (select my_clinica_ids()))', t||'_rls', t);
      exception when others then null; end;
    end if;
  end loop;
end $$;

-- prontuarios (isola via paciente, sem is_admin)
do $$ begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='prontuarios' and policyname='prontuarios_rls') then
    alter policy prontuarios_rls on public.prontuarios
      using (exists (select 1 from public.pacientes pa where pa.id=prontuarios.paciente_id and pa.clinica_id in (select my_clinica_ids())));
    begin
      alter policy prontuarios_rls on public.prontuarios
        with check (exists (select 1 from public.pacientes pa where pa.id=prontuarios.paciente_id and pa.clinica_id in (select my_clinica_ids())));
    exception when others then null; end;
  end if;
end $$;

-- ── 2. Secretária SÓ-LEITURA em profissionais ──────────────────────────────
-- Troca a policy de membro (que era FOR ALL) por uma só de SELECT: ela lê os
-- profissionais pra agendar, mas não pode inserir/alterar/apagar (nem mudar o
-- dentista principal).
drop policy if exists profissionais_membro on public.profissionais;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='profissionais' and policyname='profissionais_membro_ler') then
    create policy profissionais_membro_ler on public.profissionais
      for select to authenticated
      using (clinica_id in (select clinica_id from public.clinica_membros where user_id = auth.uid()));
  end if;
end $$;

-- ── 3. rwdent_minha_clinica() passa a devolver expira_em ────────────────────
-- Trocar as colunas de retorno exige recriar a função (drop + create). Só
-- remove/recria a FUNÇÃO (não toca em dado nenhum).
drop function if exists public.rwdent_minha_clinica();
create function public.rwdent_minha_clinica()
returns table (id uuid, nome_cli text, nome_resp text, logo_url text, cor_marca text, status text, expira_em timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, c.nome_cli, c.nome_resp, c.logo_url, c.cor_marca, c.status, c.expira_em
  from public.clinicas c
  where c.id in (select clinica_id from public.clinica_membros where user_id = auth.uid())
     or c.user_id = auth.uid()
  order by (case when c.id in (select clinica_id from public.clinica_membros where user_id = auth.uid())
                 then 0 else 1 end)
  limit 1;
$$;
grant execute on function public.rwdent_minha_clinica() to authenticated;

-- ── Conferência ─────────────────────────────────────────────────────────────
select tablename, policyname, cmd,
       (qual like '%is_admin%') as ainda_tem_bypass_admin
from pg_policies
where schemaname='public'
  and tablename in ('pacientes','profissionais','financeiro_config','clinicas')
order by tablename, policyname;
