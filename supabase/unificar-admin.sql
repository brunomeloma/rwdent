-- Unifica as duas fontes de "quem é admin" que existiam no banco.
--
-- is_admin() (usada nas regras de acesso da tabela clinicas e na trava
-- anti-auto-aprovação) tinha sua PRÓPRIA lista de IDs escrita direto no
-- SQL, separada da tabela admin_users (usada por rwdent_is_admin(), que
-- protege os endpoints /api/mercadopago-criar-assinatura,
-- /api/admin-reset-demo-password etc). As duas listas coincidem hoje, mas
-- se um dia alguém adicionar um admin só numa das duas, ele fica admin
-- num lugar e não no outro sem perceber — inconsistência silenciosa.
--
-- Esta migração faz is_admin() consultar admin_users também, então passa
-- a existir UMA fonte de verdade só: a tabela admin_users. Pra adicionar
-- um novo admin, basta um INSERT nela (rwdent_is_admin() e is_admin()
-- passam a valer os dois automaticamente).
--
-- Mantém os 2 IDs fixos que já eram admin como um "OR" de segurança (se a
-- tabela admin_users ficar vazia por engano, esses 2 continuam com
-- acesso — evita se trancar fora do próprio painel).

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT auth.uid() IN (
    '09f21b22-76c8-4aee-8af4-9fc292ff08d4'::uuid,
    'b39d8b67-0610-4708-9733-104db7f0307b'::uuid
  ) OR EXISTS (
    SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()
  )
$$;
