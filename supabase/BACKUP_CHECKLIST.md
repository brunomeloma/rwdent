# Backup Supabase antes de hardening

Este arquivo nao altera o banco. E apenas um roteiro.

## Tabelas para conferir/exportar

- `clinicas`
- `pacientes`
- `profissionais`
- `agendamentos`
- `prontuarios`
- `anamneses`
- `financeiro_config`
- `plano_tratamento`
- `atendimentos_odonto`
- `procedimentos_dentes`

## Consultas de contagem para comparar antes/depois

```sql
select 'clinicas' as tabela, count(*) from clinicas
union all select 'pacientes', count(*) from pacientes
union all select 'profissionais', count(*) from profissionais
union all select 'agendamentos', count(*) from agendamentos
union all select 'anamneses', count(*) from anamneses
union all select 'financeiro_config', count(*) from financeiro_config
union all select 'plano_tratamento', count(*) from plano_tratamento
union all select 'atendimentos_odonto', count(*) from atendimentos_odonto
union all select 'procedimentos_dentes', count(*) from procedimentos_dentes;
```

Depois de aplicar qualquer hardening, rode a mesma consulta. As contagens nao devem cair.
