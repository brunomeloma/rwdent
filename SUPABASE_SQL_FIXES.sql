-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔒 RWDent - SQL SECURITY FIXES
-- Cole tudo isso no Supabase SQL Editor e execute
-- Timestamp: 2026-07-15
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 1: HABILITAR ROW LEVEL SECURITY (RLS) EM TODAS AS TABELAS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Tabela: clinicas
ALTER TABLE clinicas ENABLE ROW LEVEL SECURITY;

-- Tabela: pacientes
ALTER TABLE pacientes ENABLE ROW LEVEL SECURITY;

-- Tabela: agendamentos
ALTER TABLE agendamentos ENABLE ROW LEVEL SECURITY;

-- Tabela: vendas
ALTER TABLE vendas ENABLE ROW LEVEL SECURITY;

-- Tabela: profissionais
ALTER TABLE profissionais ENABLE ROW LEVEL SECURITY;

-- Tabela: procedimentos
ALTER TABLE procedimentos ENABLE ROW LEVEL SECURITY;

-- Tabela: log_atividades
ALTER TABLE log_atividades ENABLE ROW LEVEL SECURITY;

-- Tabela: anamnese_links (se existir)
ALTER TABLE anamnese_links ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 2: CRIAR POLÍTICAS DE ACESSO (RLS POLICIES)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────────
-- CLINICAS - Cada clínica só acessa seus próprios dados
-- ───────────────────────────────────────────────────────────────────────────────

CREATE POLICY "clinicas_select_own"
  ON clinicas
  FOR SELECT
  USING (id = auth.uid() OR auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "clinicas_insert_own"
  ON clinicas
  FOR INSERT
  WITH CHECK (id = auth.uid());

CREATE POLICY "clinicas_update_own"
  ON clinicas
  FOR UPDATE
  USING (id = auth.uid() OR auth.jwt() ->> 'role' = 'admin')
  WITH CHECK (id = auth.uid() OR auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "clinicas_delete_own"
  ON clinicas
  FOR DELETE
  USING (auth.jwt() ->> 'role' = 'admin');

-- ───────────────────────────────────────────────────────────────────────────────
-- PACIENTES - Pacientes pertencem a uma clínica
-- ───────────────────────────────────────────────────────────────────────────────

CREATE POLICY "pacientes_select_own_clinic"
  ON pacientes
  FOR SELECT
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid OR auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "pacientes_insert_own_clinic"
  ON pacientes
  FOR INSERT
  WITH CHECK (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "pacientes_update_own_clinic"
  ON pacientes
  FOR UPDATE
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "pacientes_delete_own_clinic"
  ON pacientes
  FOR DELETE
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid AND auth.jwt() ->> 'role' = 'admin');

-- ───────────────────────────────────────────────────────────────────────────────
-- AGENDAMENTOS - Agendamentos da clínica
-- ───────────────────────────────────────────────────────────────────────────────

CREATE POLICY "agendamentos_select_own_clinic"
  ON agendamentos
  FOR SELECT
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid OR auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "agendamentos_insert_own_clinic"
  ON agendamentos
  FOR INSERT
  WITH CHECK (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "agendamentos_update_own_clinic"
  ON agendamentos
  FOR UPDATE
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "agendamentos_delete_own_clinic"
  ON agendamentos
  FOR DELETE
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

-- ───────────────────────────────────────────────────────────────────────────────
-- VENDAS - Vendas da clínica
-- ───────────────────────────────────────────────────────────────────────────────

CREATE POLICY "vendas_select_own_clinic"
  ON vendas
  FOR SELECT
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid OR auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "vendas_insert_own_clinic"
  ON vendas
  FOR INSERT
  WITH CHECK (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "vendas_update_own_clinic"
  ON vendas
  FOR UPDATE
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "vendas_delete_own_clinic"
  ON vendas
  FOR DELETE
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid AND auth.jwt() ->> 'role' = 'admin');

-- ───────────────────────────────────────────────────────────────────────────────
-- PROFISSIONAIS - Profissionais da clínica
-- ───────────────────────────────────────────────────────────────────────────────

CREATE POLICY "profissionais_select_own_clinic"
  ON profissionais
  FOR SELECT
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid OR auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "profissionais_insert_own_clinic"
  ON profissionais
  FOR INSERT
  WITH CHECK (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "profissionais_update_own_clinic"
  ON profissionais
  FOR UPDATE
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "profissionais_delete_own_clinic"
  ON profissionais
  FOR DELETE
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid AND auth.jwt() ->> 'role' = 'admin');

-- ───────────────────────────────────────────────────────────────────────────────
-- PROCEDIMENTOS - Procedimentos da clínica
-- ───────────────────────────────────────────────────────────────────────────────

CREATE POLICY "procedimentos_select_own_clinic"
  ON procedimentos
  FOR SELECT
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid OR auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "procedimentos_insert_own_clinic"
  ON procedimentos
  FOR INSERT
  WITH CHECK (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "procedimentos_update_own_clinic"
  ON procedimentos
  FOR UPDATE
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid)
  WITH CHECK (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "procedimentos_delete_own_clinic"
  ON procedimentos
  FOR DELETE
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid AND auth.jwt() ->> 'role' = 'admin');

-- ───────────────────────────────────────────────────────────────────────────────
-- LOG_ATIVIDADES - Log de auditoria da clínica
-- ───────────────────────────────────────────────────────────────────────────────

CREATE POLICY "log_atividades_select_own_clinic"
  ON log_atividades
  FOR SELECT
  USING (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid OR auth.jwt() ->> 'role' = 'admin');

CREATE POLICY "log_atividades_insert_own_clinic"
  ON log_atividades
  FOR INSERT
  WITH CHECK (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "log_atividades_delete_admin_only"
  ON log_atividades
  FOR DELETE
  USING (auth.jwt() ->> 'role' = 'admin');

-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 3: CRIAR TABELA DE AUDITORIA (OPTIONAL MAS RECOMENDADO)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  clinica_id UUID NOT NULL REFERENCES clinicas(id) ON DELETE CASCADE,
  usuario_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tabela TEXT NOT NULL,
  acao TEXT NOT NULL CHECK (acao IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')),
  dados_antigos JSONB,
  dados_novos JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Criar índices para performance
CREATE INDEX idx_audit_logs_clinica_id ON audit_logs(clinica_id);
CREATE INDEX idx_audit_logs_usuario_id ON audit_logs(usuario_id);
CREATE INDEX idx_audit_logs_tabela ON audit_logs(tabela);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- Habilitar RLS na tabela de auditoria
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Políticas para audit_logs
CREATE POLICY "audit_logs_select_own_clinic"
  ON audit_logs
  FOR SELECT
  USING (
    clinica_id = (auth.jwt() ->> 'clinic_id')::uuid 
    OR auth.jwt() ->> 'role' = 'admin'
  );

CREATE POLICY "audit_logs_insert_own_clinic"
  ON audit_logs
  FOR INSERT
  WITH CHECK (clinica_id = (auth.jwt() ->> 'clinic_id')::uuid);

CREATE POLICY "audit_logs_delete_admin_only"
  ON audit_logs
  FOR DELETE
  USING (auth.jwt() ->> 'role' = 'admin');

-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 4: VERIFICAR QUE RLS ESTÁ ATIVADO
-- ═══════════════════════════════════════════════════════════════════════════════

-- Execute esta query para confirmar que RLS está ativo em todas as tabelas:
SELECT
  schemaname,
  tablename,
  rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- Saída esperada: todas as tabelas devem ter rowsecurity = true

-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 5: VERIFICAR POLÍTICAS CRIADAS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Execute esta query para listar todas as políticas de RLS criadas:
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PRONTO! Tudo foi configurado com sucesso
-- ═══════════════════════════════════════════════════════════════════════════════

-- Próximos passos:
-- 1. ✅ Regenerar as chaves de API no Dashboard (Supabase → Settings → API)
-- 2. ✅ Adicionar nova chave ao .env.local
-- 3. ✅ Atualizar variáveis de ambiente no Vercel
-- 4. ✅ Testar o acesso (usuários devem ver apenas dados de sua clínica)
-- 5. ✅ Monitorar audit_logs para atividades suspeitas
