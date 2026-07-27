-- ============================================================================
-- RWDent — Agendador dos lembretes (roda o "carteiro" de minuto em minuto)
-- ============================================================================
-- Faz o próprio Supabase chamar o endpoint /api/enviar-lembretes a cada minuto,
-- usando as extensões pg_cron (agenda) e pg_net (chamada HTTP). É grátis e não
-- depende do plano da Vercel.
--
-- >>> ANTES DE RODAR, troque os DOIS valores abaixo: <<<
--   1. o domínio do seu site (se não for rwdent.vercel.app)
--   2. o SEGREDO — tem que ser IGUALZINHO ao valor que você põe na variável
--      LEMBRETES_SECRET lá na Vercel (Settings → Environment Variables).
--
-- Rode INTEIRO, 1x. Pra mudar o segredo depois, é só rodar de novo.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove um agendamento anterior com o mesmo nome (evita duplicar).
select cron.unschedule('rwdent-lembretes')
where exists (select 1 from cron.job where jobname = 'rwdent-lembretes');

-- Agenda: a cada minuto, chama o endpoint com o segredo na URL.
-- ⚠️ TROQUE 'rwdent.vercel.app' e 'TROQUE_ESTE_SEGREDO' abaixo.
select cron.schedule(
  'rwdent-lembretes',
  '* * * * *',
  $$
    select net.http_get(
      url := 'https://rwdent.vercel.app/api/enviar-lembretes?secret=TROQUE_ESTE_SEGREDO'
    );
  $$
);

-- ── Conferência ─────────────────────────────────────────────────────────────
-- Mostra o job agendado. Pra ver se está rodando, depois de 1-2 min rode:
--   select * from net._http_response order by created desc limit 5;
select jobid, jobname, schedule, active from cron.job where jobname = 'rwdent-lembretes';
