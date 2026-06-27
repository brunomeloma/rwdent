-- ============================================================
-- RWDent — Criação da Conta Demo (COLE TUDO NO SQL EDITOR)
-- Execute no Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- ⚠️ ANTES: Crie o usuário no Authentication → Users → Add User:
--   Email: demo@rwdent.app
--   Password: demo2024rwdent
--   Auto Confirm: ✅
-- Depois copie o user_id e cole abaixo:

-- ══════════════════════════════════════════════════════
-- 1. TROCAR PELO USER_ID DO DEMO (copie do Authentication)
-- ══════════════════════════════════════════════════════
DO $$
DECLARE
  v_user_id UUID;
  v_clinica_id BIGINT;
  v_prof_id BIGINT;
  v_pac1_id BIGINT;
  v_pac2_id BIGINT;
  v_pac3_id BIGINT;
  v_pac4_id BIGINT;
  v_pac5_id BIGINT;
BEGIN

-- ┌──────────────────────────────────────────────────┐
-- │  COLE SEU USER_ID AQUI (do Authentication)       │
-- └──────────────────────────────────────────────────┘
v_user_id := 'COLE_O_USER_ID_AQUI';

-- ══════════════════════════════════════════════════════
-- 2. CRIAR CLÍNICA DEMO
-- ══════════════════════════════════════════════════════
INSERT INTO clinicas (user_id, nome_resp, nome_cli, email, telefone, status, endereco)
VALUES (
  v_user_id,
  'Dr. Exemplo',
  'Clínica Odontológica Exemplo',
  'demo@rwdent.app',
  '(99) 99999-0000',
  'aprovado',
  'Av. Exemplo, 1000 — Centro'
)
RETURNING id INTO v_clinica_id;

-- ══════════════════════════════════════════════════════
-- 3. CRIAR PROFISSIONAIS
-- ══════════════════════════════════════════════════════
INSERT INTO profissionais (clinica_id, nome, especialidade, cro, cor, principal)
VALUES (v_clinica_id, 'Dr. Exemplo', 'Clínico Geral', 'CRO-00000', '#d4735a', true)
RETURNING id INTO v_prof_id;

INSERT INTO profissionais (clinica_id, nome, especialidade, cro, cor, principal)
VALUES (v_clinica_id, 'Dra. Maria', 'Ortodontista', 'CRO-00001', '#1565c0', false);

INSERT INTO profissionais (clinica_id, nome, especialidade, cro, cor, principal)
VALUES (v_clinica_id, 'Dr. Carlos', 'Endodontista', 'CRO-00002', '#2e7d32', false);

-- ══════════════════════════════════════════════════════
-- 4. CRIAR PACIENTES FICTÍCIOS
-- ══════════════════════════════════════════════════════
INSERT INTO pacientes (clinica_id, nome, telefone, data_nascimento, email)
VALUES (v_clinica_id, 'Maria Silva', '(99) 98888-0001', '1985-03-15', 'maria@exemplo.com')
RETURNING id INTO v_pac1_id;

INSERT INTO pacientes (clinica_id, nome, telefone, data_nascimento, email)
VALUES (v_clinica_id, 'João Santos', '(99) 98888-0002', '1990-07-22', 'joao@exemplo.com')
RETURNING id INTO v_pac2_id;

INSERT INTO pacientes (clinica_id, nome, telefone, data_nascimento, email)
VALUES (v_clinica_id, 'Ana Oliveira', '(99) 98888-0003', '1978-11-08', 'ana@exemplo.com')
RETURNING id INTO v_pac3_id;

INSERT INTO pacientes (clinica_id, nome, telefone, data_nascimento, email)
VALUES (v_clinica_id, 'Carlos Pereira', '(99) 98888-0004', '1995-01-30', 'carlos@exemplo.com')
RETURNING id INTO v_pac4_id;

INSERT INTO pacientes (clinica_id, nome, telefone, data_nascimento, email)
VALUES (v_clinica_id, 'Fernanda Lima', '(99) 98888-0005', '1982-09-12', 'fernanda@exemplo.com')
RETURNING id INTO v_pac5_id;

-- ══════════════════════════════════════════════════════
-- 5. CRIAR AGENDAMENTOS DE EXEMPLO (hoje e próximos dias)
-- ══════════════════════════════════════════════════════
INSERT INTO agendamentos (clinica_id, paciente_id, profissional_id, data, horario, procedimento, status) VALUES
  (v_clinica_id, v_pac1_id, v_prof_id, CURRENT_DATE, '09:00', 'Consulta Inicial + Profilaxia', 'confirmada'),
  (v_clinica_id, v_pac2_id, v_prof_id, CURRENT_DATE, '10:30', 'Restauração Resina Composta', 'confirmada'),
  (v_clinica_id, v_pac3_id, v_prof_id, CURRENT_DATE, '14:00', 'Clareamento de Consultório', 'pendente'),
  (v_clinica_id, v_pac4_id, v_prof_id, CURRENT_DATE, '15:30', 'Exodontia Simples', 'confirmada'),
  (v_clinica_id, v_pac5_id, v_prof_id, CURRENT_DATE + 1, '09:00', 'Limpeza + Polimento', 'pendente'),
  (v_clinica_id, v_pac1_id, v_prof_id, CURRENT_DATE + 1, '11:00', 'Aplicação de Flúor', 'confirmada'),
  (v_clinica_id, v_pac2_id, v_prof_id, CURRENT_DATE + 2, '08:30', 'Endodontia - 1 canal', 'pendente'),
  (v_clinica_id, v_pac3_id, v_prof_id, CURRENT_DATE + 2, '14:00', 'Raspagem Supragengival', 'confirmada'),
  (v_clinica_id, v_pac4_id, v_prof_id, CURRENT_DATE + 3, '10:00', 'Consulta Odontológica', 'pendente');

-- ══════════════════════════════════════════════════════
-- 6. CRIAR FINANCEIRO COM PROCEDIMENTOS E MATERIAIS
--    (usa os mesmos preços padrão do sistema)
-- ══════════════════════════════════════════════════════
INSERT INTO financeiro_config (clinica_id, procs, mats, estoque, proc_insumos, vendas, combos)
VALUES (
  v_clinica_id,
  '[{"id":1,"nome":"Consulta Inicial + Profilaxia","grupo":"Preventivo","tempo":60,"insumos":10.43,"horaClin":70.85,"laboratorio":0,"margem":100,"precoFinal":175.57},{"id":2,"nome":"Profilaxia simples","grupo":"Preventivo","tempo":45,"insumos":10.06,"horaClin":53.14,"laboratorio":0,"margem":100,"precoFinal":136.50},{"id":3,"nome":"Aplicação de Flúor","grupo":"Preventivo","tempo":20,"insumos":1.94,"horaClin":23.62,"laboratorio":0,"margem":100,"precoFinal":55.21},{"id":5,"nome":"Restauração Resina Composta Posterior","grupo":"Dentística","tempo":75,"insumos":21.29,"horaClin":88.56,"laboratorio":0,"margem":100,"precoFinal":237.29},{"id":6,"nome":"Restauração Resina Composta Anterior","grupo":"Dentística","tempo":90,"insumos":24.26,"horaClin":106.28,"laboratorio":0,"margem":100,"precoFinal":281.95},{"id":9,"nome":"Clareamento Caseiro","grupo":"Dentística","tempo":60,"insumos":10.44,"horaClin":70.85,"laboratorio":0,"margem":100,"precoFinal":175.60},{"id":10,"nome":"Clareamento de Consultório","grupo":"Dentística","tempo":90,"insumos":35.44,"horaClin":106.28,"laboratorio":0,"margem":100,"precoFinal":306.10},{"id":16,"nome":"Exodontia Simples","grupo":"Cirurgia","tempo":30,"insumos":10.55,"horaClin":35.43,"laboratorio":0,"margem":100,"precoFinal":99.31},{"id":17,"nome":"Exodontia Complexa","grupo":"Cirurgia","tempo":60,"insumos":20.22,"horaClin":70.85,"laboratorio":0,"margem":100,"precoFinal":196.72},{"id":18,"nome":"Exodontia de Siso","grupo":"Cirurgia","tempo":90,"insumos":51.26,"horaClin":106.28,"laboratorio":0,"margem":100,"precoFinal":340.28},{"id":22,"nome":"Endodontia - Necro (1 canal)","grupo":"Endodontia","tempo":180,"insumos":72.20,"horaClin":212.55,"laboratorio":0,"margem":100,"precoFinal":615.07},{"id":25,"nome":"Endodontia - 3 canais","grupo":"Endodontia","tempo":300,"insumos":190.02,"horaClin":354.26,"laboratorio":0,"margem":100,"precoFinal":1175.65},{"id":27,"nome":"Raspagem Supragengival","grupo":"Periodontia","tempo":60,"insumos":2.54,"horaClin":70.85,"laboratorio":0,"margem":100,"precoFinal":158.52},{"id":29,"nome":"Gengivoplastia","grupo":"Periodontia","tempo":75,"insumos":37.75,"horaClin":88.56,"laboratorio":0,"margem":100,"precoFinal":272.84},{"id":35,"nome":"Implante Cirúrgico","grupo":"Implantodontia","tempo":120,"insumos":70.70,"horaClin":141.70,"laboratorio":0,"margem":100,"precoFinal":458.79},{"id":74,"nome":"Prótese Fixa Unitária (Coroa)","grupo":"Prótese","tempo":120,"insumos":30.00,"horaClin":141.70,"laboratorio":500,"margem":100,"precoFinal":850.00},{"id":76,"nome":"Faceta Cerâmica","grupo":"Prótese","tempo":90,"insumos":20.00,"horaClin":106.28,"laboratorio":400,"margem":100,"precoFinal":750.00},{"id":52,"nome":"Consulta Odontológica","grupo":"Diagnóstico","tempo":30,"insumos":2.00,"horaClin":35.43,"laboratorio":0,"margem":100,"precoFinal":80.00},{"id":43,"nome":"Instalação Aparelho Metálico Tradicional","grupo":"Ortodontia","tempo":120,"insumos":251.72,"horaClin":141.70,"laboratorio":400,"margem":100,"precoFinal":849.79},{"id":38,"nome":"Manutenção Mensal Ortodôntica","grupo":"Ortodontia","tempo":30,"insumos":2.06,"horaClin":35.43,"laboratorio":0,"margem":100,"precoFinal":80.98}]'::jsonb,
  '[{"id":1,"nome":"Ácido Fosfórico","cat":"Dentística","unid":"ml","qtde":30,"preco":218.15,"custo":7.27},{"id":5,"nome":"Agulha Curta","cat":"Geral","unid":"unid","qtde":100,"preco":48.40,"custo":0.48},{"id":8,"nome":"Babador","cat":"Geral","unid":"unid","qtde":100,"preco":24.90,"custo":0.25},{"id":13,"nome":"Cimento Ionômero de Vidro","cat":"Dentística","unid":"porção","qtde":30,"preco":77.59,"custo":2.59},{"id":33,"nome":"Lidocaína 2% c/ Epinefrina","cat":"Anestesia","unid":"unid","qtde":50,"preco":129.88,"custo":2.60},{"id":34,"nome":"Luva Nitrílica","cat":"Geral","unid":"unid","qtde":100,"preco":43.99,"custo":0.44},{"id":35,"nome":"Máscara","cat":"Geral","unid":"unid","qtde":50,"preco":18.42,"custo":0.37},{"id":30,"nome":"Gaze Estéril","cat":"Geral","unid":"unid","qtde":500,"preco":20.36,"custo":0.04},{"id":40,"nome":"Sistema Adesivo","cat":"Dentística","unid":"unid","qtde":16,"preco":505.27,"custo":31.58},{"id":51,"nome":"Resina Composta A2","cat":"Dentística","unid":"grama","qtde":4,"preco":85.00,"custo":21.25},{"id":25,"nome":"Escova Robinson","cat":"Profilaxia","unid":"unid","qtde":1,"preco":7.75,"custo":7.75},{"id":67,"nome":"Pasta Profilática","cat":"Profilaxia","unid":"pote","qtde":1,"preco":18.00,"custo":18.00}]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb
);

RAISE NOTICE '✅ Conta demo criada com sucesso!';
RAISE NOTICE '   Clínica ID: %', v_clinica_id;
RAISE NOTICE '   Login: demo@rwdent.app / demo2024rwdent';
RAISE NOTICE '   5 pacientes, 3 profissionais, 9 agendamentos, 20 procedimentos, 12 materiais';

END $$;
