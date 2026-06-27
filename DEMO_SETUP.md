# Configuração da Conta Demo — RWDent

## 1. Criar usuário demo no Supabase

No **Supabase Dashboard** → **Authentication** → **Users** → **Add User**:

- **Email:** `demo@rwdent.app`
- **Password:** `demo2024rwdent`
- **Auto Confirm:** ✅ marcado

## 2. Criar clínica demo no SQL Editor

Após criar o usuário, copie o `user_id` dele e execute:

```sql
-- Substitua 'USER_ID_DO_DEMO' pelo ID real do usuário demo
INSERT INTO clinicas (user_id, nome_resp, nome_cli, email, telefone, status)
VALUES (
  'USER_ID_DO_DEMO',
  'Dr. Exemplo',
  'Clínica Odontológica Exemplo',
  'demo@rwdent.app',
  '(11) 99999-0000',
  'aprovado'
);
```

## 3. Copiar procedimentos da sua clínica para a demo

```sql
-- Copia todos os procedimentos da sua clínica para a demo
-- Substitua SEU_CLINICA_ID e DEMO_CLINICA_ID pelos IDs reais
INSERT INTO financeiro_config (clinica_id, procs, mats, estoque, proc_insumos, combos, vendas, taxas)
SELECT 
  'DEMO_CLINICA_ID',
  procs, mats, estoque, proc_insumos, combos, 
  '[]'::jsonb,  -- vendas zeradas na demo
  taxas
FROM financeiro_config
WHERE clinica_id = 'SEU_CLINICA_ID';
```

## 4. Adicionar dados fictícios (opcional)

```sql
-- Profissional fictício
INSERT INTO profissionais (clinica_id, nome, especialidade, cro, cor, principal)
VALUES ('DEMO_CLINICA_ID', 'Dr. Exemplo', 'Clínico Geral', 'CRO-00000', '#d4735a', true);

-- Pacientes fictícios
INSERT INTO pacientes (clinica_id, nome, telefone, data_nascimento)
VALUES 
  ('DEMO_CLINICA_ID', 'Maria Silva', '(11) 98888-0000', '1985-03-15'),
  ('DEMO_CLINICA_ID', 'João Santos', '(11) 97777-0000', '1990-07-22'),
  ('DEMO_CLINICA_ID', 'Ana Oliveira', '(11) 96666-0000', '1978-11-08');
```

## Como funciona

- Na landing page (`/landing`), o botão **"Ver demonstração ao vivo"** redireciona para `/?demo=true`
- O login é feito automaticamente com as credenciais da conta demo
- Um banner amarelo aparece no topo do app indicando "Modo demonstração"
- Os dados são isolados pela RLS — a conta demo só vê os dados da clínica demo
- O nome "Clínica Odontológica Exemplo" aparece no header (ninguém sabe que é sua)
- Os preços dos procedimentos são reais (copiados da sua clínica)
