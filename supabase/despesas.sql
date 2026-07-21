-- ═══════════════════════════════════════════════════════════
-- RWDent — Despesas (protético, laboratório etc.)
-- Execute no Supabase SQL Editor. Idempotente, sem comandos destrutivos.
-- ═══════════════════════════════════════════════════════════

-- Guarda a lista de despesas como JSON, no mesmo padrão já usado pra
-- "vendas"/"procs"/"combos" dentro de financeiro_config — não precisa de
-- tabela nem policy nova, já herda o RLS que protege financeiro_config.
ALTER TABLE public.financeiro_config ADD COLUMN IF NOT EXISTS despesas TEXT DEFAULT '[]';
