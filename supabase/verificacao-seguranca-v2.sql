-- RWDent — Verificação de segurança em UMA TABELA SÓ (SOMENTE LEITURA)
-- Roda tudo de uma vez, tira print do resultado inteiro e manda de volta.
-- Não altera nada no banco.
--
-- Cobre TODO SQL já pedido nesta conta até agora — se um dia eu (Claude)
-- perguntar de novo se algo já foi rodado, é só rodar este arquivo e
-- colar o resultado, em vez de confiar na memória da conversa.

select '1. Tabelas SEM proteção (RLS) ativada — deve ficar vazio' as verificacao,
       coalesce(string_agg(tablename, ', '), '✅ nenhuma — todas protegidas') as resultado
from pg_tables
where schemaname = 'public'
  and tablename in (
    'clinicas','pacientes','agendamentos','profissionais','anamneses',
    'anamnese_links','procedimentos_dentes','atendimentos_odonto',
    'plano_tratamento','financeiro_config','log_atividades','prontuarios','admin_users',
    'lista_espera'
  )
  and not rowsecurity

union all

select '2. Tabelas com proteção ligada mas SEM NENHUMA regra (ficam travadas por completo)',
       coalesce(string_agg(t.tablename, ', '), '✅ nenhuma')
from pg_tables t
where t.schemaname = 'public' and t.rowsecurity
  and t.tablename in (
    'clinicas','pacientes','agendamentos','profissionais','anamneses',
    'anamnese_links','procedimentos_dentes','atendimentos_odonto',
    'plano_tratamento','financeiro_config','log_atividades','prontuarios','admin_users',
    'lista_espera'
  )
  and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=t.tablename)

union all

select '3. Bucket de fotos "galeria" está privado?',
       case
         when exists(select 1 from storage.buckets where id='galeria' and public=false) then '✅ sim, privado'
         when exists(select 1 from storage.buckets where id='galeria' and public=true) then '❌ NÃO — está público!'
         else '⚠️ bucket "galeria" não existe ainda'
       end

union all

select '4. Regras antigas inseguras sobraram? (deve ficar vazio)',
       coalesce(
         (select string_agg(tablename||'.'||policyname, ', ')
          from pg_policies
          where schemaname in ('public','storage')
            and (qual ilike '%user_metadata%' or with_check ilike '%user_metadata%')),
         '✅ nenhuma'
       )

union all

select '5. Quantos admins cadastrados no banco',
       (select count(*)::text from public.admin_users)

union all

select '6. Conta demo — status atual',
       coalesce((select status from public.clinicas where email='demo@rwdent.app' limit 1), '⚠️ não encontrada')

union all

select '7. Tabela do PIN financeiro está travada corretamente (RLS ligado + zero regras)?',
       case
         when exists (select 1 from pg_tables where schemaname='public' and tablename='financeiro_pin_secreto' and rowsecurity)
              and not exists (select 1 from pg_policies where schemaname='public' and tablename='financeiro_pin_secreto')
         then '✅ sim, travada corretamente'
         when not exists (select 1 from pg_tables where schemaname='public' and tablename='financeiro_pin_secreto')
         then '⚠️ tabela ainda não existe'
         else '❌ tem alguma regra a mais — verificar manualmente'
       end

union all

select '8. Correção do brute-force do PIN (função no banco) já foi aplicada?',
       case when exists (select 1 from pg_proc where proname='financeiro_pin_registrar_erro')
            then '✅ sim' else '❌ não — falta rodar financeiro-pin-atomic.sql' end

union all

select '9. Trava anti-auto-aprovação de clínica (gatilho no banco) existe?',
       case when exists (select 1 from pg_trigger where tgname='trg_protect_clinica')
            then '✅ sim, protegida' else '❌ não encontrado — rodar supabase-seguranca.sql' end

union all

select '10. financeiro_pin_secreto tem colunas de rate-limit (tentativas_erradas/bloqueado_ate)?',
       case
         when not exists (select 1 from pg_tables where schemaname='public' and tablename='financeiro_pin_secreto')
         then '⚠️ tabela ainda não existe'
         when exists (select 1 from information_schema.columns where table_schema='public' and table_name='financeiro_pin_secreto' and column_name='tentativas_erradas')
              and exists (select 1 from information_schema.columns where table_schema='public' and table_name='financeiro_pin_secreto' and column_name='bloqueado_ate')
         then '✅ sim — financeiro-pin-rate-limit.sql aplicado'
         else '❌ não — rodar financeiro-pin-rate-limit.sql'
       end

union all

select '11. is_admin() já consulta a tabela admin_users (unificado com rwdent_is_admin)?',
       case when exists (select 1 from pg_proc where proname='is_admin' and prosrc ilike '%admin_users%')
            then '✅ sim — unificar-admin.sql aplicado' else '❌ não — rodar unificar-admin.sql' end

union all

select '12. clinicas tem as colunas de marca (logo_url/cor_marca)?',
       case
         when exists (select 1 from information_schema.columns where table_schema='public' and table_name='clinicas' and column_name='logo_url')
              and exists (select 1 from information_schema.columns where table_schema='public' and table_name='clinicas' and column_name='cor_marca')
         then '✅ sim — branding-clinica.sql aplicado'
         else '❌ não — rodar branding-clinica.sql'
       end

union all

select '13. Bucket "branding" (logo) existe, é público e SEM svg liberado?',
       case
         when not exists (select 1 from storage.buckets where id='branding')
         then '⚠️ bucket ainda não existe — rodar branding-clinica.sql'
         when exists (select 1 from storage.buckets where id='branding' and 'image/svg+xml' = any(allowed_mime_types))
         then '❌ ainda aceita SVG (risco de XSS) — rodar branding-clinica.sql de novo'
         when exists (select 1 from storage.buckets where id='branding' and public=true)
         then '✅ sim, correto (público, sem SVG)'
         else '⚠️ bucket existe mas não está público — verificar manualmente'
       end

union all

select '14. Tabela lista_espera existe com RLS ligado?',
       case
         when not exists (select 1 from pg_tables where schemaname='public' and tablename='lista_espera')
         then '⚠️ ainda não existe — rodar lista-espera.sql'
         when exists (select 1 from pg_tables where schemaname='public' and tablename='lista_espera' and rowsecurity)
         then '✅ sim — lista-espera.sql aplicado'
         else '❌ existe mas SEM RLS — verificar manualmente'
       end

union all

select '15. clinicas tem as colunas do Mercado Pago (assinatura/trial)?',
       case
         when exists (select 1 from information_schema.columns where table_schema='public' and table_name='clinicas' and column_name='mp_subscription_id')
              and exists (select 1 from information_schema.columns where table_schema='public' and table_name='clinicas' and column_name='mp_trial_dias')
         then '✅ sim'
         else '❌ não — rodar mercadopago-assinatura.sql e mercadopago-trial.sql'
       end
;
