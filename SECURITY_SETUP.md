# RWDent — Guia de seguranca do Supabase

Este guia existe para melhorar a seguranca sem apagar dados existentes. Nada aqui deve ser executado sem revisao no Supabase Dashboard.

## Regra de ouro

O codigo do front-end nunca deve ser a unica protecao de dados. Qualquer pessoa consegue ler JavaScript publicado no navegador. A protecao real precisa estar nas policies de RLS do Supabase.

## Antes de mexer no banco

1. Faca backup do Supabase: tabelas principais e storage.
2. Confirme que voce sabe qual usuario e administrador.
3. Teste em uma copia do projeto ou em uma janela anonima antes de aplicar em producao.
4. Nao execute comandos que contenham `drop table`, `truncate`, `delete` sem `where`, ou migracoes destrutivas.

## Pontos de atencao encontrados

### 1. Anamnese publica

O arquivo `anamnese.html` usa links publicos com `paciente` e `clinica` na URL. Isso e pratico, mas precisa de token imprevisivel e policy restrita. Evite policies anonimas com `USING (true)` em tabelas com dados de pacientes.

Risco se estiver aberto: qualquer pessoa com a anon key pode tentar consultar nomes, pacientes, clinicas e anamneses.

Melhor caminho: criar uma tabela de links de anamnese com token aleatorio, data de expiracao e status de uso. O paciente acessa pelo token, nao por IDs sequenciais.

### 2. Admin no front-end

`admin.html` possui uma lista `ADMIN_EMAILS`. Isso ajuda na interface, mas nao deve ser considerado seguranca. O banco precisa validar admin por tabela/perfil ou claim.

Melhor caminho: criar tabela `admin_users` e policies que validam `auth.uid()`.

### 3. Separacao por clinica

Todas as tabelas com dados da clinica devem filtrar por `clinica_id` pertencente ao usuario logado. Isso vale para pacientes, agendamentos, profissionais, financeiro, estoque, anamneses e fotos.

## Ordem segura recomendada

1. Criar tabelas auxiliares de seguranca, se ainda nao existirem.
2. Criar policies novas com nomes especificos.
3. Testar login normal, admin e link publico de anamnese.
4. So depois remover policies antigas amplas, caso existam.

## Arquivo SQL

Veja `supabase/security-hardening.sql`. Ele e um ponto de partida conservador. Revise os nomes das tabelas e campos antes de executar.
