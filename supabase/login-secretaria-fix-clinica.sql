-- ============================================================================
-- RWDent — Correção: secretária não deve ler a linha inteira da clínica
-- ============================================================================
-- Achado em pentest: a policy clinicas_membro_select deixava a secretária ler
-- TODA a linha da clínica dela (select *), incluindo dados do dono que ela não
-- precisa: email, telefone, mp_subscription_id, mp_trial_dias, expira_em e o
-- user_id (uuid do dono). Nenhum é senha, mas é dado da conta do dentista.
--
-- Como RLS é por LINHA (não dá pra esconder coluna), a correção é:
--   1. Criar uma função que devolve só as colunas seguras da clínica do usuário.
--   2. Neutralizar a leitura direta da tabela pela secretária (a policy passa a
--      não conceder nada — sem DROP; usa ALTER). O dono continua lendo pela
--      policy dele (clinicas_admin_select), sem mudança.
--
-- Sem DROP/DELETE/TRUNCATE. Idempotente. O app (login da secretária) passa a
-- carregar a clínica por esta função.
-- ============================================================================

-- 1. Função: devolve só o que a tela precisa (nome, marca, status). Serve tanto
--    pro dono quanto pra secretária — a clínica é sempre a do próprio usuário.
create or replace function public.rwdent_minha_clinica()
returns table (
  id uuid,
  nome_cli text,
  nome_resp text,
  logo_url text,
  cor_marca text,
  status text
)
language sql stable security definer set search_path = public as $$
  select c.id, c.nome_cli, c.nome_resp, c.logo_url, c.cor_marca, c.status
  from public.clinicas c
  where c.user_id = auth.uid()
     or c.id in (select clinica_id from public.clinica_membros where user_id = auth.uid())
  limit 1;
$$;

grant execute on function public.rwdent_minha_clinica() to authenticated;

-- 2. Neutraliza a leitura direta da tabela clinicas pela secretária. A policy
--    continua existindo (sem DROP), mas passa a não liberar nenhuma linha — a
--    secretária lê a clínica só pela função acima. O dono NÃO é afetado (ele lê
--    pela policy clinicas_admin_select, que é outra).
do $$
begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename='clinicas' and policyname='clinicas_membro_select') then
    alter policy clinicas_membro_select on public.clinicas using (false);
  end if;
end $$;

comment on policy clinicas_membro_select on public.clinicas is
  'Neutralizada de propósito (using false): a secretária lê a clínica só via rwdent_minha_clinica(), que não expõe email/telefone/mp_*/user_id do dono.';

-- Conferência: mostra a policy neutralizada.
select policyname, qual from pg_policies
where schemaname='public' and tablename='clinicas' and policyname='clinicas_membro_select';
