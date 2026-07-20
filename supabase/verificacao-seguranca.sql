-- RWDent — Verificação de segurança (SOMENTE LEITURA)
-- Execute no Supabase SQL Editor. Não altera nada, só mostra o estado atual.
-- Cole os resultados de volta pra eu interpretar.

-- 1. RLS está ligado em todas as tabelas que têm dado de clínica/paciente?
select
  schemaname, tablename,
  rowsecurity as rls_ativo
from pg_tables
where schemaname = 'public'
  and tablename in (
    'clinicas','pacientes','agendamentos','profissionais','anamneses',
    'anamnese_links','procedimentos_dentes','atendimentos_odonto',
    'plano_tratamento','financeiro_config','log_atividades',
    'prontuarios','admin_users'
  )
order by tablename;

-- 2. Quantas policies cada tabela tem (0 = sem proteção nenhuma, mesmo com RLS ligado)
select
  schemaname, tablename, count(*) as qtd_policies
from pg_policies
where schemaname = 'public'
group by schemaname, tablename
order by tablename;

-- 3. O bucket "galeria" (fotos/radiografias) está privado?
select id, name, public, file_size_limit
from storage.buckets
where id = 'galeria';

-- 4. As policies de storage do bucket "galeria" isolam por clínica?
select policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname like 'galeria%';

-- 5. A conta demo existe e qual o status dela?
select id, email, nome_cli, status, user_id
from public.clinicas
where email = 'demo@rwdent.app' or nome_cli ilike '%demo%';

-- 6. Quem são os admins cadastrados no banco (não é a lista do front-end)
select user_id, email, created_at
from public.admin_users;

-- 7. Sobrou alguma policy insegura referenciando user_metadata?
-- (deve retornar ZERO linhas depois de rodar supabase-seguranca.sql)
select schemaname, tablename, policyname, cmd
from pg_policies
where schemaname in ('public','storage')
  and (qual ilike '%user_metadata%' or with_check ilike '%user_metadata%');
