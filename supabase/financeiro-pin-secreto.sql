-- PIN financeiro da secretária (protege o faturamento agregado da clínica)
--
-- Diferente do PIN operacional (financeiro_config.cfg.finPinHash, que fica
-- dentro de um JSON que o app carrega inteiro pro navegador — logo, seu hash
-- também vai pro navegador e é curto o bastante pra ser quebrado por força
-- bruta ali mesmo), este PIN fica numa tabela própria, com RLS habilitado e
-- SEM NENHUMA policy pra 'anon'/'authenticated'. Isso significa que nenhuma
-- consulta feita pelo app com a chave anônima consegue ler ou escrever aqui
-- — só a service role key (usada exclusivamente dentro de
-- api/financeiro-pin.js, que roda no servidor) tem acesso. O hash nunca é
-- enviado ao navegador, então não dá pra atacar por força bruta no console.

CREATE TABLE IF NOT EXISTS public.financeiro_pin_secreto (
  clinica_id uuid PRIMARY KEY REFERENCES public.clinicas(id) ON DELETE CASCADE,
  pin_hash   text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.financeiro_pin_secreto ENABLE ROW LEVEL SECURITY;

-- Nenhuma policy criada de propósito: por padrão o Postgres nega tudo pra
-- quem não é dono/superuser quando RLS está ligado, então 'anon' e
-- 'authenticated' (as roles que o app usa com a chave anônima/JWT do
-- usuário) não conseguem SELECT/INSERT/UPDATE/DELETE nesta tabela de jeito
-- nenhum. Só a service role (que ignora RLS) consegue — e ela só é usada
-- dentro do endpoint serverless, nunca no navegador.
