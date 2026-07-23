-- Lista de espera: quando um horário vaga (agendamento cancelado), o
-- sistema oferece a vaga pra quem está nessa lista, via WhatsApp.
-- Tabela nova, isolada por clínica com o mesmo padrão de RLS de todo o
-- resto do sistema (só a própria clínica dona enxerga seus registros).

create table if not exists public.lista_espera (
  id bigint generated always as identity primary key,
  clinica_id uuid not null references public.clinicas(id) on delete cascade,
  paciente_id bigint references public.pacientes(id) on delete set null,
  nome text not null,
  telefone text,
  procedimento text,
  profissional_id bigint,
  obs text,
  created_at timestamptz not null default now()
);

alter table public.lista_espera enable row level security;

drop policy if exists "lista_espera_isolamento" on public.lista_espera;
create policy "lista_espera_isolamento" on public.lista_espera
  for all
  using (clinica_id in (select id from public.clinicas where user_id = auth.uid()))
  with check (clinica_id in (select id from public.clinicas where user_id = auth.uid()));
