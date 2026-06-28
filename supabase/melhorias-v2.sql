-- ═══════════════════════════════════════════════════════════
-- RWDent — Melhorias v2: Soft-delete + Log de atividades
-- Execute este SQL no Supabase SQL Editor
-- Seguro: usa IF NOT EXISTS, sem comandos destrutivos
-- ═══════════════════════════════════════════════════════════

-- 1. Colunas de soft-delete na tabela pacientes
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS arquivado boolean DEFAULT false;
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS arquivado_em timestamptz;

-- 2. Tabela de log de atividades (persistente)
CREATE TABLE IF NOT EXISTS log_atividades (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinica_id bigint REFERENCES clinicas(id),
  usuario text,
  acao text NOT NULL,
  detalhe text,
  created_at timestamptz DEFAULT now()
);

-- 3. RLS para log_atividades
ALTER TABLE log_atividades ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "log_atividades_select"
  ON log_atividades FOR SELECT
  USING (clinica_id IN (
    SELECT id FROM clinicas WHERE user_id = auth.uid()
  ));

CREATE POLICY IF NOT EXISTS "log_atividades_insert"
  ON log_atividades FOR INSERT
  WITH CHECK (clinica_id IN (
    SELECT id FROM clinicas WHERE user_id = auth.uid()
  ));

-- 4. Índice para consultas rápidas
CREATE INDEX IF NOT EXISTS idx_log_atividades_clinica
  ON log_atividades(clinica_id, created_at DESC);

-- 5. Índice para pacientes arquivados
CREATE INDEX IF NOT EXISTS idx_pacientes_arquivado
  ON pacientes(clinica_id, arquivado);
