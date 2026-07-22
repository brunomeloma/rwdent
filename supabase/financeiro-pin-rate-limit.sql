-- Trava o PIN financeiro depois de várias tentativas erradas seguidas,
-- pra impedir um script tentando senha atrás de senha (força bruta) contra
-- o endpoint /api/financeiro-pin. Sem isso, um PIN de 4 dígitos (10.000
-- combinações) seria só questão de tempo pra alguém técnico testar todas.

ALTER TABLE public.financeiro_pin_secreto
  ADD COLUMN IF NOT EXISTS tentativas_erradas int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bloqueado_ate timestamptz;
