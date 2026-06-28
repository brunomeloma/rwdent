# Checklist para nao perder dados

Use este checklist antes de qualquer mudanca grande no RWDent.

## Antes de mexer no Supabase

- Exportar backup das tabelas principais.
- Exportar dados de storage/fotos, se usado.
- Confirmar qual projeto Supabase esta ligado ao site em producao.
- Confirmar que a mudanca nao possui `drop table`, `truncate`, `delete` sem `where`, ou alteracoes destrutivas.
- Executar primeiro em uma copia quando possivel.

## Antes de mexer no codigo

- Trabalhar em branch separada.
- Nao alterar logica de estoque/financeiro junto com mudancas visuais.
- Preservar compatibilidade de campos existentes.
- Manter links antigos funcionando durante transicoes, principalmente anamnese publica.

## Fluxos que precisam ser testados depois de qualquer deploy

- Login normal da clinica.
- Cadastro de paciente.
- Edicao de paciente existente.
- Cadastro e baixa de estoque.
- Venda rapida.
- Financeiro e precificacao.
- Agendamento.
- Anamnese publica.
- Painel admin.

## Regra de parada

Se qualquer teste mostrar dados faltando, nao continue mexendo. Reverta o deploy de codigo e analise as policies/migracoes antes de tentar de novo.
