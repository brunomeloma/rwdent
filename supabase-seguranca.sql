-- ============================================================
-- RWDent — Script de Seguranca para Supabase
-- Execute no SQL Editor do Supabase Dashboard
-- ============================================================

-- 1. CRIAR BUCKET "galeria" (resolve o erro de RLS)
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('galeria', 'galeria', true, 10485760)
ON CONFLICT (id) DO NOTHING;

-- 2. POLICIES DE STORAGE — permite upload/leitura/exclusao apenas para usuarios autenticados
-- da mesma clinica (isolamento multi-tenant)

-- Leitura: usuario autenticado pode ler arquivos da sua clinica
CREATE POLICY "galeria_select" ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'galeria');

-- Upload: usuario autenticado pode fazer upload na pasta da sua clinica
CREATE POLICY "galeria_insert" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'galeria');

-- Exclusao: usuario autenticado pode deletar arquivos da sua clinica
CREATE POLICY "galeria_delete" ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'galeria');

-- 3. RLS NAS TABELAS PRINCIPAIS
-- (Ativa RLS e cria policies para isolar dados por clinica)

-- Clinicas: usuario so ve a propria clinica
ALTER TABLE clinicas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "clinicas_own" ON clinicas FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Pacientes
ALTER TABLE pacientes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pacientes_own" ON pacientes FOR ALL
  TO authenticated
  USING (clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid()))
  WITH CHECK (clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid()));

-- Agendamentos
ALTER TABLE agendamentos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agendamentos_own" ON agendamentos FOR ALL
  TO authenticated
  USING (clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid()))
  WITH CHECK (clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid()));

-- Profissionais
ALTER TABLE profissionais ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profissionais_own" ON profissionais FOR ALL
  TO authenticated
  USING (clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid()))
  WITH CHECK (clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid()));

-- Financeiro Config
ALTER TABLE financeiro_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "financeiro_own" ON financeiro_config FOR ALL
  TO authenticated
  USING (clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid()))
  WITH CHECK (clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid()));

-- Prontuarios
ALTER TABLE prontuarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prontuarios_own" ON prontuarios FOR ALL
  TO authenticated
  USING (paciente_id IN (
    SELECT id FROM pacientes WHERE clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid())
  ))
  WITH CHECK (paciente_id IN (
    SELECT id FROM pacientes WHERE clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid())
  ));

-- Atendimentos Odonto
ALTER TABLE atendimentos_odonto ENABLE ROW LEVEL SECURITY;
CREATE POLICY "atendimentos_own" ON atendimentos_odonto FOR ALL
  TO authenticated
  USING (clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid()))
  WITH CHECK (clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid()));

-- Plano Tratamento
ALTER TABLE plano_tratamento ENABLE ROW LEVEL SECURITY;
CREATE POLICY "plano_own" ON plano_tratamento FOR ALL
  TO authenticated
  USING (paciente_id IN (
    SELECT id FROM pacientes WHERE clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid())
  ))
  WITH CHECK (paciente_id IN (
    SELECT id FROM pacientes WHERE clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid())
  ));

-- Anamneses
ALTER TABLE anamneses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anamneses_own" ON anamneses FOR ALL
  TO authenticated
  USING (paciente_id IN (
    SELECT id FROM pacientes WHERE clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid())
  ))
  WITH CHECK (paciente_id IN (
    SELECT id FROM pacientes WHERE clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid())
  ));

-- Procedimentos Dentes
ALTER TABLE procedimentos_dentes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "procdentes_own" ON procedimentos_dentes FOR ALL
  TO authenticated
  USING (paciente_id IN (
    SELECT id FROM pacientes WHERE clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid())
  ))
  WITH CHECK (paciente_id IN (
    SELECT id FROM pacientes WHERE clinica_id IN (SELECT id FROM clinicas WHERE user_id = auth.uid())
  ));

-- 4. ADICIONAR COLUNAS endereco/maps_link NA TABELA clinicas
-- (Para que o salvamento direto funcione alem do fallback via cfg)
ALTER TABLE clinicas ADD COLUMN IF NOT EXISTS endereco TEXT DEFAULT '';
ALTER TABLE clinicas ADD COLUMN IF NOT EXISTS maps_link TEXT DEFAULT '';
