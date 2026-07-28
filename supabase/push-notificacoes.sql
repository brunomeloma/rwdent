-- ============================================================================
-- RWDent — Notificações push de verdade (chegam com o app fechado)
-- Rode INTEIRO, 1x, no SQL Editor do Supabase. Seguro e idempotente.
-- NÃO apaga nenhum dado.
-- ============================================================================
-- Cria duas tabelas:
--   push_subscriptions — 1 linha por APARELHO que ativou notificações (o
--                        "endereço" pra onde o push é enviado). Pertence a um
--                        usuário e a uma clínica.
--   push_enviados      — controle pra não mandar o mesmo lembrete duas vezes.
--
-- A RLS deixa cada usuário gerenciar só as assinaturas DELE. Quem envia o push
-- é o servidor (service role, que ignora RLS) — ver api/enviar-lembretes.js.
-- ============================================================================

create table if not exists public.push_subscriptions (
  id          bigint generated always as identity primary key,
  clinica_id  uuid not null,
  user_id     uuid not null,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_push_sub_clinica on public.push_subscriptions(clinica_id);
create index if not exists idx_push_sub_user    on public.push_subscriptions(user_id);

-- agendamento_id é bigint (mesmo tipo de agendamentos.id) — NÃO uuid. Uma
-- versão anterior deste arquivo criou como uuid por engano, o que fazia
-- TODA reserva falhar silenciosamente e nenhum lembrete jamais ser enviado
-- (corrigido em produção via migration corrige_tipo_push_enviados).
create table if not exists public.push_enviados (
  agendamento_id bigint not null,
  tipo           text not null default '15min',
  enviado_em     timestamptz not null default now(),
  primary key (agendamento_id, tipo)
);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.push_subscriptions enable row level security;
alter table public.push_enviados      enable row level security;

-- Cada usuário só enxerga/mexe nas próprias assinaturas. (O envio usa a service
-- role, que ignora RLS, então não precisa de policy de leitura pra "todo mundo".)
drop policy if exists push_sub_proprias on public.push_subscriptions;
create policy push_sub_proprias on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- push_enviados: ninguém no cliente precisa acessar — só o servidor (service
-- role). RLS ligada e SEM policy = bloqueado pra usuários comuns, liberado só
-- pra service role. (Deixa explícito com uma policy que nunca casa.)
drop policy if exists push_enviados_ninguem on public.push_enviados;
create policy push_enviados_ninguem on public.push_enviados
  for all to authenticated using (false) with check (false);

-- ── Conferência ─────────────────────────────────────────────────────────────
select 'push_subscriptions' as tabela, count(*) from public.push_subscriptions
union all
select 'push_enviados', count(*) from public.push_enviados;
