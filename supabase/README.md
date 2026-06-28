# Supabase

Arquivos nesta pasta sao roteiros de banco para revisao e execucao manual ou via ferramenta segura de deploy.

## Importante

Nao coloque service role key, senha de banco ou tokens privados neste repositorio.

## Arquivos

- `security-hardening.sql`: cria funcoes/tabelas auxiliares e policies conservadoras para reforcar RLS.
- `BACKUP_CHECKLIST.md`: lista de conferencias antes/depois de qualquer mudanca no banco.

## Como aplicar com seguranca

1. Fazer backup.
2. Conferir contagens das tabelas principais.
3. Executar apenas scripts revisados.
4. Testar login, pacientes, estoque, financeiro, anamnese e admin.
5. Conferir contagens novamente.
