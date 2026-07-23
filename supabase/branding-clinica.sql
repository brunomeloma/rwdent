-- Personalização de marca por clínica: logo e cor primária aplicados no
-- próprio painel (reskin da paleta --rose-* inteira via JS) — recurso
-- padrão nos concorrentes premium (Curve Dental, Dentrix Ascend, Simples
-- Dental) pra dar cara de "sistema da clínica" e não de sistema genérico.
--
-- Colunas novas em clinicas: logo_url (link público da logo) e cor_marca
-- (hex escolhido pela clínica). Ambas opcionais — sem elas, o app usa o
-- ícone/paleta padrão do RWDent normalmente.
alter table public.clinicas add column if not exists logo_url text;
alter table public.clinicas add column if not exists cor_marca text;

-- Bucket "branding": diferente de "galeria" (fotos/radiografias, dado
-- sensível de saúde), a logo da clínica não é dado sensível — fica
-- pública pra carregar rápido no header/login sem precisar de URL
-- assinada. Upload/troca continua restrito à própria clínica dona.
insert into storage.buckets (id, name, public, allowed_mime_types)
values ('branding', 'branding', true, array['image/jpeg','image/png','image/webp','image/svg+xml'])
on conflict (id) do update set public = true, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "branding_select" on storage.objects;
create policy "branding_select" on storage.objects for select
  using (bucket_id = 'branding');

drop policy if exists "branding_insert" on storage.objects;
create policy "branding_insert" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] in (
      select id::text from public.clinicas where user_id = auth.uid()
    )
  );

drop policy if exists "branding_update" on storage.objects;
create policy "branding_update" on storage.objects for update to authenticated
  using (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] in (
      select id::text from public.clinicas where user_id = auth.uid()
    )
  );

drop policy if exists "branding_delete" on storage.objects;
create policy "branding_delete" on storage.objects for delete to authenticated
  using (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] in (
      select id::text from public.clinicas where user_id = auth.uid()
    )
  );
