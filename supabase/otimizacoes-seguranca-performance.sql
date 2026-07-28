-- ============================================================================
-- RWDent — Otimizações de segurança e performance (rode INTEIRO, 1x).
-- Seguro e idempotente. NÃO apaga nenhum dado, não muda o que cada pessoa
-- pode ou não fazer — só deixa as regras mais rápidas e fecha 1 furo real.
-- >>> Faça backup antes (Supabase → Database → Backups). <<<
-- ============================================================================
-- O que este arquivo faz:
-- 1) Balde de logo das clínicas (storage "branding"): hoje QUALQUER pessoa
--    consegue LISTAR os arquivos de logo de TODAS as clínicas (não é
--    prontuário nem dado sensível, mas não devia ser assim). Agora cada
--    clínica só lista a própria pasta. A logo continua aparecendo normal pra
--    todo mundo (isso usa um link público separado, que não passa por aqui).
-- 2) Várias tabelas tinham DUAS regras de segurança fazendo o mesmo trabalho
--    (uma pro dono, outra pra secretária) — o banco conferia as duas em toda
--    consulta. Agora viram UMA regra só, com a mesma permissão de sempre
--    (dono OU secretária vinculada), só que mais rápida.
-- 3) Índices que faltavam em várias tabelas (relação paciente/profissional/
--    clínica) — deixa as buscas mais rápidas conforme a base cresce.
--
-- O que este arquivo NÃO mexe (de propósito):
-- - profissionais: a trava de "secretária só lê, não edita" (nome/cor da
--   clínica, dentista principal) fica exatamente como está — não mistura
--   com a regra do dono pra não reabrir esse furo por engano.
-- - extensão pg_net (fica em schema público): mudar ela de lugar quebraria o
--   agendador das notificações push que acabamos de arrumar. Não vale o risco
--   por um item cosmético.
-- - índices "não usados": a base ainda é pequena, então isso não quer dizer
--   muito ainda; melhor não mexer.
-- ============================================================================

-- ── 1. Balde "branding": para de permitir listar tudo ──────────────────────
drop policy if exists branding_select on storage.objects;
create policy branding_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] in (
      select id::text from public.clinicas where user_id = (select auth.uid())
    )
  );

-- ── 2. Consolida regras duplicadas (dono + secretária em uma só) ───────────
-- Padrão repetido pras tabelas de dados da clínica: substitui as 2 policies
-- antigas (<tabela>_rls e <tabela>_membro) por 1 só com a mesma permissão.
do $$
declare t text;
  tabelas text[] := array[
    'agendamentos','anamnese_links','anamneses','atendimentos_odonto',
    'financeiro_config','log_atividades','pacientes','plano_tratamento',
    'procedimentos_dentes'
  ];
begin
  foreach t in array tabelas loop
    execute format('drop policy if exists %I on public.%I', t||'_rls', t);
    execute format('drop policy if exists %I on public.%I', t||'_membro', t);
    execute format($f$
      create policy %I on public.%I
        for all to authenticated
        using (
          clinica_id in (select my_clinica_ids())
          or clinica_id in (select clinica_id from public.clinica_membros where user_id = (select auth.uid()))
        )
        with check (
          clinica_id in (select my_clinica_ids())
          or clinica_id in (select clinica_id from public.clinica_membros where user_id = (select auth.uid()))
        )
    $f$, t||'_acesso', t);
  end loop;
end $$;

-- prontuarios: mesmo espírito, mas isola por paciente (não tem clinica_id direto).
drop policy if exists prontuarios_rls on public.prontuarios;
drop policy if exists prontuarios_membro on public.prontuarios;
create policy prontuarios_acesso on public.prontuarios
  for all to authenticated
  using (
    exists (
      select 1 from public.pacientes pa
      where pa.id = prontuarios.paciente_id
        and (
          pa.clinica_id in (select my_clinica_ids())
          or pa.clinica_id in (select clinica_id from public.clinica_membros where user_id = (select auth.uid()))
        )
    )
  )
  with check (
    exists (
      select 1 from public.pacientes pa
      where pa.id = prontuarios.paciente_id
        and (
          pa.clinica_id in (select my_clinica_ids())
          or pa.clinica_id in (select clinica_id from public.clinica_membros where user_id = (select auth.uid()))
        )
    )
  );

-- lista_espera: mesma consolidação (a antiga "isolamento" não usava my_clinica_ids()).
drop policy if exists lista_espera_isolamento on public.lista_espera;
drop policy if exists lista_espera_membro on public.lista_espera;
create policy lista_espera_acesso on public.lista_espera
  for all to authenticated
  using (
    clinica_id in (select my_clinica_ids())
    or clinica_id in (select clinica_id from public.clinica_membros where user_id = (select auth.uid()))
  )
  with check (
    clinica_id in (select my_clinica_ids())
    or clinica_id in (select clinica_id from public.clinica_membros where user_id = (select auth.uid()))
  );

-- profissionais: NÃO consolida (preserva de propósito dono=tudo / secretária=só lê).
-- Só "acelera" a parte da secretária, sem mudar a permissão.
drop policy if exists profissionais_membro_ler on public.profissionais;
create policy profissionais_membro_ler on public.profissionais
  for select to authenticated
  using (clinica_id in (select clinica_id from public.clinica_membros where user_id = (select auth.uid())));

-- clinicas: tinha regras antigas duplicadas (de uma versão anterior do
-- modelo) fazendo a mesma checagem 2x. Junta em 1, mantendo TODAS as
-- condições de antes (nada de acesso é removido, só junta).
drop policy if exists clinicas_select on public.clinicas;
drop policy if exists clinicas_select_own on public.clinicas;
create policy clinicas_select on public.clinicas
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or id = (select auth.uid())
    or (select is_admin())
    or (select auth.role()) = 'service_role'
  );

drop policy if exists clinicas_insert on public.clinicas;
drop policy if exists clinicas_insert_own on public.clinicas;
create policy clinicas_insert on public.clinicas
  for insert to authenticated
  with check (
    (user_id = (select auth.uid()) and status = 'pendente')
    or id = (select auth.uid())
  );

drop policy if exists clinicas_update on public.clinicas;
drop policy if exists clinicas_update_own on public.clinicas;
create policy clinicas_update on public.clinicas
  for update to authenticated
  using (
    user_id = (select auth.uid())
    or id = (select auth.uid())
    or (select is_admin())
    or (select auth.role()) = 'service_role'
  )
  with check (
    user_id = (select auth.uid())
    or id = (select auth.uid())
    or (select is_admin())
    or (select auth.role()) = 'service_role'
  );

drop policy if exists clinicas_delete on public.clinicas;
drop policy if exists clinicas_delete_own on public.clinicas;
create policy clinicas_delete on public.clinicas
  for delete to authenticated
  using (
    (select is_admin())
    or (select auth.role()) = 'service_role'
  );

-- Tabelas com 1 regra só (sem duplicidade), só acelera a checagem de auth.uid().
drop policy if exists admin_users_self_read on public.admin_users;
create policy admin_users_self_read on public.admin_users
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists push_sub_proprias on public.push_subscriptions;
create policy push_sub_proprias on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists clinica_membros_self_select on public.clinica_membros;
create policy clinica_membros_self_select on public.clinica_membros
  for select to authenticated
  using (user_id = (select auth.uid()) or rwdent_e_dono(clinica_id));

-- ── 3. Índices que faltavam (deixa buscas rápidas conforme a base cresce) ──
create index if not exists idx_agendamentos_clinica_id on public.agendamentos(clinica_id);
create index if not exists idx_agendamentos_paciente_id on public.agendamentos(paciente_id);
create index if not exists idx_agendamentos_prof_id on public.agendamentos(prof_id);
create index if not exists idx_atendimentos_odonto_clinica_id on public.atendimentos_odonto(clinica_id);
create index if not exists idx_atendimentos_odonto_paciente_id on public.atendimentos_odonto(paciente_id);
create index if not exists idx_atendimentos_odonto_profissional_id on public.atendimentos_odonto(profissional_id);
create index if not exists idx_financeiro_config_clinica_id on public.financeiro_config(clinica_id);
create index if not exists idx_lista_espera_clinica_id on public.lista_espera(clinica_id);
create index if not exists idx_lista_espera_paciente_id on public.lista_espera(paciente_id);
create index if not exists idx_plano_tratamento_clinica_id on public.plano_tratamento(clinica_id);
create index if not exists idx_plano_tratamento_paciente_id on public.plano_tratamento(paciente_id);
create index if not exists idx_procedimentos_dentes_clinica_id on public.procedimentos_dentes(clinica_id);
create index if not exists idx_procedimentos_dentes_paciente_id on public.procedimentos_dentes(paciente_id);
create index if not exists idx_procedimentos_dentes_profissional_id on public.procedimentos_dentes(profissional_id);
create index if not exists idx_profissionais_clinica_id on public.profissionais(clinica_id);
create index if not exists idx_prontuarios_clinica_id on public.prontuarios(clinica_id);
create index if not exists idx_prontuarios_paciente_id on public.prontuarios(paciente_id);
create index if not exists idx_prontuarios_profissional_id on public.prontuarios(profissional_id);

-- 4. audit_logs: só acelera a checagem de service_role na policy de DELETE
--    (não muda quem pode apagar — continua só admin/service role).
drop policy if exists audit_logs_delete_admin_only on public.audit_logs;
create policy audit_logs_delete_admin_only on public.audit_logs
  for delete to public
  using ((select auth.role()) = 'service_role'::text);

-- ── Conferência ─────────────────────────────────────────────────────────────
-- Deve mostrar 1 policy só por tabela nas listadas abaixo (não mais 2).
select tablename, count(*) as qtd_policies
from pg_policies
where schemaname='public'
  and tablename in ('agendamentos','pacientes','plano_tratamento','clinicas','prontuarios','lista_espera')
group by tablename
order by tablename;

-- ============================================================================
-- APLICADO EM PRODUÇÃO em 28/07/2026 via MCP do Supabase (não precisa rodar
-- de novo — fica aqui só como registro do que foi feito e por quê).
-- Resultado da auditoria depois de aplicar:
--   Segurança: furo do balde "branding" fechado. Restou só o que é por
--   design (funções SECURITY DEFINER que já se protegem sozinhas checando
--   auth.uid()) + a proteção de senha vazada, que só dá pra ligar pelo
--   painel (Authentication → Policies → "Leaked password protection").
--   Performance: auth_rls_initplan foi de 21 avisos pra ZERO. Restaram só
--   avisos INFO de "índice não usado" (esperado — acabamos de criar,
--   naturalmente ainda não tiveram tráfego) e 3 casos de "políticas
--   duplicadas" que ficaram de propósito:
--     - profissionais: preserva a trava dono=tudo / secretária=só-lê.
--     - clinicas: clinicas_membro_select (sempre nega) documenta que
--       secretária nunca lê a tabela clinicas direto, só via RPC.
--     - audit_logs: tabela vazia hoje, sem urgência de mexer mais.
-- ============================================================================
