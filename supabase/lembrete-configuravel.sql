-- ============================================================================
-- RWDent — Antecedência do lembrete por notificação (15 / 30 / 60 min).
-- Rode 1x no SQL Editor do Supabase. Seguro e idempotente.
-- ============================================================================
-- Antes disso, o robô de lembretes (api/enviar-lembretes.js) avisava sempre
-- com 15 minutos de antecedência, fixo. Agora cada clínica escolhe em
-- Configurações → "Lembrete por notificação" (15, 30 min ou 1 hora), e essa
-- escolha fica guardada aqui.
-- ============================================================================

alter table public.clinicas
  add column if not exists lembrete_minutos integer not null default 15;

alter table public.clinicas
  drop constraint if exists clinicas_lembrete_minutos_check;

alter table public.clinicas
  add constraint clinicas_lembrete_minutos_check check (lembrete_minutos in (15, 30, 60));
